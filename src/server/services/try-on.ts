import "server-only";
import { getAdminClient, hasSupabaseConfig } from "@/lib/supabase/admin";
import { ApiError, assertSessionUsable, validateGuestToken } from "@/server/auth/security";
import { assertDatabaseResult } from "./http";
import {
  getActiveProviderId,
  getProviderCapabilities,
  type ProviderId,
} from "@/server/ai/registry";

export const CONSENT_VERSION = "2026-10-25-qwen-v1";
/** Each disclosure names its processor, so each provider records its own consent version. */
const CONSENT_VERSIONS: Record<ProviderId, string> = {
  qwen: CONSENT_VERSION,
  huggingface: "2026-10-25-huggingface-v1",
  fashn: "2026-10-24-v1",
};
export function getConsentVersion(provider: ProviderId) {
  return CONSENT_VERSIONS[provider];
}
const LABELS: Record<ProviderId, string> = {
  qwen: "Qwen Image Edit",
  huggingface: "Hugging Face",
  fashn: "FASHN",
};
const DISCLOSURES: Record<ProviderId, string> = {
  qwen: "Your photograph and the selected garment will be processed by the operator’s privately hosted Qwen Image Edit GPU service for this requested visualization. This experimental image-editing workflow has not been validated as a garment-fitting or body-measurement service and may change garment details or appearance. Results remain private and are not reused for promotion or training by this application.",
  huggingface:
    "Your photograph and the selected garment will be sent to an open AI model hosted on Hugging Face Spaces for this requested visualization. Hugging Face and the Space’s operator process the photographs under their terms. This experimental visualization is not a fit or body-measurement service and may change garment details or appearance. Results remain private and are not reused for promotion by this application.",
  fashn:
    "Your photograph and the selected garment will be sent to FASHN for this requested AI visualization. FASHN and its subprocessors process the photographs under their retention policies. Results may change garment details or appearance; this is not a fit or body-measurement service. Results remain private and are not reused for promotion by this application.",
};
export function providerDisclosure(provider: ProviderId, operation: "photo" | "try_on" = "photo") {
  const capability = getProviderCapabilities(provider).find((item) => item.operation === operation);
  return {
    id: provider,
    label: LABELS[provider],
    model: capability?.model || "",
    lifecycle: capability?.lifecycle || "Experimental",
    disclosure: DISCLOSURES[provider],
  };
}
export function requireSessionProvider(provider: string) {
  if (!Object.hasOwn(LABELS, provider) || provider !== getActiveProviderId())
    throw new ApiError(
      409,
      "This invitation uses a provider that is no longer selected. Ask the designer for a new link.",
      "PROVIDER_CHANGED",
    );
  return provider as ProviderId;
}

export async function getGuestSession(token: string, forSubmission = false, forDeletion = false) {
  const hash = validateGuestToken(token);
  if (!hasSupabaseConfig() || !process.env.SUPABASE_SERVICE_ROLE_KEY)
    throw new ApiError(503, "Customer try-on is not configured yet.", "NOT_CONFIGURED");
  const admin = getAdminClient();
  const { data, error } = await admin
    .from("try_on_sessions")
    .select(
      "id,organization_id,garment_id,provider,provider_model,quoted_credits,price_rule_id,expires_at,revoked_at,max_uses,uses,job_id,customer_asset_id,deleted_at",
    )
    .eq("token_hash", hash)
    .maybeSingle();
  assertDatabaseResult(error);
  if (!data) throw new ApiError(404, "This try-on link is invalid.", "INVALID_LINK");
  if (!forDeletion) assertSessionUsable(data, forSubmission);
  return data;
}
