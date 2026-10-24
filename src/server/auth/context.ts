import "server-only";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getAdminClient, hasSupabaseConfig } from "@/lib/supabase/admin";
import { ApiError, hasPermission, type Permission, type Role } from "./security";

export async function requireUser() {
  if (!hasSupabaseConfig())
    throw new ApiError(503, "Connect Supabase to enable your workspace.", "NOT_CONFIGURED");
  const client = await createServerSupabaseClient();
  const {
    data: { user },
    error,
  } = await client.auth.getUser();
  if (error || !user) throw new ApiError(401, "Sign in to continue.", "UNAUTHENTICATED");
  if (!user.email_confirmed_at)
    throw new ApiError(403, "Verify your email address to continue.", "EMAIL_UNVERIFIED");
  return { user, client };
}

export async function requireTenant(organizationId?: string, permission: Permission = "read") {
  const { user, client } = await requireUser();
  let query = client
    .from("organization_members")
    .select("organization_id,role")
    .eq("user_id", user.id);
  if (organizationId) query = query.eq("organization_id", organizationId);
  const { data, error } = await query.order("created_at").limit(1).maybeSingle();
  if (error)
    throw new ApiError(503, "Workspace membership could not be checked.", "DATABASE_UNAVAILABLE");
  if (!data) throw new ApiError(403, "You do not have access to this workspace.", "FORBIDDEN");
  if (!hasPermission(data.role, permission))
    throw new ApiError(403, "Your workspace role does not permit this action.", "ROLE_FORBIDDEN");
  return { user, client, organizationId: data.organization_id as string, role: data.role as Role };
}

export async function requirePlatformAdmin() {
  const context = await requireUser();
  const { data, error } = await getAdminClient()
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", context.user.id)
    .eq("active", true)
    .maybeSingle();
  if (error || !data)
    throw new ApiError(403, "Platform administrator access is required.", "ADMIN_FORBIDDEN");
  return context;
}

export async function consumeRateLimit(key: string, limit = 30, windowSeconds = 60) {
  const { data, error } = await getAdminClient().rpc("consume_rate_limit", {
    p_key: key,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error)
    throw new ApiError(
      503,
      "Request protection is temporarily unavailable.",
      "RATE_LIMIT_UNAVAILABLE",
    );
  if (!data)
    throw new ApiError(429, "Too many requests. Please try again shortly.", "RATE_LIMITED");
}
