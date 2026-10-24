import { z } from "zod";
import { getAdminClient } from "@/lib/supabase/admin";
import { requireTenant, consumeRateLimit } from "@/server/auth/context";
import { ApiError } from "@/server/auth/security";
import { assertDatabaseResult, readJson, readImageForm, route } from "@/server/services/http";
import { deletePrivateAsset, uploadPrivateImage } from "@/server/storage/media";

type Context = { params: Promise<{ id: string }> };

async function garmentContext(
  request: Request,
  context: Context,
  permission: "read" | "create" | "delete",
) {
  const { id } = await context.params;
  z.string().uuid().parse(id);
  const organizationId = z
    .string()
    .uuid()
    .optional()
    .parse(new URL(request.url).searchParams.get("organizationId") || undefined);
  const tenant = await requireTenant(organizationId, permission);
  const { data, error } = await tenant.client
    .from("garments")
    .select("*")
    .eq("id", id)
    .eq("organization_id", tenant.organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  assertDatabaseResult(error);
  if (!data) throw new ApiError(404, "This garment was not found.", "NOT_FOUND");
  return { ...tenant, garment: data };
}

export async function GET(request: Request, context: Context) {
  return route(request, async () => {
    const tenant = await garmentContext(request, context, "read");
    const { data: assets, error } = await tenant.client
      .from("assets")
      .select("id,kind,view,mime_type,width,height,created_at")
      .eq("organization_id", tenant.organizationId)
      .eq("garment_id", tenant.garment.id)
      .is("deleted_at", null);
    assertDatabaseResult(error);
    return { garment: tenant.garment, assets };
  });
}

export async function PATCH(request: Request, context: Context) {
  return route(
    request,
    async () => {
      const tenant = await garmentContext(request, context, "create");
      const input = z
        .object({
          name: z.string().trim().min(2).max(120).optional(),
          description: z.string().trim().max(1200).optional(),
          category: z
            .enum(["dress", "top", "bottom", "outerwear", "accessory", "other"])
            .optional(),
          collection: z.string().trim().max(100).optional(),
          archived: z.boolean().optional(),
        })
        .strict()
        .parse(await readJson(request));
      const { archived, ...values } = input;
      const { data, error } = await getAdminClient()
        .from("garments")
        .update({
          ...values,
          ...(archived !== undefined
            ? { archived_at: archived ? new Date().toISOString() : null }
            : {}),
        })
        .eq("id", tenant.garment.id)
        .eq("organization_id", tenant.organizationId)
        .select()
        .single();
      assertDatabaseResult(error);
      return { garment: data };
    },
    true,
  );
}

export async function POST(request: Request, context: Context) {
  return route(
    request,
    async () => {
      const tenant = await garmentContext(request, context, "create");
      await consumeRateLimit(`upload:${tenant.organizationId}`, 30, 3600);
      const { form, file } = await readImageForm(request);
      const view = z
        .enum(["front", "back", "side", "detail", "mannequin", "hanger", "flat-lay"])
        .parse(form.get("view") || "front");
      const asset = await uploadPrivateImage({
        organizationId: tenant.organizationId,
        actorId: tenant.user.id,
        file,
        garmentId: tenant.garment.id,
        kind: "garment_original",
        view,
      });
      return { asset };
    },
    true,
  );
}

export async function DELETE(request: Request, context: Context) {
  return route(
    request,
    async () => {
      const tenant = await garmentContext(request, context, "delete");
      const admin = getAdminClient();
      const { data: assets, error: assetError } = await admin
        .from("assets")
        .select("id")
        .eq("organization_id", tenant.organizationId)
        .eq("garment_id", tenant.garment.id)
        .is("deleted_at", null);
      assertDatabaseResult(assetError);
      for (const asset of assets || [])
        await deletePrivateAsset({ assetId: asset.id, organizationId: tenant.organizationId });
      const { error } = await admin
        .from("garments")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", tenant.garment.id)
        .eq("organization_id", tenant.organizationId);
      assertDatabaseResult(error);
      return { ok: true };
    },
    true,
  );
}
