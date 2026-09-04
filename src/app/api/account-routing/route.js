import { NextResponse } from "next/server";
import { getSettings, updateSettings, getProviderConnections } from "@/lib/localDb";
import {
  normalizeRouting,
  explainAccountRouting,
} from "open-sse/services/accountRouting.js";
import { ROUTING_PRESETS, ACCOUNT_FIELDS, MATCH_OPERATORS, ROUTING_STRATEGIES } from "open-sse/config/accountRoutingConfig.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const RESPONSE_HEADERS = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    const settings = await getSettings();
    const routing = normalizeRouting(settings.accountRouting);
    return NextResponse.json(
      {
        accountRouting: routing,
        meta: {
          presets: ROUTING_PRESETS,
          fields: Object.entries(ACCOUNT_FIELDS).map(([id, f]) => ({ id, label: f.label })),
          operators: Object.entries(MATCH_OPERATORS).map(([id, o]) => ({ id, label: o.label, arity: o.arity })),
          strategies: Object.entries(ROUTING_STRATEGIES).map(([id, s]) => ({ id, label: s.label })),
        },
      },
      { headers: RESPONSE_HEADERS }
    );
  } catch (error) {
    console.log("Error getting account routing:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || !("accountRouting" in body)) {
      return NextResponse.json({ error: "Body must contain 'accountRouting'" }, { status: 400 });
    }
    const routing = normalizeRouting(body.accountRouting);
    await updateSettings({ accountRouting: routing });
    return NextResponse.json({ accountRouting: routing }, { headers: RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error saving account routing:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    // Dry-run: explain which accounts would serve a provider+model, and why.
    const { provider, model } = await request.json();
    if (!provider) {
      return NextResponse.json({ error: "'provider' is required" }, { status: 400 });
    }
    const [settings, connections] = await Promise.all([
      getSettings(),
      getProviderConnections({ provider, isActive: true }),
    ]);
    const explanation = explainAccountRouting({
      connections,
      providerId: provider,
      model: model || null,
      routing: settings.accountRouting,
    });
    return NextResponse.json(explanation, { headers: RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error explaining account routing:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
