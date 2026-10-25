export type PublicProviderId = "qwen" | "fashn";
export interface PublicProvider {
  id: PublicProviderId;
  label: string;
  model?: string;
  lifecycle?: "Experimental" | "Preview";
  disclosure?: string;
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
  return "The processing provider must be identified before this photograph can be submitted.";
}
