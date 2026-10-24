import { NextResponse } from "next/server";
import { handlePaystackWebhook } from "@/server/billing/service";
import { readBoundedRequest } from "@/server/services/http";

export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") || 0) > 1024 * 1024)
    return NextResponse.json({ error: "Request too large." }, { status: 413 });
  const signature = request.headers.get("x-paystack-signature") || "";
  try {
    const rawBody = (await readBoundedRequest(request, 1024 * 1024)).toString("utf8");
    await handlePaystackWebhook(rawBody, signature);
    return NextResponse.json({ received: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    // A non-2xx tells Paystack to retry; invalid signatures never create value.
    return NextResponse.json(
      { error: "Webhook could not be verified or processed." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
