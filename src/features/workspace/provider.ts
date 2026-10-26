export type PublicProviderId = "qwen" | "fashn" | "huggingface";
const LABELS: Record<PublicProviderId, string> = {
  qwen: "Qwen Image Edit",
  fashn: "FASHN",
  huggingface: "Hugging Face",
};
export interface PublicProvider {
  id: PublicProviderId;
  label: string;
  model?: string;
  lifecycle?: "Experimental" | "Preview";
  disclosure?: string;
  /** Present when the designer must acknowledge third-party processing for each request. */
  processingDisclosureVersion?: string;
}
export interface WorkspaceCapability {
  operation: "photo" | "video" | "try_on";
  provider?: PublicProviderId;
  model?: string;
  enabled: boolean;
  lifecycle: "Experimental" | "Preview";
  reason?: string;
  notes?: string;
  supportedViews?: readonly string[];
  supportedResolutions?: readonly string[];
  supportedDurations?: readonly number[];
  minInputDimension?: number;
  minAspectRatio?: number;
  maxAspectRatio?: number;
  freeTextMotion?: boolean;
}

export function providerLabel(id: PublicProviderId) {
  return LABELS[id] ?? id;
}

export function operationAvailability(
  operation: WorkspaceCapability["operation"],
  capabilities: readonly WorkspaceCapability[] = [],
  provider?: PublicProvider | null,
) {
  const capability = capabilities.find((item) => item.operation === operation);
  const enabled =
    capability?.enabled === true && !(provider?.id === "qwen" && operation === "video");
  const reason =
    provider?.id === "qwen" && operation === "video"
      ? "Qwen Image Edit creates still images and does not generate video."
      : capability?.reason ||
        (operation === "try_on"
          ? "Customer visualization is not enabled for this studio."
          : "This generation mode is not enabled for this studio.");
  return { enabled, capability, reason };
}

export function providerDisclosure(provider?: PublicProvider | null) {
  if (provider?.disclosure) return provider.disclosure;
  if (provider?.id === "qwen")
    return "Your photograph is processed by this studio’s operator-hosted Qwen Image Edit service. This experimental image edit is not a validated fitting system and may change garment or body details.";
  if (provider?.id === "fashn")
    return "Your photograph is sent to FASHN for third-party AI fashion visualization. Its processing and retention terms apply. Exact garment preservation and fit are not guaranteed.";
  if (provider?.id === "huggingface")
    return "Your photograph is sent to an open AI model on a public Hugging Face Space run by a third party for an experimental visualization. It is not a private environment, and Hugging Face’s and the Space operator’s terms apply. Exact garment preservation and fit are not guaranteed.";
  return "The processing provider must be identified before this photograph can be submitted.";
}

export type FailureCategory =
  "quota" | "unavailable" | "timeout" | "output" | "consent" | "rejected" | "failed";

/** Customer-safe explanation of a failed job's stored error code; never upstream text. */
export function failureExplanation(code?: string | null): {
  category: FailureCategory;
  title: string;
  detail: string;
} {
  const value = code || "";
  if (value === "provider_quota_exceeded" || value === "provider_quota_cooldown")
    return {
      category: "quota",
      title: "Free AI quota exhausted",
      detail:
        "The free provider’s daily GPU quota was used up, so nothing was generated. Your reserved credits were released. Try again later; the quota recovers over the day.",
    };
  if (
    /^(provider_(busy|unavailable|starting|rate_limited|capacity_timeout|not_submitted|http_5\d\d|endpoint_missing|auth_failed)|status_unavailable|provider_circuit_open)$/.test(
      value,
    )
  )
    return {
      category: "unavailable",
      title: "Provider temporarily unavailable",
      detail:
        "The free AI provider was busy, starting up or unreachable, so no result was produced. Your reserved credits were released. Please try again in a few minutes.",
    };
  if (
    /^(provider_timeout|provider_connection_lost|provider_result_unavailable|generation_exhausted|recovery_window_expired)$/.test(
      value,
    )
  )
    return {
      category: "timeout",
      title: "No result was returned",
      detail:
        "The provider did not return a result in time or the connection was interrupted. Nothing was charged for this job. You can start a new generation.",
    };
  if (
    /^(provider_invalid_output|provider_output_expired|output_transfer_exhausted|provider_invalid_response)$/.test(
      value,
    )
  )
    return {
      category: "output",
      title: "The result could not be used",
      detail:
        "The provider returned media that could not be verified, played or retrieved, so it was discarded. Your reserved credits were released.",
    };
  if (value === "consent_withdrawn")
    return {
      category: "consent",
      title: "Consent was withdrawn",
      detail: "The customer withdrew permission, so the result was deleted and not delivered.",
    };
  if (value === "processing_acknowledgement_missing" || value === "unsupported_option")
    return {
      category: "rejected",
      title: "The request was not sent",
      detail:
        "The request was missing a required acknowledgement or used unsupported settings. Nothing was sent to the provider and credits were released.",
    };
  return {
    category: "failed",
    title: "This generation could not be completed",
    detail: "Eligible reserved credits are released automatically.",
  };
}

/** Honest lifecycle wording for a job; no percentages are invented. */
export function jobStatusLabel(job: { status: string; error_code?: string | null }): string {
  if (job.status === "queued") return "Waiting to start";
  if (job.status === "submitting") return "Sending to provider";
  if (job.status === "processing") return "Processing";
  if (job.status === "retry_wait")
    return job.error_code === "provider_starting"
      ? "Provider starting up"
      : job.error_code === "provider_rate_limited" || job.error_code === "provider_unavailable"
        ? "Provider busy · will retry"
        : "Checking provider";
  if (job.status === "succeeded") return "Completed";
  if (job.status === "failed") {
    const category = failureExplanation(job.error_code).category;
    return category === "quota"
      ? "Quota exhausted"
      : category === "unavailable"
        ? "Temporarily unavailable"
        : "Failed";
  }
  return job.status.replaceAll("_", " ");
}
