import { createHash, timingSafeEqual, randomBytes } from "node:crypto";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "REQUEST_FAILED",
  ) {
    super(message);
  }
}

export function assertSameOrigin(request: Request, appUrl = process.env.NEXT_PUBLIC_APP_URL) {
  const origin = request.headers.get("origin");
  const expected = new URL(appUrl || request.url).origin;
  if (!origin || origin !== expected || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new ApiError(
      403,
      "This action must be requested from the application.",
      "INVALID_ORIGIN",
    );
  }
}

export function safeRedirect(value: string | null, fallback = "/app") {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\r\n]/.test(value)
  )
    return fallback;
  return value;
}

export function hashToken(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function createGuestToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function validateGuestToken(token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new ApiError(404, "This try-on link is invalid.", "INVALID_LINK");
  return hashToken(token);
}

export function constantTimeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function assertSessionUsable(
  session: {
    expires_at: string;
    revoked_at?: string | null;
    deleted_at?: string | null;
    uses: number;
    max_uses: number;
  },
  forSubmission = false,
) {
  if (session.revoked_at || session.deleted_at)
    throw new ApiError(410, "This try-on link has been revoked.", "LINK_REVOKED");
  if (new Date(session.expires_at).getTime() <= Date.now())
    throw new ApiError(410, "This try-on link has expired.", "LINK_EXPIRED");
  if (forSubmission && session.uses >= session.max_uses)
    throw new ApiError(409, "This try-on session has already been used.", "LINK_EXHAUSTED");
}

export const rolePermissions = {
  owner: ["read", "create", "delete", "billing", "members", "settings"],
  admin: ["read", "create", "delete", "billing", "members", "settings"],
  designer: ["read", "create"],
  assistant: ["read"],
} as const;
export type Role = keyof typeof rolePermissions;
export type Permission = "read" | "create" | "delete" | "billing" | "members" | "settings";
export function hasPermission(role: string, permission: Permission) {
  return (
    role in rolePermissions &&
    (rolePermissions[role as Role] as readonly string[]).includes(permission)
  );
}
