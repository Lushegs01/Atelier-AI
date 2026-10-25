import { z } from "zod";
import { getAdminClient } from "@/lib/supabase/admin";
import { requireTenant, consumeRateLimit } from "@/server/auth/context";
import { ApiError, createGuestToken } from "@/server/auth/security";
import { assertDatabaseResult, readJson, route } from "@/server/services/http";
import { requireCapability } from "@/server/services/generations";
import { quoteGeneration } from "@/server/billing/service";

export async function POST(request: Request) {
  return route(
    request,
    async () => {
      const input = z
        .object({
          organizationId: z.string().uuid().optional(),
          garmentId: z.string().uuid(),
          expiresInHours: z.number().int().min(1).max(168).default(72),
        })
        .strict()
        .parse(await readJson(request));
      const tenant = await requireTenant(input.organizationId, "create");
      const capability = requireCapability("try_on");
      await consumeRateLimit(`tryon-create:${tenant.organizationId}`, 30, 3600);
      const { data: garment, error } = await tenant.client
        .from("garments")
        .select("id")
        .eq("organization_id", tenant.organizationId)
        .eq("id", input.garmentId)
        .is("deleted_at", null)
        .is("archived_at", null)
        .maybeSingle();
      assertDatabaseResult(error);
      if (!garment) throw new ApiError(404, "This garment was not found.", "NOT_FOUND");
      let sourceQuery = tenant.client
        .from("assets")
        .select("id,width,height,byte_size")
        .eq("organization_id", tenant.organizationId)
        .eq("garment_id", garment.id)
        .in("kind", ["original", "garment_original"])
        .in("view", [...capability.supportedViews])
        .gte("width", capability.minInputDimension)
        .gte("height", capability.minInputDimension)
        .is("deleted_at", null);
      if (capability.provider === "qwen")
        sourceQuery = sourceQuery.lte("byte_size", 4 * 1024 * 1024);
      const { data: source, error: sourceError } = await sourceQuery
        .order("created_at")
        .limit(1)
        .maybeSingle();
      assertDatabaseResult(sourceError);
      if (
        !source ||
        source.width < capability.minInputDimension ||
        source.height < capability.minInputDimension ||
        (capability.provider === "qwen" && source.byte_size > 4 * 1024 * 1024)
      )
        throw new ApiError(
          422,
          `Upload a compatible garment photograph at least ${capability.minInputDimension} pixels wide and high before creating a link.`,
          "SOURCE_INCOMPATIBLE",
        );
      const quote = await quoteGeneration({
        organizationId: tenant.organizationId,
        operation: "try_on",
        options: {},
      });
      if (!quote.sufficient)
        throw new ApiError(
          402,
          "Add credits before creating a customer try-on link.",
          "INSUFFICIENT_CREDITS",
        );
      const { token, hash } = createGuestToken();
      const { data: session, error: insertError } = await getAdminClient()
        .from("try_on_sessions")
        .insert({
          organization_id: tenant.organizationId,
          garment_id: input.garmentId,
          token_hash: hash,
          expires_at: new Date(Date.now() + input.expiresInHours * 3600000).toISOString(),
          quoted_credits: quote.credits,
          price_rule_id: quote.priceRuleId,
          provider: quote.provider,
          provider_model: quote.providerModel,
          created_by: tenant.user.id,
        })
        .select("id,expires_at,max_uses")
        .single();
      assertDatabaseResult(insertError);
      const appUrl = new URL(process.env.NEXT_PUBLIC_APP_URL || request.url).origin;
      return { session, token, url: `${appUrl}/try/${token}`, estimatedCredits: quote.credits };
    },
    true,
  );
}
