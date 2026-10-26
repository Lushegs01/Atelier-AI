import { serve } from "inngest/next";
import { inngest } from "@/workers/client";
import { generateFashionContent, recoverKnownPrediction } from "@/workers/generation";
import { cleanPrivateMedia, dispatchOutbox, recoverStuckGenerations } from "@/workers/maintenance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A Hugging Face result read holds its stream for up to HF_RESULT_WAIT_SECONDS (default 240 s),
// because closing it early cancels the Space job. Lower that setting if your host caps below 300 s.
export const maxDuration = 300;

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
