import "server-only";
import { captureMessage } from "@sentry/nextjs";
import { NonRetriableError, RetryAfterError } from "inngest";
import { getAdminClient } from "@/lib/supabase/admin";
import { FashnProvider, assertCapabilityEnabled } from "@/server/ai/fashn";
import {
  GenerationOperation,
  ProviderError,
  imageOptionsSchema,
  tryOnOptionsSchema,
  videoOptionsSchema,
} from "@/server/ai/contracts";
import {
  deletePrivateAsset,
  deterministicOutputId,
  downloadAssetForProvider,
  transferProviderOutput,
} from "@/server/storage/media";
import { inngest, generationRequested, generationRecoveryRequested } from "./client";
import { retryDelaySeconds, submissionDecision } from "./policy";

interface Job {
  id: string;
  organization_id: string;
  status: string;
  operation: GenerationOperation;
  garment_id: string | null;
  source_asset_id: string | null;
  input_asset_ids: string[];
  options: Record<string, unknown>;
  provider_reference: string | null;
  retry_count: number;
  created_by: string | null;
  error_code: string | null;
  lease_until: string | null;
}

async function loadJob(id: string, organizationId?: string): Promise<Job> {
  let query = getAdminClient().from("generation_jobs").select("*").eq("id", id);
  if (organizationId) query = query.eq("organization_id", organizationId);
  const { data, error } = await query.single();
  if (error || !data) throw new NonRetriableError("Generation job not found.");
  return data as Job;
}

async function updateJob(id: string, values: Record<string, unknown>): Promise<void> {
  const { error } = await getAdminClient()
    .from("generation_jobs")
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq("id", id)
    .not("status", "in", "(succeeded,failed,cancelled)");
  if (error) throw new Error("Generation state could not be persisted.");
}

async function finishJob(id: string, success: boolean, code?: string): Promise<string> {
  const { data, error } = await getAdminClient().rpc("finalize_generation", {
    p_job_id: id,
    p_success: success,
    p_error_code: code ?? null,
    p_error_message: code
      ? "Generation could not complete. Your reserved credits have been released."
      : null,
  });
  if (error) throw new Error("Generation accounting could not be reconciled.");
  return String(data.status);
}

async function checkTryOnConsent(job: Job): Promise<void> {
  if (job.operation !== "try_on") return;
  const sessionId = job.options.tryOnSessionId;
  if (typeof sessionId !== "string") throw new NonRetriableError("Try-on consent session missing.");
  const admin = getAdminClient();
  const { data: session } = await admin
    .from("try_on_sessions")
    .select("id,revoked_at,deleted_at,expires_at,customer_asset_id,job_id")
    .eq("id", sessionId)
    .eq("organization_id", job.organization_id)
    .single();
  if (
    !session ||
    session.revoked_at ||
    session.deleted_at ||
    new Date(session.expires_at).getTime() <= Date.now() ||
    session.job_id !== job.id ||
    session.customer_asset_id !== job.source_asset_id
  )
    throw new NonRetriableError("Try-on permission was revoked.");
  const { data: consent } = await admin
    .from("consents")
    .select("id")
    .eq("try_on_session_id", sessionId)
    .eq("organization_id", job.organization_id)
    .is("withdrawn_at", null)
    .limit(1)
    .maybeSingle();
  if (!consent) throw new NonRetriableError("Try-on consent was withdrawn.");
}

async function resolveGarmentSource(job: Job): Promise<string> {
  if (!job.garment_id) throw new NonRetriableError("A garment is required.");
  let query = getAdminClient()
    .from("assets")
    .select("id,view")
    .eq("organization_id", job.organization_id)
    .eq("garment_id", job.garment_id)
    .in("kind", ["original", "garment_original"])
    .is("deleted_at", null)
    .in("view", ["front", "mannequin", "hanger", "flat-lay"]);
  if (job.operation === "photo" && job.source_asset_id) query = query.eq("id", job.source_asset_id);
  const { data: asset } = await query.order("created_at").limit(1).maybeSingle();
  if (!asset)
    throw new NonRetriableError(
      "Upload a compatible front, mannequin, hanger or flat-lay garment photograph.",
    );
  return downloadAssetForProvider({ organizationId: job.organization_id, assetId: asset.id });
}

export async function submitGenerationOnce(
  jobId: string,
  organizationId: string,
): Promise<{ id: string | null; terminal?: boolean; waiting?: boolean }> {
  const job = await loadJob(jobId, organizationId);
  const decision = submissionDecision(job);
  if (decision === "terminal") return { id: job.provider_reference, terminal: true };
  if (decision === "resume") return { id: job.provider_reference };
  if (decision === "reconcile") {
    await updateJob(job.id, {
      status: "retry_wait",
      error_code: "submission_ambiguous",
      error_message:
        "The provider submission needs operator reconciliation. A second paid request has not been submitted.",
      lease_until: null,
    });
    throw new NonRetriableError("Provider submission requires reconciliation.");
  }
  if (decision === "wait") return { id: null, waiting: true };
  assertCapabilityEnabled(job.operation);
  await checkTryOnConsent(job);
  const admin = getAdminClient();
  // A persistent rolling circuit breaker avoids a provider outage draining queued work.
  const { count, error: circuitError } = await admin
    .from("generation_jobs")
    .select("id", { count: "exact", head: true })
    .like("error_code", "provider_http_5%")
    .gte("updated_at", new Date(Date.now() - 120_000).toISOString());
  if (circuitError) throw new Error("Provider health could not be checked.");
  if ((count ?? 0) >= 5) throw new RetryAfterError("Provider circuit is cooling down.", "2m");
  const { data: claimed, error: claimError } = await admin.rpc("claim_generation", {
    p_job_id: job.id,
    p_lease_seconds: 90,
  });
  if (claimError) throw new Error("The generation could not be claimed.");
  if (!claimed || !Array.isArray(claimed) || !claimed.length) return { id: null, waiting: true };
  try {
    const provider = new FashnProvider();
    if (job.operation === "photo") {
      const source = await resolveGarmentSource(job);
      return await provider.generateFashionImage(source, imageOptionsSchema.parse(job.options));
    }
    if (job.operation === "video") {
      if (!job.source_asset_id) throw new NonRetriableError("Select an image to animate.");
      const source = await downloadAssetForProvider({
        organizationId: job.organization_id,
        assetId: job.source_asset_id,
        minDimension: 301,
      });
      return await provider.generateFashionVideo(source, videoOptionsSchema.parse(job.options));
    }
    if (!job.source_asset_id)
      throw new NonRetriableError("A consented customer photograph is required.");
    const product = await resolveGarmentSource(job);
    const person = await downloadAssetForProvider({
      organizationId: job.organization_id,
      assetId: job.source_asset_id,
    });
    return await provider.generateVirtualTryOn(
      product,
      person,
      tryOnOptionsSchema.parse(job.options),
    );
  } catch (error) {
    if (error instanceof ProviderError && error.ambiguous) {
      await updateJob(job.id, {
        status: "retry_wait",
        error_code: "submission_ambiguous",
        error_message: error.message,
        lease_until: null,
      });
      throw new NonRetriableError(error.message);
    }
    if (error instanceof ProviderError && error.retryable && job.retry_count < 3) {
      await updateJob(job.id, {
        status: "retry_wait",
        error_code: error.code,
        retry_count: job.retry_count + 1,
        lease_until: null,
      });
      throw new RetryAfterError(
        "Provider temporarily rejected the request.",
        `${retryDelaySeconds(job.retry_count)}s`,
      );
    }
    await finishJob(
      job.id,
      false,
      error instanceof ProviderError ? error.code : "invalid_generation_input",
    );
    throw new NonRetriableError("Generation submission failed; reserved credits were released.");
  }
}

export async function pollGenerationAndTransfer(
  jobId: string,
  reference: string,
): Promise<{ state: string }> {
  const job = await loadJob(jobId);
  if (["succeeded", "failed", "cancelled"].includes(job.status)) return { state: job.status };
  await checkTryOnConsent(job);
  const prediction = await new FashnProvider().getGenerationStatus(reference);
  if (prediction.creditsUsed !== undefined)
    await updateJob(job.id, { provider_credits_milli: prediction.creditsUsed * 1000 });
  if (prediction.status === "failed") {
    const state = await finishJob(job.id, false, prediction.errorCode ?? "provider_failed");
    return { state };
  }
  if (prediction.status !== "completed") {
    if (job.status === "retry_wait")
      await updateJob(job.id, { status: "processing", error_code: null, error_message: null });
    return { state: "processing" };
  }
  if (prediction.outputs.length !== 1) throw new Error("Unexpected provider output count.");
  for (const [index, url] of prediction.outputs.entries()) {
    const asset = await transferProviderOutput({
      organizationId: job.organization_id,
      jobId: job.id,
      index,
      url,
      isVideo: job.operation === "video",
      garmentId: job.garment_id ?? undefined,
      actorId: job.created_by,
      expiresAt:
        job.operation === "try_on"
          ? new Date(
              Date.now() + (Number(process.env.CUSTOMER_PHOTO_RETENTION_HOURS) || 24) * 3_600_000,
            ).toISOString()
          : undefined,
    });
    const { error } = await getAdminClient()
      .from("generation_outputs")
      .upsert(
        {
          id: deterministicOutputId(job.id, index, "output"),
          organization_id: job.organization_id,
          job_id: job.id,
          asset_id: asset.id,
          output_index: index,
        },
        { onConflict: "job_id,output_index", ignoreDuplicates: true },
      );
    if (error) throw new Error("Generation output could not be recorded.");
    if (job.operation === "try_on") {
      try {
        await checkTryOnConsent(job);
      } catch {
        await deletePrivateAsset({ organizationId: job.organization_id, assetId: asset.id });
        const state = await finishJob(job.id, false, "consent_withdrawn");
        return { state };
      }
      const { error: expiryError } = await getAdminClient()
        .from("assets")
        .update({
          expires_at: new Date(
            Date.now() + (Number(process.env.CUSTOMER_PHOTO_RETENTION_HOURS) || 24) * 3_600_000,
          ).toISOString(),
        })
        .eq("id", asset.id)
        .eq("organization_id", job.organization_id);
      if (expiryError) throw new Error("Try-on retention could not be applied.");
    }
  }
  const state = await finishJob(job.id, true);
  return { state };
}

export async function recordAcceptedPrediction(jobId: string, reference: string): Promise<void> {
  await updateJob(jobId, {
    provider_reference: reference,
    status: "processing",
    error_code: null,
    error_message: null,
    lease_until: null,
  });
}

export async function reconcileExhaustedGeneration(
  jobId: string,
): Promise<"terminal" | "manual" | "failed"> {
  const job = await loadJob(jobId);
  if (["succeeded", "failed", "cancelled"].includes(job.status)) return "terminal";
  if (
    !job.provider_reference &&
    (job.status === "submitting" || job.error_code === "submission_ambiguous")
  ) {
    await updateJob(job.id, {
      status: "retry_wait",
      error_code: "submission_ambiguous",
      error_message: "Operator reconciliation is required before resubmission or release.",
      lease_until: null,
    });
    captureMessage("Generation submission requires reconciliation", {
      level: "error",
      tags: { component: "generation" },
      extra: { jobId: job.id },
    });
    return "manual";
  }
  await finishJob(
    job.id,
    false,
    job.provider_reference ? "output_transfer_exhausted" : "generation_exhausted",
  );
  return "failed";
}

export const generateFashionContent = inngest.createFunction(
  {
    id: "generate-fashion-content",
    triggers: generationRequested,
    concurrency: [{ limit: 3 }, { limit: 1, key: "event.data.organizationId" }],
    idempotency: "event.data.jobId",
    retries: 3,
    onFailure: async ({ event, logger }) => {
      const original = event.data.event.data as { jobId?: string };
      if (!original.jobId) return;
      const state = await reconcileExhaustedGeneration(original.jobId);
      if (state !== "terminal")
        logger.error(
          state === "manual" ? "generation.reconciliation_required" : "generation.failed",
          { jobId: original.jobId },
        );
    },
  },
  async ({ event, step }) => {
    const { jobId, organizationId } = event.data;
    let submitted = await step.run("submit-once", () =>
      submitGenerationOnce(jobId, organizationId),
    );
    // Durable capacity waits do not spend retry attempts or accept more paid predictions.
    for (let capacityWait = 0; submitted.waiting && capacityWait < 120; capacityWait++) {
      await step.sleep(`capacity-wait-${capacityWait}`, "30s");
      submitted = await step.run(`capacity-claim-${capacityWait}`, () =>
        submitGenerationOnce(jobId, organizationId),
      );
    }
    if (submitted.waiting) {
      await step.run("release-capacity-timeout", () =>
        finishJob(jobId, false, "provider_capacity_timeout"),
      );
      return { jobId, state: "failed" };
    }
    if (submitted.terminal) return { jobId, state: "already_finished" };
    if (!submitted.id) throw new NonRetriableError("Provider prediction identifier missing.");
    await step.run("persist-prediction", async () => {
      await recordAcceptedPrediction(jobId, submitted.id!);
      return { persisted: true };
    });
    // Durable sleeps do not occupy a Vercel invocation. Status + transfer step returns only safe ids/state.
    for (let poll = 0; poll < 100; poll++) {
      await step.sleep(`wait-${poll}`, poll < 4 ? "15s" : "30s");
      const result = await step.run(`poll-and-transfer-${poll}`, async () => {
        try {
          return await pollGenerationAndTransfer(jobId, submitted.id!);
        } catch (error) {
          const current = await loadJob(jobId);
          await updateJob(jobId, {
            status: "retry_wait",
            retry_count: current.retry_count + 1,
            error_code: error instanceof ProviderError ? error.code : "transfer_retry",
            error_message:
              "The provider result is being recovered. No new generation was submitted.",
          });
          throw error;
        }
      });
      if (result.state !== "processing") return { jobId, state: result.state };
    }
    await step.run("release-timeout", () => finishJob(jobId, false, "provider_timeout"));
    return { jobId, state: "failed" };
  },
);

/** A separate event bypasses initial-submission dedupe without ever calling the paid POST endpoint. */
export const recoverKnownPrediction = inngest.createFunction(
  {
    id: "recover-known-fashion-prediction",
    triggers: generationRecoveryRequested,
    singleton: { key: "event.data.jobId", mode: "skip" },
    concurrency: 2,
    retries: 3,
    onFailure: async ({ event, logger }) => {
      const original = event.data.event.data as { jobId?: string };
      logger.error("generation.recovery_failed", { jobId: original.jobId });
      captureMessage("Known prediction recovery failed", {
        level: "error",
        tags: { component: "generation-recovery" },
        extra: { jobId: original.jobId },
      });
    },
  },
  async ({ event, step }) => {
    const job = await step.run("load-existing-prediction", async () => {
      const current = await loadJob(event.data.jobId, event.data.organizationId);
      if (!current.provider_reference)
        throw new NonRetriableError(
          "Recovery requires a known provider prediction. It cannot submit another request.",
        );
      return { id: current.id, reference: current.provider_reference, status: current.status };
    });
    if (["succeeded", "failed", "cancelled"].includes(job.status))
      return { jobId: job.id, state: job.status };
    for (let poll = 0; poll < 100; poll++) {
      if (poll) await step.sleep(`recovery-wait-${poll}`, "30s");
      const result = await step.run(`recover-and-transfer-${poll}`, () =>
        pollGenerationAndTransfer(job.id, job.reference),
      );
      if (result.state !== "processing") return { jobId: job.id, state: result.state };
    }
    return { jobId: job.id, state: "processing", needsOperatorAttention: true };
  },
);
