import { z } from "zod";
import { requireTenant } from "@/server/auth/context";
import { getAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/server/auth/security";
import { assertDatabaseResult, readJson, route } from "@/server/services/http";
import { getAssetSignedUrl, deletePrivateAsset } from "@/server/storage/media";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  return route(request, async () => {
    const { id } = await context.params;
    z.string().uuid().parse(id);
    const tenant = await requireTenant(
      new URL(request.url).searchParams.get("organizationId") || undefined,
    );
    const { data: job, error } = await tenant.client
      .from("generation_jobs")
      .select(
        "id,operation,status,provider,provider_model,error_code,error_message,garment_id,source_asset_id,estimated_credits,settled_credits,created_at,completed_at",
      )
      .eq("id", id)
      .eq("organization_id", tenant.organizationId)
      .maybeSingle();
    assertDatabaseResult(error);
    if (!job) throw new ApiError(404, "This generation was not found.", "NOT_FOUND");
    // The exact source sent to the provider, for side-by-side review. Signing re-checks tenant
    // ownership, retention and customer consent; an unavailable source is simply omitted.
    const source = job.source_asset_id
      ? await getAssetSignedUrl({
          assetId: job.source_asset_id,
          organizationId: tenant.organizationId,
        })
          .then((url) => ({ url }))
          .catch(() => null)
      : null;
    if (job.status !== "succeeded") return { job, source, outputs: [] };
    const { data: outputs } = await tenant.client
      .from("generation_outputs")
      .select("id,asset_id,approved_at,rejected_at")
      .eq("job_id", id)
      .eq("organization_id", tenant.organizationId);
    return {
      job,
      source,
      outputs: await Promise.all(
        (outputs || []).map(async (output) => ({
          ...output,
          url: await getAssetSignedUrl({
            assetId: output.asset_id,
            organizationId: tenant.organizationId,
          }),
        })),
      ),
    };
  });
}

export async function PATCH(request: Request, context: Context) {
  return route(
    request,
    async () => {
      const { id } = await context.params;
      z.string().uuid().parse(id);
      const { outputId, approved } = z
        .object({ outputId: z.string().uuid(), approved: z.boolean() })
        .parse(await readJson(request));
      const tenant = await requireTenant(
        new URL(request.url).searchParams.get("organizationId") || undefined,
        "create",
      );
      const { data, error } = await getAdminClient()
        .from("generation_outputs")
        .update({
          approved_at: approved ? new Date().toISOString() : null,
          rejected_at: approved ? null : new Date().toISOString(),
        })
        .eq("id", outputId)
        .eq("job_id", id)
        .eq("organization_id", tenant.organizationId)
        .select("id,approved_at,rejected_at")
        .maybeSingle();
      assertDatabaseResult(error);
      if (!data) throw new ApiError(404, "This output was not found.", "NOT_FOUND");
      return { output: data };
    },
    true,
  );
}

export async function DELETE(request: Request, context: Context) {
  return route(
    request,
    async () => {
      const { id } = await context.params;
      z.string().uuid().parse(id);
      const tenant = await requireTenant(
        new URL(request.url).searchParams.get("organizationId") || undefined,
        "delete",
      );
      const { data: outputs, error } = await tenant.client
        .from("generation_outputs")
        .select("asset_id")
        .eq("job_id", id)
        .eq("organization_id", tenant.organizationId);
      assertDatabaseResult(error);
      if (!outputs?.length) throw new ApiError(404, "This output was not found.", "NOT_FOUND");
      for (const output of outputs)
        await deletePrivateAsset({
          assetId: output.asset_id,
          organizationId: tenant.organizationId,
        });
      return { ok: true };
    },
    true,
  );
}
