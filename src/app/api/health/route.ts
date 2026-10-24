import { NextResponse } from "next/server";
export async function GET() {
  return NextResponse.json(
    { status: "ok", service: "atelier-ai", version: "0.1.0" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
