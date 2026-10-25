import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  assertSameOrigin,
  assertSessionUsable,
  createGuestToken,
  hasPermission,
  hashToken,
  safeRedirect,
  validateGuestToken,
} from "@/server/auth/security";
import { createQuoteToken, verifyQuoteToken, type QuoteContext } from "@/server/services/quotes";
import { createContentSecurityPolicy } from "@/server/auth/csp";

describe("server policy primitives (unit)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("accepts only an exact application origin for mutations", () => {
    const request = (origin?: string, site?: string) =>
      new Request("https://atelier.example/api/garments", {
        headers: { ...(origin ? { origin } : {}), ...(site ? { "sec-fetch-site": site } : {}) },
      });
    expect(() =>
      assertSameOrigin(request("https://atelier.example"), "https://atelier.example"),
    ).not.toThrow();
    for (const origin of [
      undefined,
      "https://attacker.example",
      "https://atelier.example.attacker.example",
      "null",
      "http://atelier.example",
    ])
      expect(() => assertSameOrigin(request(origin), "https://atelier.example")).toThrow(ApiError);
    expect(() =>
      assertSameOrigin(request("https://atelier.example", "cross-site"), "https://atelier.example"),
    ).toThrow(ApiError);
  });

  it("rejects open redirect, backslash and header injection destinations", () => {
    for (const value of [
      "https://attacker.example",
      "//attacker.example",
      "/\\attacker.example",
      "/app\r\nLocation:evil",
    ])
      expect(safeRedirect(value)).toBe("/app");
    expect(safeRedirect("/reset-password")).toBe("/reset-password");
  });

  it("creates high entropy tokens and stores only a one-way hash", () => {
    const first = createGuestToken();
    const second = createGuestToken();
    expect(first.token).toHaveLength(43);
    expect(first.hash).toHaveLength(64);
    expect(first.token).not.toBe(second.token);
    expect(first.hash).not.toContain(first.token);
    expect(validateGuestToken(first.token)).toBe(hashToken(first.token));
    for (const token of ["", "../token", "x".repeat(42), "x".repeat(44), "a".repeat(42) + "/"])
      expect(() => validateGuestToken(token)).toThrow(ApiError);
  });

  it("enforces expiry, revocation, deletion and maximum uses independently", () => {
    const base = { expires_at: new Date(Date.now() + 3600000).toISOString(), uses: 0, max_uses: 1 };
    expect(() => assertSessionUsable(base, true)).not.toThrow();
    expect(() =>
      assertSessionUsable({ ...base, expires_at: new Date(Date.now() - 1).toISOString() }),
    ).toThrow(/expired/);
    expect(() => assertSessionUsable({ ...base, revoked_at: new Date().toISOString() })).toThrow(
      /revoked/,
    );
    expect(() => assertSessionUsable({ ...base, deleted_at: new Date().toISOString() })).toThrow(
      /revoked/,
    );
    expect(() => assertSessionUsable({ ...base, uses: 1 }, true)).toThrow(/already been used/);
    expect(() => assertSessionUsable({ ...base, uses: 1 }, false)).not.toThrow();
  });

  it("uses a fixed least-privilege role matrix", () => {
    expect(hasPermission("owner", "billing")).toBe(true);
    expect(hasPermission("admin", "members")).toBe(true);
    expect(hasPermission("designer", "create")).toBe(true);
    expect(hasPermission("designer", "billing")).toBe(false);
    expect(hasPermission("assistant", "read")).toBe(true);
    expect(hasPermission("assistant", "create")).toBe(false);
    expect(hasPermission("browser-admin", "settings")).toBe(false);
  });

  it("uses a nonce for scripts and never permits eval in production", () => {
    const policy = createContentSecurityPolicy("test-nonce", true, "https://project.supabase.co");
    expect(policy).toContain("script-src 'self' 'nonce-test-nonce' 'strict-dynamic'");
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("https://project.supabase.co");
    expect(createContentSecurityPolicy("development", false)).toContain("unsafe-eval");
  });
});

describe("signed generation price confirmations (unit)", () => {
  const context: QuoteContext = {
    organizationId: "10000000-0000-4000-8000-000000000001",
    actorId: "20000000-0000-4000-8000-000000000001",
    operation: "photo",
    provider: "qwen",
    providerModel: "Qwen/Qwen-Image-Edit-2511",
    garmentId: "30000000-0000-4000-8000-000000000001",
    sourceAssetId: "40000000-0000-4000-8000-000000000001",
    options: { scene: "Studio", resolution: "1k" },
  };
  const quote = { credits: 5, priceRuleId: "50000000-0000-4000-8000-000000000001" };
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("binds the confirmed price to tenant, authenticated actor, inputs and options", () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "unit-test-only-secret-does-not-connect");
    const token = createQuoteToken(context, quote);
    expect(verifyQuoteToken(token, context).credits).toBe(5);
    expect(() =>
      verifyQuoteToken(token, {
        ...context,
        organizationId: "10000000-0000-4000-8000-000000000002",
      }),
    ).toThrow(/settings changed/);
    expect(() =>
      verifyQuoteToken(token, { ...context, actorId: "20000000-0000-4000-8000-000000000002" }),
    ).toThrow(/settings changed/);
    expect(() => verifyQuoteToken(token, { ...context, sourceAssetId: null })).toThrow(
      /settings changed/,
    );
    expect(() =>
      verifyQuoteToken(token, { ...context, provider: "fashn", providerModel: "product-to-model" }),
    ).toThrow(/settings changed/);
    expect(() =>
      verifyQuoteToken(token, { ...context, options: { ...context.options, scene: "Outdoor" } }),
    ).toThrow(/settings changed/);
    const [payload, signature] = token.split(".");
    const tampered = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), credits: 1 }),
    ).toString("base64url");
    expect(() => verifyQuoteToken(`${tampered}.${signature}`, context)).toThrow(/invalid/);
  });

  it("expires confirmations and rejects missing confirmations", () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "unit-test-only-secret-does-not-connect");
    vi.useFakeTimers();
    const token = createQuoteToken(context, quote);
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    expect(() => verifyQuoteToken(token, context)).toThrow(/expired/);
    expect(() => verifyQuoteToken(undefined, context)).toThrow(/Review a current price/);
  });
});
