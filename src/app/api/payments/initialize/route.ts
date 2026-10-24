import { z } from "zod";
import { requireTenant, consumeRateLimit } from "@/server/auth/context";
import { ApiError } from "@/server/auth/security";
import { readJson, route } from "@/server/services/http";
import { initializePayment } from "@/server/billing/service";

export async function POST(request: Request) {
  return route(
    request,
    async () => {
      const { organizationId, packageId } = z
        .object({ organizationId: z.string().uuid().optional(), packageId: z.string().uuid() })
        .strict()
        .parse(await readJson(request));
      const tenant = await requireTenant(organizationId, "billing");
      await consumeRateLimit(`payment:${tenant.organizationId}`, 10, 3600);
      if (!tenant.user.email)
        throw new ApiError(422, "A verified email address is required.", "EMAIL_REQUIRED");
      return initializePayment({
        organizationId: tenant.organizationId,
        actorId: tenant.user.id,
        email: tenant.user.email,
        packageId,
      });
    },
    true,
  );
}
