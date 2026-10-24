import { z } from "zod";
import { getAdminClient } from "@/lib/supabase/admin";
import { requireUser, requireTenant, consumeRateLimit } from "@/server/auth/context";
import { assertDatabaseResult, readJson, route } from "@/server/services/http";

export async function POST(request: Request) {
  return route(
    request,
    async () => {
      const input = z
        .object({
          type: z
            .enum([
              "delete_account",
              "delete_customer_data",
              "export_data",
              "export",
              "report_problem",
            ])
            .transform((type) => (type === "export" ? "export_data" : type)),
          organizationId: z.string().uuid().optional(),
          reason: z.string().trim().max(1000).optional(),
        })
        .strict()
        .parse(await readJson(request));
      const { user } = await requireUser();
      await consumeRateLimit(`privacy:${user.id}`, 5, 86400);
      const tenant = input.organizationId
        ? await requireTenant(
            input.organizationId,
            input.type === "delete_customer_data" ? "settings" : "read",
          )
        : null;
      const { data, error } = await getAdminClient()
        .from("privacy_requests")
        .insert({
          organization_id: tenant?.organizationId || null,
          user_id: user.id,
          type: input.type,
          reason: input.reason,
        })
        .select("id,status,created_at")
        .single();
      assertDatabaseResult(error);
      return {
        request: data,
        message:
          "Your request has been recorded for review. Data exports and account deletion require an authorized privacy review.",
      };
    },
    true,
  );
}
