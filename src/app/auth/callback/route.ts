import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { safeRedirect } from "@/server/auth/security";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = new URL(process.env.NEXT_PUBLIC_APP_URL || request.url).origin;
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");
  try {
    const client = await createServerSupabaseClient();
    if (code) {
      const { error } = await client.auth.exchangeCodeForSession(code);
      if (!error)
        return NextResponse.redirect(new URL(safeRedirect(url.searchParams.get("next")), origin));
    } else if (tokenHash && (type === "email" || type === "recovery" || type === "signup")) {
      const { error } = await client.auth.verifyOtp({ token_hash: tokenHash, type });
      if (!error)
        return NextResponse.redirect(
          new URL(
            type === "recovery" ? "/reset-password" : safeRedirect(url.searchParams.get("next")),
            origin,
          ),
        );
    }
  } catch {
    /* A safe user-facing login state handles configuration / expired links. */
  }
  return NextResponse.redirect(new URL("/login?error=link-expired", origin));
}
