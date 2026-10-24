import { z } from "zod";
import { getAdminClient } from "@/lib/supabase/admin";
import { requireTenant } from "@/server/auth/context";
import { ApiError } from "@/server/auth/security";
import { assertDatabaseResult, readJson, route } from "@/server/services/http";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return route(
    request,
    async () => {
      const { id } = await context.params;
      z.string().uuid().parse(id);
      const input = z
        .object({
          name: z.string().trim().min(1).max(120).optional(),
          email: z.string().email().max(254).nullable().optional(),
          notes: z.string().trim().max(1000).optional(),
        })
        .strict()
        .parse(await readJson(request));
      const tenant = await requireTenant(
        new URL(request.url).searchParams.get("organizationId") || undefined,
        "create",
      );
      const { data, error } = await getAdminClient()
        .from("customers")
        .update(input)
        .eq("id", id)
        .eq("organization_id", tenant.organizationId)
        .is("deleted_at", null)
        .select("id,name,email,notes")
        .maybeSingle();
      assertDatabaseResult(error);
      if (!data) throw new ApiError(404, "This customer was not found.", "NOT_FOUND");
      return { customer: data };
    },
    true,
  );
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
      const { data, error } = await getAdminClient()
        .from("customers")
        .update({ deleted_at: new Date().toISOString(), email: null, notes: "" })
        .eq("id", id)
        .eq("organization_id", tenant.organizationId)
        .select("id")
        .maybeSingle();
      assertDatabaseResult(error);
      if (!data) throw new ApiError(404, "This customer was not found.", "NOT_FOUND");
      return { ok: true };
    },
    true,
  );
}
