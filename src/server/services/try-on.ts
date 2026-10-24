import "server-only";
import { getAdminClient, hasSupabaseConfig } from "@/lib/supabase/admin";
import { ApiError, assertSessionUsable, validateGuestToken } from "@/server/auth/security";
import { assertDatabaseResult } from "./http";

export const CONSENT_VERSION = "2026-10-24-v1";

export async function getGuestSession(token: string, forSubmission = false, forDeletion = false) {
  const hash = validateGuestToken(token);
  if (!hasSupabaseConfig() || !process.env.SUPABASE_SERVICE_ROLE_KEY)
    throw new ApiError(503, "Customer try-on is not configured yet.", "NOT_CONFIGURED");
  const admin = getAdminClient();
  const { data, error } = await admin
    .from("try_on_sessions")
    .select(
      "id,organization_id,garment_id,expires_at,revoked_at,max_uses,uses,job_id,customer_asset_id,deleted_at",
    )
    .eq("token_hash", hash)
    .maybeSingle();
  assertDatabaseResult(error);
  if (!data) throw new ApiError(404, "This try-on link is invalid.", "INVALID_LINK");
  if (!forDeletion) assertSessionUsable(data, forSubmission);
  return data;
}
