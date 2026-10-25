import "server-only";
import type { FashionProvider, GenerationOperation, ProviderCapability } from "./contracts";
import { FASHN_OUTPUT_HOSTS } from "./fashn";
import {
  assertCapabilityEnabled as assertRegistryCapabilityEnabled,
  createProviderForJob,
  getActiveProviderId,
  getProviderCapabilities as registryCapabilities,
  type ProviderId,
} from "./registry";

export type ProviderName = ProviderId;

const LABELS: Record<ProviderName, string> = { qwen: "Qwen Image Edit", fashn: "FASHN" };

/** Compatibility facade: provider selection remains centralized in the pinned-job registry. */
export function activeProviderName(): ProviderName {
  return getActiveProviderId();
}

export function activeProviderLabel(): string {
  return LABELS[activeProviderName()];
}

export function getProviderCapabilities(): ProviderCapability[] {
  return registryCapabilities();
}

export function assertCapabilityEnabled(operation: GenerationOperation): void {
  assertRegistryCapabilityEnabled(operation);
}

/** Existing jobs must use createProviderForJob with their persisted provider and model. */
export function createFashionProvider(operation: GenerationOperation = "photo"): FashionProvider {
  return createProviderForJob({ provider: getActiveProviderId(), operation });
}

/** Qwen output authorization requires getQwenOutputRequest's exact job URL check. */
export function providerOutputHosts(): string[] {
  return activeProviderName() === "fashn" ? [...FASHN_OUTPUT_HOSTS] : [];
}
