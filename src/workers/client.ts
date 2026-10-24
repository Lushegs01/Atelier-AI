import "server-only";
import { randomUUID } from "node:crypto";
import { Inngest, eventType } from "inngest";
import { z } from "zod";

export const inngest = new Inngest({
  id: "atelier-ai",
  eventKey: process.env.INNGEST_EVENT_KEY,
  ...(process.env.INNGEST_DEV === "1" && process.env.NODE_ENV !== "production"
    ? { isDev: true }
    : {}),
});
export const generationRequested = eventType("atelier/generation.requested", {
  schema: z.object({ jobId: z.string().uuid(), organizationId: z.string().uuid() }),
});
export const generationRecoveryRequested = eventType("atelier/generation.recovery", {
  schema: z.object({ jobId: z.string().uuid(), organizationId: z.string().uuid() }),
});

export async function dispatchGeneration(jobId: string, organizationId: string): Promise<void> {
  if (!process.env.INNGEST_EVENT_KEY && process.env.INNGEST_DEV !== "1")
    throw new Error(
      "The durable queue is not configured. The committed job remains in the outbox.",
    );
  await inngest.send({
    id: `generation:${jobId}`,
    name: generationRequested.name,
    data: { jobId, organizationId },
  });
}

/** Privileged caller must verify an existing prediction; recovery never submits another POST. */
export async function dispatchGenerationRecovery(
  jobId: string,
  organizationId: string,
): Promise<void> {
  if (!process.env.INNGEST_EVENT_KEY && process.env.INNGEST_DEV !== "1")
    throw new Error("The durable queue is not configured.");
  await inngest.send({
    id: `recovery:${jobId}:${randomUUID()}`,
    name: generationRecoveryRequested.name,
    data: { jobId, organizationId },
  });
}
