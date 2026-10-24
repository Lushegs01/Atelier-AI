import { serve } from "inngest/next";
import { inngest } from "@/workers/client";
import { generateFashionContent, recoverKnownPrediction } from "@/workers/generation";
import { cleanPrivateMedia, dispatchOutbox, recoverStuckGenerations } from "@/workers/maintenance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    generateFashionContent,
    recoverKnownPrediction,
    dispatchOutbox,
    recoverStuckGenerations,
    cleanPrivateMedia,
  ],
});
