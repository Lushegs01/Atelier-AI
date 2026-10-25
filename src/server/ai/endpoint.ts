import "server-only";
import { ProviderError } from "./contracts";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Only operator configuration selects a GPU origin; browser input never supplies this URL. */
export function getQwenEndpoint(env: Record<string, string | undefined> = process.env): URL {
  let url: URL;
  try {
    url = new URL(env.QWEN_API_URL || "");
  } catch {
    throw new ProviderError("The private Qwen endpoint is not configured.", "qwen_not_configured");
  }
  const localDevelopment =
    env.NODE_ENV !== "production" &&
    env.QWEN_ALLOW_INSECURE_LOCAL === "true" &&
    LOOPBACK.has(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && localDevelopment)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ProviderError(
      "The Qwen endpoint requires HTTPS. Plain HTTP is permitted only for explicitly enabled local development.",
      "qwen_endpoint_invalid",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

/** Prevents output URL substitution and forwarding the GPU credential to another host/path. */
export function getQwenOutputRequest(
  value: string,
  reference: string,
  env: Record<string, string | undefined> = process.env,
) {
  if (!/^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$/.test(reference))
    throw new ProviderError("Invalid Qwen prediction identifier.", "invalid_prediction");
  const base = getQwenEndpoint(env);
  const expected = new URL(`${base.toString().replace(/\/$/, "")}/v1/jobs/${reference}/output`);
  let actual: URL;
  try {
    actual = new URL(value);
  } catch {
    throw new ProviderError("Untrusted Qwen output URL.", "untrusted_output");
  }
  if (
    actual.toString() !== expected.toString() ||
    actual.username ||
    actual.password ||
    actual.search ||
    actual.hash
  )
    throw new ProviderError("Untrusted Qwen output URL.", "untrusted_output");
  const token = env.QWEN_API_KEY;
  if (!token || token.length < 32)
    throw new ProviderError(
      "The private Qwen service credential is not configured.",
      "qwen_not_configured",
    );
  return { url: actual, headers: { Authorization: `Bearer ${token}` } };
}
