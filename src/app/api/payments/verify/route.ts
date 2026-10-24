import { z } from "zod";
import { requireTenant, consumeRateLimit } from "@/server/auth/context";
import { ApiError } from "@/server/auth/security";
import { assertDatabaseResult, readJson, route } from "@/server/services/http";
import { verifyPayment } from "@/server/billing/service";

export async function POST(request: Request) {
  return route(
    request,
    async () => {
      const { organizationId, reference } = z
        .object({
          organizationId: z.string().uuid().optional(),
          reference: z.string().min(8).max(200),
        })
        .strict()
        .parse(await readJson(request));
      const tenant = await requireTenant(organizationId, "billing");
      await consumeRateLimit(`verify:${tenant.organizationId}`, 30, 60);
      const { data, error } = await tenant.client
        .from("payment_transactions")
        .select("id")
        .eq("organization_id", tenant.organizationId)
        .eq("reference", reference)
        .maybeSingle();
      assertDatabaseResult(error);
      if (!data) throw new ApiError(404, "This payment was not found.", "NOT_FOUND");
      const transaction = await verifyPayment(reference);
      return { transaction };
    },
    true,
  );
}
