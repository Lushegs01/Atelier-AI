import "server-only";
import { FashnProvider, getProviderCapabilities as fashnCapabilities } from "./fashn";
import { QwenProvider, getQwenCapabilities, QWEN_MODEL } from "./qwen";
import { HF_MODELS, HuggingFaceProvider, getHuggingFaceCapabilities } from "./huggingface";
import {
  ProviderError,
  type FashionProvider,
  type GenerationOperation,
  type ProviderCapability,
} from "./contracts";

export type ProviderId = "fashn" | "qwen" | "huggingface";
const PROVIDERS: readonly string[] = ["qwen", "fashn", "huggingface"];
export { QWEN_MODEL };

export function getActiveProviderId(): ProviderId {
  const provider = process.env.AI_PROVIDER || "huggingface";
  if (!PROVIDERS.includes(provider))
    throw new ProviderError("The configured AI provider is unsupported.", "provider_invalid");
  return provider as ProviderId;
}

export function getProviderCapabilities(
  provider: ProviderId = getActiveProviderId(),
): ProviderCapability[] {
  if (provider === "fashn")
    return fashnCapabilities().map((capability) => ({ ...capability, provider }));
  if (provider === "huggingface") return getHuggingFaceCapabilities();
  return getQwenCapabilities();
}

export function assertCapabilityEnabled(
  operation: GenerationOperation,
  provider: ProviderId = getActiveProviderId(),
) {
  if (
    !getProviderCapabilities(provider).find((capability) => capability.operation === operation)
      ?.enabled
  )
    throw new ProviderError(
      "This generation capability is unavailable. Configure and enable the selected provider first.",
      "capability_disabled",
    );
}

/** Historical jobs always resume their original provider, even after operator configuration changes. */
export function createProviderForJob(job: {
  provider?: string | null;
  provider_model?: string | null;
  operation: GenerationOperation;
}): FashionProvider {
  const inferred = job.provider || (job.provider_model === QWEN_MODEL ? "qwen" : "fashn");
  if (!PROVIDERS.includes(inferred))
    throw new ProviderError(
      "This job uses an unknown provider. Operator reconciliation is required.",
      "provider_invalid",
    );
  const expected =
    inferred === "qwen"
      ? QWEN_MODEL
      : inferred === "huggingface"
        ? HF_MODELS[job.operation]
        : ({ photo: "product-to-model", video: "image-to-video", try_on: "tryon-max" } as const)[
            job.operation
          ];
  if (job.provider_model && job.provider_model !== expected)
    throw new ProviderError(
      "This job's pinned provider model is not supported. It has not been rerouted.",
      "model_mismatch",
    );
  if (inferred === "qwen") {
    if (job.operation === "video")
      throw new ProviderError("Qwen-Image-Edit does not support video.", "operation_unsupported");
    return new QwenProvider();
  }
  if (inferred === "huggingface") return new HuggingFaceProvider();
  return new FashnProvider();
}
