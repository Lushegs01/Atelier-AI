import { z } from "zod";
import { getAdminClient } from "@/lib/supabase/admin";
import { requireTenant, consumeRateLimit } from "@/server/auth/context";
import { assertDatabaseResult, readJson, route } from "@/server/services/http";

export async function POST(request: Request) {
  return route(
    request,
    async () => {
      const input = z
        .object({
          organizationId: z.string().uuid().optional(),
          name: z.string().trim().min(1).max(120),
          email: z.string().email().max(254).optional().or(z.literal("")),
          notes: z.string().trim().max(1000).default(""),
        })
        .strict()
        .parse(await readJson(request));
      const tenant = await requireTenant(input.organizationId, "create");
      await consumeRateLimit(`customer:${tenant.organizationId}`, 30, 3600);
      const { data, error } = await getAdminClient()
        .from("customers")
        .insert({
          organization_id: tenant.organizationId,
          name: input.name,
          email: input.email || null,
          notes: input.notes,
          created_by: tenant.user.id,
        })
        .select("id,name,email,notes,created_at")
        .single();
      assertDatabaseResult(error);
      return { customer: data };
    },
    true,
  );
}
