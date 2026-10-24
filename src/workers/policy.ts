export interface SubmissionSnapshot {
  status: string;
  provider_reference: string | null;
  error_code?: string | null;
  lease_until?: string | null;
}

/** A lost provider response is never permission to submit a second paid generation. */
export function submissionDecision(
  job: SubmissionSnapshot,
  now = Date.now(),
): "terminal" | "resume" | "claim" | "wait" | "reconcile" {
  if (["succeeded", "failed", "cancelled"].includes(job.status)) return "terminal";
  if (job.provider_reference) return "resume";
  if (job.error_code === "submission_ambiguous") return "reconcile";
  if (job.status === "submitting")
    return job.lease_until && Date.parse(job.lease_until) > now ? "wait" : "reconcile";
  return ["queued", "retry_wait"].includes(job.status) ? "claim" : "reconcile";
}

export function retryDelaySeconds(retryCount: number, random = Math.random): number {
  return Math.min(300, 15 * 2 ** Math.min(retryCount, 4)) + Math.floor(random() * 10);
}
