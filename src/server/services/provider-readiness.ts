import "server-only";
import { z } from "zod";
import { getQwenEndpoint } from "@/server/ai/endpoint";
import { QWEN_MODEL } from "@/server/ai/registry";

/** A bounded, authenticated readiness check never submits inference or returns upstream data. */
export async function probeQwenReadiness(transport: typeof fetch = fetch) {
  try {
    const base = getQwenEndpoint().toString().replace(/\/$/, "");
    const key = process.env.QWEN_API_KEY;
    if (!key || key.length < 32) return { checked: false, ready: false };
    const response = await transport(`${base}/ready`, {
      headers: { Authorization: `Bearer ${key}` },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!response.ok || !response.body) return { checked: true, ready: false };
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4096) {
        await reader.cancel();
        return { checked: true, ready: false };
      }
      parts.push(value);
    }
    const data = z
      .object({ status: z.literal("ready"), ready: z.literal(true), model: z.literal(QWEN_MODEL) })
      .safeParse(JSON.parse(Buffer.concat(parts).toString("utf8")));
    return { checked: true, ready: data.success };
  } catch {
    return { checked: true, ready: false };
  }
}
