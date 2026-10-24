export function createContentSecurityPolicy(
  nonce: string,
  production: boolean,
  supabaseUrl?: string,
) {
  let supabase = "";
  try {
    if (supabaseUrl) supabase = new URL(supabaseUrl).origin;
  } catch {
    /* Invalid configuration remains blocked by readiness. */
  }
  const websocket = supabase ? supabase.replace(/^http/, "ws") : "";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${production ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    `img-src 'self' blob: data: https://images.unsplash.com ${supabase}`,
    `media-src 'self' blob: ${supabase}`,
    "font-src 'self' data: https://fonts.gstatic.com",
    `connect-src 'self' ${supabase} ${websocket} https://*.ingest.sentry.io${production ? "" : " ws: http://localhost:* http://127.0.0.1:*"}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(production ? ["upgrade-insecure-requests"] : []),
  ]
    .join("; ")
    .replace(/\s{2,}/g, " ");
}
