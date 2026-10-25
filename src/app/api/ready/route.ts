import { NextResponse } from "next/server";
import { environmentReadiness } from "@/lib/env";
import { getAdminClient } from "@/lib/supabase/admin";
import { getActiveProviderId, getProviderCapabilities } from "@/server/ai/registry";
import { probeQwenReadiness } from "@/server/services/provider-readiness";

export async function GET() {
  const environment = environmentReadiness();
  if (!environment.ready)
    return NextResponse.json(
      { status: "not_ready", configuration: false, missing: environment.missing },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  try {
    const admin = getAdminClient();
    const provider = getActiveProviderId();
    const capabilities = getProviderCapabilities();
    const enabled = capabilities.filter((capability) => capability.enabled);
    const [schema, storage, service] = await Promise.all([
      admin
        .from("generation_price_rules")
        .select(
          "id,provider,operation,provider_model,enabled,reviewed_at,estimated_provider_cost_microusd",
        )
        .eq("provider", provider),
      admin.storage.getBucket(process.env.STORAGE_BUCKET || "private-media"),
      provider === "qwen" && enabled.length > 0
        ? probeQwenReadiness()
        : Promise.resolve({ checked: false, ready: true }),
    ]);
    const pricing =
      !schema.error &&
      enabled.every((capability) =>
        (schema.data || []).some(
          (rule) =>
            rule.operation === capability.operation &&
            rule.provider_model === capability.model &&
            rule.enabled &&
            rule.reviewed_at &&
            (provider !== "qwen" || rule.estimated_provider_cost_microusd !== null),
        ),
      );
    const ready =
      !schema.error && !storage.error && storage.data?.public === false && service.ready && pricing;
    return NextResponse.json(
      {
        status: ready ? "ready" : "not_ready",
        configuration: true,
        database: !schema.error,
        privateStorage: !storage.error && storage.data?.public === false,
        provider,
        providerService: service,
        reviewedPricing: pricing,
        capabilities: capabilities.map(
          ({ operation, enabled, lifecycle, model, provider, notes, reason }) => ({
            operation,
            enabled,
            lifecycle,
            provider,
            model,
            notes,
            reason,
          }),
        ),
      },
      { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { status: "not_ready", configuration: true, database: false },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
