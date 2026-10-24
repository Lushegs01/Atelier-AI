import { z } from "zod";
import { requireTenant, consumeRateLimit } from "@/server/auth/context";
import { getAssetSignedUrl, deletePrivateAsset } from "@/server/storage/media";
import { route } from "@/server/services/http";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  // Return a short-lived link only after server membership and record ownership checks.
  return route(request, async () => {
    const { id } = await context.params;
    z.string().uuid().parse(id);
    const tenant = await requireTenant(
      new URL(request.url).searchParams.get("organizationId") || undefined,
    );
    await consumeRateLimit(`media:${tenant.user.id}`, 120, 60);
    return { url: await getAssetSignedUrl({ assetId: id, organizationId: tenant.organizationId }) };
  });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return route(
    request,
    async () => {
      const { id } = await context.params;
      z.string().uuid().parse(id);
      const tenant = await requireTenant(
        new URL(request.url).searchParams.get("organizationId") || undefined,
        "delete",
      );
      await deletePrivateAsset({ assetId: id, organizationId: tenant.organizationId });
      return { ok: true };
    },
    true,
  );
}
