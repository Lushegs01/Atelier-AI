import "server-only";
import {
  FashionProvider,
  GenerationOperation,
  ProviderCapability,
  requireEnabledCapability,
} from "./contracts";
import { FASHN_OUTPUT_HOSTS, FashnProvider, getFashnCapabilities } from "./fashn";
import {
  HuggingFaceProvider,
  getHuggingFaceCapabilities,
  huggingFaceOutputHosts,
} from "./huggingface";

export type ProviderName = "huggingface" | "fashn";

const LABELS: Record<ProviderName, string> = { huggingface: "Hugging Face", fashn: "FASHN" };

/** Hugging Face's free ZeroGPU Spaces are the default; FASHN remains available as a paid option. */
export function activeProviderName(): ProviderName {
  return process.env.AI_PROVIDER === "fashn" ? "fashn" : "huggingface";
}

export function activeProviderLabel(): string {
  return LABELS[activeProviderName()];
}

export function getProviderCapabilities(): ProviderCapability[] {
  return activeProviderName() === "fashn" ? getFashnCapabilities() : getHuggingFaceCapabilities();
}

export function assertCapabilityEnabled(operation: GenerationOperation): void {
  requireEnabledCapability(getProviderCapabilities(), operation);
}

export function createFashionProvider(): FashionProvider {
  return activeProviderName() === "fashn" ? new FashnProvider() : new HuggingFaceProvider();
}

/** Output origins the active provider may return. */
export function providerOutputHosts(): string[] {
  return activeProviderName() === "fashn" ? [...FASHN_OUTPUT_HOSTS] : huggingFaceOutputHosts();
}
