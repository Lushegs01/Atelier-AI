import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { createContentSecurityPolicy } from "@/server/auth/csp";

export async function proxy(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const protectedPage =
    request.nextUrl.pathname.startsWith("/app") || request.nextUrl.pathname.startsWith("/admin");
  const nonce = randomBytes(18).toString("base64");
  const policy = createContentSecurityPolicy(nonce, process.env.NODE_ENV === "production", url);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);
  const next = () => {
    const result = NextResponse.next({ request: { headers: requestHeaders } });
    result.headers.set("Content-Security-Policy", policy);
    result.headers.set("Cache-Control", "private, no-store");
    return result;
  };
  if (!url || !key) {
    if (process.env.NODE_ENV === "production" && protectedPage) {
      return NextResponse.json({ error: "Authentication is not configured." }, { status: 503 });
    }
    return next();
  }
  if (!protectedPage && !request.nextUrl.pathname.startsWith("/auth")) return next();
  let response = next();
  const client = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookies) => {
        cookies.forEach(({ name, value }) => request.cookies.set(name, value));
        requestHeaders.set("cookie", request.headers.get("cookie") || "");
        response = next();
        cookies.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user && protectedPage) {
    const target = request.nextUrl.clone();
    target.pathname = "/login";
    target.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(target);
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: [
    "/app/:path*",
    "/admin/:path*",
    "/auth/:path*",
    "/try/:path*",
    "/login",
    "/signup",
    "/forgot-password",
    "/reset-password",
  ],
};
