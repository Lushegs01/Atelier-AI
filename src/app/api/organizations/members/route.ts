import { z } from "zod";
import { getAdminClient } from "@/lib/supabase/admin";
import { requireTenant, consumeRateLimit } from "@/server/auth/context";
import { ApiError } from "@/server/auth/security";
import { assertDatabaseResult, readJson, route } from "@/server/services/http";

export async function GET(request: Request) {
  return route(request, async () => {
    const tenant = await requireTenant(
      new URL(request.url).searchParams.get("organizationId") || undefined,
      "members",
    );
    await consumeRateLimit(`members-read:${tenant.user.id}`, 60, 60);
    const { data, error } = await tenant.client
      .from("organization_members")
      .select("user_id,role,created_at")
      .eq("organization_id", tenant.organizationId);
    assertDatabaseResult(error);
    const admin = getAdminClient();
    const members = await Promise.all(
      (data || []).slice(0, 50).map(async (member) => {
        const { data: profile } = await admin.auth.admin.getUserById(member.user_id);
        return {
          ...member,
          email: profile.user?.email || "",
          full_name: profile.user?.user_metadata?.display_name || "",
        };
      }),
    );
    return { members };
  });
}

export async function POST(request: Request) {
  return route(
    request,
    async () => {
      const input = z
        .object({
          organizationId: z.string().uuid().optional(),
          userId: z.string().uuid().optional(),
          email: z.string().trim().email().max(254).toLowerCase().optional(),
          role: z.enum(["admin", "designer", "assistant"]),
        })
        .strict()
        .refine((data) => Boolean(data.userId) !== Boolean(data.email), {
          message: "Supply one registered email address.",
        })
        .parse(await readJson(request));
      const tenant = await requireTenant(input.organizationId, "members");
      await consumeRateLimit(`members-write:${tenant.user.id}`, 30, 3600);
      const admin = getAdminClient();
      let userId = input.userId;
      if (input.email) {
        const { data, error } = await admin.rpc("resolve_registered_user", {
          p_email: input.email,
        });
        assertDatabaseResult(error);
        if (!data || typeof data !== "string")
          throw new ApiError(422, "A verified registered account is required.", "ACCOUNT_REQUIRED");
        userId = data;
      }
      if (!userId)
        throw new ApiError(422, "A verified registered account is required.", "ACCOUNT_REQUIRED");
      if (userId === tenant.user.id)
        throw new ApiError(
          422,
          "Use another account to change your membership.",
          "SELF_CHANGE_FORBIDDEN",
        );
      if (input.role === "admin" && tenant.role !== "owner")
        throw new ApiError(
          403,
          "Only a workspace owner can appoint administrators.",
          "ROLE_FORBIDDEN",
        );
      const { error } = await admin.rpc("manage_organization_member", {
        p_organization_id: tenant.organizationId,
        p_actor_id: tenant.user.id,
        p_user_id: userId,
        p_role: input.role,
      });
      assertDatabaseResult(error);
      return { ok: true };
    },
    true,
  );
}

export async function DELETE(request: Request) {
  return route(
    request,
    async () => {
      const input = z
        .object({ organizationId: z.string().uuid().optional(), userId: z.string().uuid() })
        .strict()
        .parse(await readJson(request));
      const tenant = await requireTenant(input.organizationId, "members");
      if (input.userId === tenant.user.id)
        throw new ApiError(
          422,
          "Your own membership cannot be removed here.",
          "SELF_CHANGE_FORBIDDEN",
        );
      const admin = getAdminClient();
      await consumeRateLimit(`members-write:${tenant.user.id}`, 30, 3600);
      const { error } = await admin.rpc("manage_organization_member", {
        p_organization_id: tenant.organizationId,
        p_actor_id: tenant.user.id,
        p_user_id: input.userId,
        p_role: null,
      });
      assertDatabaseResult(error);
      return { ok: true };
    },
    true,
  );
}
