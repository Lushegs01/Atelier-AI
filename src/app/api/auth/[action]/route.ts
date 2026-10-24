import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasSupabaseConfig } from "@/lib/supabase/admin";
import { ApiError } from "@/server/auth/security";
import { consumeRateLimit, requireUser } from "@/server/auth/context";
import { readJson, route } from "@/server/services/http";
import { hashToken } from "@/server/auth/security";

const emailSchema = z.string().trim().email().max(254).toLowerCase();
const passwordSchema = z.string().min(12, "Use at least 12 characters.").max(128);

export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  return route(
    request,
    async () => {
      if (!hasSupabaseConfig())
        throw new ApiError(
          503,
          "Authentication is not configured. Connect your Supabase project.",
          "NOT_CONFIGURED",
        );
      const { action } = await context.params;
      const client = await createServerSupabaseClient();
      const appUrl = new URL(process.env.NEXT_PUBLIC_APP_URL || request.url).origin;
      if (action === "logout") {
        await client.auth.signOut();
        return { ok: true, redirectTo: "/login" };
      }
      const body = await readJson(request);
      if (action === "reset-password") {
        const { password } = z.object({ password: passwordSchema }).parse(body);
        const { user } = await requireUser();
        await consumeRateLimit(`reset:${user.id}`, 5, 3600);
        const { error } = await client.auth.updateUser({ password });
        if (error)
          throw new ApiError(
            422,
            "The password could not be updated. Request a new reset link.",
            "AUTH_FAILED",
          );
        return { ok: true, redirectTo: "/app" };
      }
      const input = z
        .object({
          email: emailSchema,
          password: z.string().max(128).optional(),
          name: z.string().trim().min(1).max(100).optional(),
          captchaToken: z.string().max(4096).optional(),
        })
        .parse(body);
      await consumeRateLimit(`auth:${action}:${hashToken(input.email)}`, 8, 900);
      // Supabase also applies IP / email limits and optional CAPTCHA at the auth service.
      if (action === "login") {
        if (!input.password) throw new ApiError(422, "Enter your password.", "PASSWORD_REQUIRED");
        const { error } = await client.auth.signInWithPassword({
          email: input.email,
          password: input.password,
          options: { captchaToken: input.captchaToken },
        });
        if (error)
          throw new ApiError(
            401,
            "The email or password is incorrect, or the email is not verified.",
            "AUTH_FAILED",
          );
        return { ok: true, redirectTo: "/app" };
      }
      if (action === "signup") {
        const password = passwordSchema.parse(input.password);
        const { data, error } = await client.auth.signUp({
          email: input.email,
          password,
          options: {
            emailRedirectTo: `${appUrl}/auth/callback`,
            data: { display_name: input.name || "" },
            captchaToken: input.captchaToken,
          },
        });
        if (error)
          throw new ApiError(
            422,
            "The account could not be created. Check your details or try signing in.",
            "AUTH_FAILED",
          );
        return {
          ok: true,
          requiresVerification: !data.session,
          message: "Check your email to verify your account, then create your workspace.",
          redirectTo: data.session ? "/app" : undefined,
        };
      }
      if (action === "forgot-password") {
        await client.auth.resetPasswordForEmail(input.email, {
          redirectTo: `${appUrl}/auth/callback?next=/reset-password`,
          captchaToken: input.captchaToken,
        });
        return {
          ok: true,
          message: "If an account matches this address, a password reset link will arrive shortly.",
        };
      }
      throw new ApiError(404, "This authentication action was not found.", "NOT_FOUND");
    },
    true,
  );
}
