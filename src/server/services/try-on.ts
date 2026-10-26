import "server-only";
import { getAdminClient, hasSupabaseConfig } from "@/lib/supabase/admin";
import { ApiError, assertSessionUsable, validateGuestToken } from "@/server/auth/security";
import { assertDatabaseResult } from "./http";
import {
  getActiveProviderId,
  getProviderCapabilities,
  type ProviderId,
} from "@/server/ai/registry";
import { HF_PROCESSING_DISCLOSURE_VERSION, huggingFaceSpace } from "@/server/ai/huggingface";

export const CONSENT_VERSION = "2026-10-25-qwen-v1";
/** Each disclosure names its processor, so each provider records its own consent version. */
const CONSENT_VERSIONS: Record<ProviderId, string> = {
  qwen: CONSENT_VERSION,
  huggingface: "2026-10-26-huggingface-v2",
  fashn: "2026-10-24-v1",
};
export function getConsentVersion(provider: ProviderId) {
  return CONSENT_VERSIONS[provider];
}
/** Superseded versions still cover results their consent authorized; new work needs the current one. */
const PREVIOUS_CONSENT_VERSIONS: Partial<Record<ProviderId, string[]>> = {
  huggingface: ["2026-10-25-huggingface-v1"],
};
export function acceptedConsentVersions(provider: ProviderId) {
  return [CONSENT_VERSIONS[provider], ...(PREVIOUS_CONSENT_VERSIONS[provider] ?? [])];
}
const LABELS: Record<ProviderId, string> = {
  qwen: "Qwen Image Edit",
  huggingface: "Hugging Face",
  fashn: "FASHN",
};
const DISCLOSURES: Record<ProviderId, string> = {
  qwen: "Your photograph and the selected garment will be processed by the operator’s privately hosted Qwen Image Edit GPU service for this requested visualization. This experimental image-editing workflow has not been validated as a garment-fitting or body-measurement service and may change garment details or appearance. Results remain private and are not reused for promotion or training by this application.",
  huggingface: "",
  fashn:
    "Your photograph and the selected garment will be sent to FASHN for this requested AI visualization. FASHN and its subprocessors process the photographs under their retention policies. Results may change garment details or appearance; this is not a fit or body-measurement service. Results remain private and are not reused for promotion by this application.",
};
/** Guest consent text names the exact configured Space; it is versioned with its consent. */
function huggingFaceGuestDisclosure() {
  return `Your photograph and the selected garment will be sent to the Hugging Face Space “${huggingFaceSpace("try_on")}”, an open virtual try-on model running on Hugging Face’s shared GPU service. Unless this studio uses its own private copy, the Space is public and run by a third party; it is not a private or isolated environment. Hugging Face and the Space’s operator process the photographs under their own terms and retention, and this studio cannot delete copies held there. This experimental visualization is not a fit or body-measurement service and may change garment details or appearance. Your result is stored privately here and is not reused for promotion by this application.`;
}

/** Designer notice acknowledged per request as HF_PROCESSING_DISCLOSURE_VERSION. */
function huggingFaceDesignerDisclosure() {
  return `Photographs you submit are sent to Hugging Face Spaces run on Hugging Face’s shared GPU service: “${huggingFaceSpace("photo")}” for photographs, “${huggingFaceSpace("try_on")}” for try-on and “${huggingFaceSpace("video")}” for video. Unless your studio uses private copies, these Spaces are public and operated by third parties under their own terms and retention; they are not private or isolated environments, and copies held there cannot be deleted from Atelier AI. Outputs are experimental AI images or clips that may alter garment details. Results are stored privately here.`;
}

export function providerDisclosure(provider: ProviderId, operation: "photo" | "try_on" = "photo") {
  const capability = getProviderCapabilities(provider).find((item) => item.operation === operation);
  return {
    id: provider,
    label: LABELS[provider],
    model: capability?.model || "",
    lifecycle: capability?.lifecycle || "Experimental",
    disclosure:
      provider === "huggingface"
        ? operation === "try_on"
          ? huggingFaceGuestDisclosure()
          : huggingFaceDesignerDisclosure()
        : DISCLOSURES[provider],
    ...(provider === "huggingface" && operation !== "try_on"
      ? { processingDisclosureVersion: HF_PROCESSING_DISCLOSURE_VERSION }
      : {}),
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
