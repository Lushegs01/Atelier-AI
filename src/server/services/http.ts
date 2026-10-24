import "server-only";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ApiError, assertSameOrigin } from "@/server/auth/security";
import { MediaValidationError } from "@/server/storage/validation";
import { BillingError } from "@/server/billing/domain";
import { getServerEnv } from "@/lib/env";

export async function route(request: Request, handler: () => Promise<unknown>, mutation = false) {
  try {
    if (mutation) assertSameOrigin(request);
    const result = await handler();
    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (error) {
    if (error instanceof ZodError)
      return NextResponse.json(
        {
          error: "Please check the submitted values.",
          code: "INVALID_INPUT",
          fields: error.issues.map((issue) => issue.path.join(".")),
        },
        { status: 422, headers: { "Cache-Control": "no-store" } },
      );
    if (error instanceof ApiError)
      return NextResponse.json(
        { error: error.message, code: error.code },
        {
          status: error.status,
          headers: {
            "Cache-Control": "no-store",
            ...(error.status === 429 ? { "Retry-After": "60" } : {}),
          },
        },
      );
    if (error instanceof BillingError)
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status, headers: { "Cache-Control": "no-store" } },
      );
    if (error instanceof MediaValidationError)
      return NextResponse.json(
        { error: error.message, code: "INVALID_MEDIA" },
        { status: 422, headers: { "Cache-Control": "no-store" } },
      );
    const safeBillingErrors: Record<string, { status: number; code: string }> = {
      "Insufficient credits": { status: 402, code: "INSUFFICIENT_CREDITS" },
      "Pricing is awaiting review. This operation is unavailable.": {
        status: 503,
        code: "PRICING_UNAVAILABLE",
      },
      "Payment provider is not configured.": { status: 503, code: "PAYMENT_UNAVAILABLE" },
      "Credit package is unavailable.": { status: 404, code: "PACKAGE_UNAVAILABLE" },
      "Daily spending limit reached": { status: 429, code: "SPENDING_LIMIT" },
      "Too many active generations": { status: 429, code: "GENERATION_LIMIT" },
      "Try-on session unavailable": { status: 409, code: "SESSION_UNAVAILABLE" },
    };
    const known = error instanceof Error ? safeBillingErrors[error.message] : undefined;
    if (known && error instanceof Error)
      return NextResponse.json(
        { error: error.message, code: known.code },
        { status: known.status, headers: { "Cache-Control": "no-store" } },
      );
    // Provider/database errors can contain signed URLs or personal data: never echo them.
    console.error(
      JSON.stringify({
        level: "error",
        event: "api_request_failed",
        route: new URL(request.url).pathname.split("/").slice(0, 3).join("/"),
        type: error instanceof Error ? error.name : "unknown",
      }),
    );
    return NextResponse.json(
      { error: "This request could not be completed. Please try again.", code: "INTERNAL_ERROR" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function readJson(request: Request) {
  const text = (await readBoundedRequest(request, 64 * 1024)).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, "A valid JSON body is required.", "INVALID_JSON");
  }
}

export async function readBoundedRequest(request: Request, maxBytes: number) {
  if (Number(request.headers.get("content-length") || 0) > maxBytes)
    throw new ApiError(413, "The request is too large.", "BODY_TOO_LARGE");
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new ApiError(413, "The request is too large.", "BODY_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

export function assertDatabaseResult(error: unknown) {
  if (error)
    throw new ApiError(503, "Your data could not be saved. Please try again.", "DATABASE_ERROR");
}

export async function readImageForm(request: Request) {
  const maxBytes = getServerEnv().MAX_UPLOAD_BYTES;
  if (Number(request.headers.get("content-length") || 0) > maxBytes + 65536)
    throw new ApiError(413, "This upload is too large.", "UPLOAD_TOO_LARGE");
  const body = await readBoundedRequest(request, maxBytes + 65536);
  const form = await new Response(body, {
    headers: { "Content-Type": request.headers.get("content-type") || "" },
  }).formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0)
    throw new ApiError(422, "Choose a photograph to upload.", "FILE_REQUIRED");
  if (file.size > maxBytes)
    throw new ApiError(413, "This photograph exceeds the upload limit.", "UPLOAD_TOO_LARGE");
  return { form, file };
}
