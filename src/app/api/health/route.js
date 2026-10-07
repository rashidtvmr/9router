import { NextResponse } from "next/server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function GET() {
  // opencode-zen free-tier rotation hit-rate. Process-local counters, so they
  // reset on restart and fragment across workers — fine for the question they
  // answer ("does rotating egress IP recover keyed free-tier errors at all?").
  // recoveryRate is null until the first rotation fires, so an unprobed server
  // is never misread as 0% success. Fail-open: health must never depend on it.
  let opencodeZenRotation = null;
  try {
    const { openCodeZenRotationStats } = await import("open-sse/executors/opencode-zen.js");
    opencodeZenRotation = openCodeZenRotationStats();
  } catch { /* keep health green */ }

  return NextResponse.json({ ok: true, opencodeZenRotation }, { headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
