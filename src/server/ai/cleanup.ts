import "server-only";
import { getAdminClient } from "@/lib/supabase/admin";
import { createProviderForJob } from "./registry";
import type { GenerationOperation } from "./contracts";

type DeletionInput = { organizationId: string; jobId: string };

/** Record upstream cleanup independently of local storage deletion or GPU availability. */
export async function requestQwenPredictionDeletion(input: DeletionInput) {
  const admin = getAdminClient();
  const { data: job, error } = await admin
    .from("generation_jobs")
    .select(
      "id,organization_id,provider,provider_model,provider_reference,operation,inference_delete_requested_at,inference_delete_completed_at",
    )
    .eq("id", input.jobId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (error) throw new Error("Private inference cleanup could not inspect the authorized job.");
  if (!job || job.provider !== "qwen") return null;
  if (!job.inference_delete_requested_at) {
    const { error: requestError } = await admin
      .from("generation_jobs")
      .update({ inference_delete_requested_at: new Date().toISOString() })
      .eq("id", job.id)
      .eq("organization_id", input.organizationId)
      .is("inference_delete_requested_at", null);
    if (requestError) throw new Error("Private inference cleanup could not be recorded.");
  }
  return job;
}

/** Only an authorized deletion caller or maintenance worker may invoke this. */
export async function purgeQwenPrediction(input: DeletionInput) {
  const job = await requestQwenPredictionDeletion(input);
  if (!job || job.inference_delete_completed_at) return;
  const provider = createProviderForJob({
    ...job,
    operation: job.operation as GenerationOperation,
  });
  if (!provider.deleteGeneration) throw new Error("Private inference cleanup is not available.");
  await provider.deleteGeneration(job.provider_reference || job.id);
  const { error } = await getAdminClient()
    .from("generation_jobs")
    .update({ inference_delete_completed_at: new Date().toISOString() })
    .eq("id", job.id)
    .eq("organization_id", input.organizationId)
    .is("inference_delete_completed_at", null);
  if (error) throw new Error("Private inference cleanup completion could not be recorded.");
}
