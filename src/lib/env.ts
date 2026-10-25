import { z } from "zod";

const flag = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");
const space = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/)
  .optional();
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  NEXT_PUBLIC_APP_URL: z.url().default("http://localhost:3000"),
  NEXT_PUBLIC_SUPABASE_URL: z.url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
  FASHN_API_KEY: z.string().min(8).optional(),
  AI_PROVIDER: z.enum(["qwen", "fashn", "huggingface"]).default("qwen"),
  HF_TOKEN: z.string().min(8).optional(),
  HF_PHOTO_SPACE: space,
  HF_TRY_ON_SPACE: space,
  HF_VIDEO_SPACE: space,
  QWEN_API_URL: z.url().optional(),
  QWEN_API_KEY: z.string().min(32).optional(),
  QWEN_ALLOW_INSECURE_LOCAL: flag,
  PAYSTACK_SECRET_KEY: z.string().min(8).optional(),
  NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY: z.string().optional(),
  ALLOW_LIVE_PAYMENTS: flag,
  ENABLE_PHOTO_GENERATION: flag,
  ENABLE_TRY_ON: flag,
  ENABLE_VIDEO_GENERATION: flag,
  NEXT_PUBLIC_DEMO_MODE: flag,
  INNGEST_EVENT_KEY: z.string().optional(),
  INNGEST_SIGNING_KEY: z.string().optional(),
  INNGEST_DEV: z.enum(["0", "1"]).optional(),
  STORAGE_BUCKET: z.string().default("private-media"),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(30 * 1024 * 1024)
    .default(4194304),
  MAX_IMAGE_PIXELS: z.coerce.number().int().positive().max(100000000).default(40000000),
  CUSTOMER_PHOTO_RETENTION_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  FASHN_OUTPUT_HOSTS: z.string().default("cdn.fashn.ai"),
  SENTRY_DSN: z.url().optional(),
  CRON_SECRET: z.string().min(32).optional(),
  SUPPORT_EMAIL: z.email().optional(),
});

export function parseEnvironment(input: Record<string, string | undefined>) {
  return schema.parse(Object.fromEntries(Object.entries(input).filter(([, v]) => v !== "")));
}
export function getServerEnv() {
  return parseEnvironment(process.env);
}

export function environmentReadiness(input: Record<string, string | undefined> = process.env) {
  const parsed = schema.safeParse(
    Object.fromEntries(Object.entries(input).filter(([, v]) => v !== "")),
  );
  if (!parsed.success)
    return { ready: false, missing: parsed.error.issues.map((i) => i.path.join(".")) };
  const env = parsed.data;
  const missing = (
    [
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "INNGEST_EVENT_KEY",
      "INNGEST_SIGNING_KEY",
    ] as const
  ).filter((key) => !env[key]);
  const extra: string[] = [];
  const aiEnabled = env.ENABLE_PHOTO_GENERATION || env.ENABLE_TRY_ON || env.ENABLE_VIDEO_GENERATION;
  if (aiEnabled && env.AI_PROVIDER === "fashn" && !env.FASHN_API_KEY) extra.push("FASHN_API_KEY");
  if (aiEnabled && env.AI_PROVIDER === "huggingface" && !env.HF_TOKEN) extra.push("HF_TOKEN");
  if (aiEnabled && env.AI_PROVIDER === "qwen") {
    if (!env.QWEN_API_URL) extra.push("QWEN_API_URL");
    if (!env.QWEN_API_KEY) extra.push("QWEN_API_KEY");
    if (env.ENABLE_VIDEO_GENERATION) extra.push("QWEN_VIDEO_UNSUPPORTED");
    if (env.QWEN_API_URL && !env.QWEN_API_URL.startsWith("https://")) {
      const host = new URL(env.QWEN_API_URL).hostname;
      if (
        env.NODE_ENV === "production" ||
        !env.QWEN_ALLOW_INSECURE_LOCAL ||
        !["localhost", "127.0.0.1", "[::1]"].includes(host)
      )
        extra.push("QWEN_HTTPS_ENDPOINT_REQUIRED");
    }
    if (env.QWEN_API_URL) {
      const endpoint = new URL(env.QWEN_API_URL);
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
        extra.push("QWEN_ENDPOINT_INVALID");
    }
  }
  if (env.NODE_ENV === "production" && env.NEXT_PUBLIC_DEMO_MODE)
    extra.push("DEMO_MODE_MUST_BE_DISABLED");
  if (env.NODE_ENV === "production" && !env.NEXT_PUBLIC_APP_URL.startsWith("https://"))
    extra.push("HTTPS_APP_URL");
  if (env.NODE_ENV === "production" && env.INNGEST_DEV === "1")
    extra.push("INNGEST_DEV_MUST_BE_DISABLED");
  if (env.PAYSTACK_SECRET_KEY?.startsWith("sk_live_") && !env.ALLOW_LIVE_PAYMENTS)
    extra.push("LIVE_PAYMENTS_REQUIRE_EXPLICIT_ENABLEMENT");
  return { ready: missing.length + extra.length === 0, missing: [...missing, ...extra] };
}
