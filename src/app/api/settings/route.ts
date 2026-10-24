import { z } from "zod";
import { getAdminClient } from "@/lib/supabase/admin";
import { requireTenant, requireUser } from "@/server/auth/context";
import { ApiError } from "@/server/auth/security";
import { assertDatabaseResult, readJson, route } from "@/server/services/http";

export async function GET(request: Request) {
  return route(request, async () => {
    const { user, client } = await requireUser();
    const { data: profile, error } = await client
      .from("profiles")
      .select("full_name,onboarding_completed_at")
      .eq("id", user.id)
      .maybeSingle();
    assertDatabaseResult(error);
    return { profile, email: user.email };
  });
}

export async function PATCH(request: Request) {
  return route(
    request,
    async () => {
      const input = z
        .object({
          section: z.enum(["profile", "organization", "brand", "security"]),
          organizationId: z.string().uuid().optional(),
          values: z.record(z.string(), z.unknown()),
        })
        .strict()
        .parse(await readJson(request));
      if (input.section === "profile") {
        const values = z
          .object({ fullName: z.string().trim().min(1).max(120) })
          .strict()
          .parse(input.values);
        const { user, client } = await requireUser();
        const { error } = await getAdminClient().from("profiles").upsert({
          id: user.id,
          full_name: values.fullName,
          updated_at: new Date().toISOString(),
        });
        assertDatabaseResult(error);
        const { error: authError } = await client.auth.updateUser({
          data: { display_name: values.fullName },
        });
        assertDatabaseResult(authError);
        return { ok: true };
      }
      if (input.section === "security") {
        const values = z
          .object({ signOutOtherSessions: z.literal(true) })
          .strict()
          .parse(input.values);
        const { client } = await requireUser();
        if (values.signOutOtherSessions) await client.auth.signOut({ scope: "others" });
        return {
          ok: true,
          message:
            "Other refresh sessions have been signed out. Existing access tokens expire according to your auth policy.",
        };
      }
      const tenant = await requireTenant(input.organizationId, "settings");
      let values: Record<string, unknown>;
      if (input.section === "organization") {
        const data = z
          .object({
            name: z.string().trim().min(2).max(80),
            dailySpendingLimit: z.number().int().min(0).max(100000).optional(),
          })
          .strict()
          .parse(input.values);
        values = {
          name: data.name,
          ...(data.dailySpendingLimit !== undefined
            ? { daily_spending_limit: data.dailySpendingLimit }
            : {}),
        };
      } else {
        const data = z
          .object({
            brandName: z.string().trim().min(2).max(80),
            brandColor: z.string().regex(/^#[a-fA-F0-9]{6}$/),
          })
          .strict()
          .parse(input.values);
        values = { brand_name: data.brandName, brand_color: data.brandColor };
      }
      const admin = getAdminClient();
      const { error } = await admin
        .from("organizations")
        .update({ ...values, updated_at: new Date().toISOString() })
        .eq("id", tenant.organizationId);
      assertDatabaseResult(error);
      const { error: auditError } = await admin.from("audit_logs").insert({
        organization_id: tenant.organizationId,
        actor_id: tenant.user.id,
        action: `settings.${input.section}.updated`,
        target_type: "organization",
        target_id: tenant.organizationId,
      });
      if (auditError)
        throw new ApiError(
          503,
          "Settings were saved, but their audit record could not be written. Contact support.",
          "AUDIT_ERROR",
        );
      return { ok: true };
    },
    true,
  );
}
