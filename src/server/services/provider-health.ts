import "server-only";
import { getAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/server/auth/security";
import type { ProviderId } from "@/server/ai/registry";

/**
 * Hugging Face reports ZeroGPU quota exhaustion only when a job is refused. Every job uses the
 * same server token, so a recent refusal means new work would be refused too. This is a cooldown
 * after an observed refusal, not an estimate of remaining quota.
 */
export const HF_QUOTA_COOLDOWN_MINUTES = 10;

export async function huggingFaceQuotaCooldownActive(now = Date.now()): Promise<boolean> {
  const { count, error } = await getAdminClient()
    .from("generation_jobs")
    .select("id", { count: "exact", head: true })
    .eq("provider", "huggingface")
    .eq("error_code", "provider_quota_exceeded")
    .gte("updated_at", new Date(now - HF_QUOTA_COOLDOWN_MINUTES * 60_000).toISOString());
  // An unreadable signal does not block work; the Space reports exhaustion itself.
  if (error) return false;
  return (count ?? 0) > 0;
}

/** Refuses a new request before credits are reserved while the free quota is known exhausted. */
export async function assertProviderQuotaAvailable(provider: ProviderId): Promise<void> {
  if (provider !== "huggingface") return;
  if (await huggingFaceQuotaCooldownActive())
    throw new ApiError(
      503,
      "The free AI provider’s daily GPU quota is used up. No credits were reserved. Please try again later.",
      "PROVIDER_QUOTA_EXHAUSTED",
    );
}
