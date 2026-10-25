import { NextResponse } from "next/server";
import { environmentReadiness } from "@/lib/env";
import { getAdminClient } from "@/lib/supabase/admin";
import { getProviderCapabilities } from "@/server/ai/provider";

export async function GET() {
  const environment = environmentReadiness();
  if (!environment.ready)
    return NextResponse.json(
      { status: "not_ready", configuration: false, missing: environment.missing },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  try {
    const admin = getAdminClient();
    const [schema, storage] = await Promise.all([
      admin.from("generation_price_rules").select("id").limit(1),
      admin.storage.getBucket(process.env.STORAGE_BUCKET || "private-media"),
    ]);
    const ready = !schema.error && !storage.error && storage.data?.public === false;
    return NextResponse.json(
      {
        status: ready ? "ready" : "not_ready",
        configuration: true,
        database: !schema.error,
        privateStorage: !storage.error && storage.data?.public === false,
        capabilities: getProviderCapabilities().map(({ operation, enabled, lifecycle }) => ({
          operation,
          enabled,
          lifecycle,
        })),
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
