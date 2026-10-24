import { z } from "zod";
import { getAdminClient } from "@/lib/supabase/admin";
import { requireTenant } from "@/server/auth/context";
import { ApiError } from "@/server/auth/security";
import { assertDatabaseResult, route } from "@/server/services/http";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return route(
    request,
    async () => {
      const { id } = await context.params;
      z.string().uuid().parse(id);
      const tenant = await requireTenant(
        new URL(request.url).searchParams.get("organizationId") || undefined,
        "create",
      );
      const { data, error } = await getAdminClient()
        .from("try_on_sessions")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", id)
        .eq("organization_id", tenant.organizationId)
        .select("id")
        .maybeSingle();
      assertDatabaseResult(error);
      if (!data) throw new ApiError(404, "This session was not found.", "NOT_FOUND");
      return { ok: true };
    },
    true,
  );
}
