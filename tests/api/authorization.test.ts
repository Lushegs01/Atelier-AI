import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  configured: true,
  user: { id: "alice", email_confirmed_at: "2026-01-01", user_metadata: { role: "owner" } } as {
    id: string;
    email_confirmed_at: string | null;
    user_metadata: { role: string };
  } | null,
  memberships: [
    { user_id: "alice", organization_id: "org-a", role: "designer" },
    { user_id: "bob", organization_id: "org-b", role: "owner" },
  ],
  platformAdmin: false,
  rateData: true as boolean | null,
  rateError: null as object | null,
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user }, error: null }) },
    from: () => {
      const filters: Record<string, unknown> = {};
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => {
          filters[key] = value;
          return query;
        },
        order: () => query,
        limit: () => query,
        maybeSingle: async () => ({
          data:
            state.memberships.find((member) =>
              Object.entries(filters).every(
                ([key, value]) => member[key as keyof typeof member] === value,
              ),
            ) || null,
          error: null,
        }),
      };
      return query;
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  hasSupabaseConfig: () => state.configured,
  getAdminClient: () => ({
    rpc: async () => ({ data: state.rateData, error: state.rateError }),
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({
          data: state.platformAdmin ? { user_id: state.user?.id } : null,
          error: null,
        }),
      };
      return query;
    },
  }),
}));

import {
  requireUser,
  requireTenant,
  requirePlatformAdmin,
  consumeRateLimit,
} from "@/server/auth/context";

describe("server authorization with synthetic authenticated sessions", () => {
  beforeEach(() => {
    state.configured = true;
    state.user = {
      id: "alice",
      email_confirmed_at: "2026-01-01",
      user_metadata: { role: "owner" },
    };
    state.memberships[0].role = "designer";
    state.platformAdmin = false;
    state.rateData = true;
    state.rateError = null;
  });
  it("rejects unauthenticated and unverified accounts", async () => {
    state.user = null;
    await expect(requireUser()).rejects.toMatchObject({ status: 401 });
    state.user = { id: "alice", email_confirmed_at: null, user_metadata: { role: "owner" } };
    await expect(requireUser()).rejects.toMatchObject({ status: 403, code: "EMAIL_UNVERIFIED" });
  });
  it("fails clearly when authentication is unconfigured", async () => {
    state.configured = false;
    await expect(requireUser()).rejects.toMatchObject({ status: 503 });
  });
  it("scopes membership to the server-verified user and requested organization", async () => {
    await expect(requireTenant("org-a", "create")).resolves.toMatchObject({
      organizationId: "org-a",
      role: "designer",
    });
    await expect(requireTenant("org-b", "read")).rejects.toMatchObject({ status: 403 });
    state.user!.id = "bob";
    await expect(requireTenant("org-a")).rejects.toMatchObject({ status: 403 });
    await expect(requireTenant("org-b", "billing")).resolves.toMatchObject({
      organizationId: "org-b",
      role: "owner",
    });
  });
  it("ignores browser metadata role and forbids assistant writes", async () => {
    await expect(requireTenant("org-a", "billing")).rejects.toMatchObject({
      code: "ROLE_FORBIDDEN",
    });
    state.memberships[0].role = "assistant";
    await expect(requireTenant("org-a", "create")).rejects.toMatchObject({ status: 403 });
    await expect(requireTenant("org-a", "read")).resolves.toMatchObject({ role: "assistant" });
  });
  it("requires a protected platform_admins record", async () => {
    await expect(requirePlatformAdmin()).rejects.toMatchObject({ code: "ADMIN_FORBIDDEN" });
    state.platformAdmin = true;
    await expect(requirePlatformAdmin()).resolves.toMatchObject({ user: { id: "alice" } });
  });
  it("fails closed if durable rate-limit storage fails or quota is exhausted", async () => {
    state.rateError = { message: "database unavailable" };
    await expect(consumeRateLimit("test")).rejects.toMatchObject({ status: 503 });
    state.rateError = null;
    state.rateData = false;
    await expect(consumeRateLimit("test")).rejects.toMatchObject({ status: 429 });
  });
});
