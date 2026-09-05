import { NextResponse } from "next/server";
import {
  getSettings,
  updateSettings,
  getProviderConnections,
  getModelAliases,
  setModelAlias,
  deleteModelAlias,
  getCombos,
} from "@/lib/localDb";
import { explainAccountRouting, normalizeRouting, normalizeRule } from "open-sse/services/accountRouting.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getModelsByProviderId } from "@/shared/constants/models";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const RESPONSE_HEADERS = { "Cache-Control": "no-store" };

function pickProviderList(connections) {
  // Providers that actually have connections, ordered by count desc then name.
  const byProvider = new Map();
  for (const c of connections || []) {
    const entry = byProvider.get(c.provider) || { provider: c.provider, count: 0 };
    entry.count += 1;
    byProvider.set(c.provider, entry);
  }
  return [...byProvider.values()].sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider));
}

function pickModelList(providerId, connections) {
  // Models the provider's connections actually expose. Codex accounts list
  // their entitlements; compatible providers fall back to the static catalog.
  const ids = new Set();
  for (const c of connections || []) {
    const models = c?.providerSpecificData?.enabledModels;
    if (Array.isArray(models)) models.forEach((m) => m && ids.add(m));
  }
  if (ids.size === 0) {
    getModelsByProviderId(providerId).forEach((m) => ids.add(m.id));
  }
  return [...ids].sort();
}

/** A route alias must not shadow an existing model id, combo, alias, or provider prefix. */
async function validateRouteAlias(alias, target, rules) {
  const name = String(alias || "").trim();
  if (!name) return null; // alias optional
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    return "Alias may only contain letters, numbers, dots, dashes, underscores";
  }
  if (name.includes("/")) return "Alias must not contain '/'";

  const [aliases, combos] = await Promise.all([getModelAliases(), getCombos().catch(() => [])]);
  if (combos?.some((c) => c.name === name)) return `Alias "${name}" is already a combo name`;
  const otherRoute = (rules || []).find((r) => r.alias === name);
  const targetModel = `${target.provider}/${target.model}`;
  if (aliases[name] && aliases[name] !== targetModel && !otherRoute) {
    return `Alias "${name}" is already used`;
  }
  // Provider prefixes are reserved (e.g. "cx", "codex", "openai")
  if (AI_PROVIDERS[name]) return `"${name}" is a reserved provider name`;
  return null;
}

/** Keep kv model aliases in sync with route.alias fields (create/update/delete). */
async function syncRouteAliases(nextRules, prevRules) {
  const nextByAlias = new Map();
  for (const rule of nextRules) {
    const alias = String(rule.alias || "").trim();
    if (!alias) continue;
    const provider = rule.match?.providers?.[0];
    const model = rule.match?.models?.[0];
    if (provider && model) nextByAlias.set(alias, `${provider}/${model}`);
  }

  const prevAliases = new Set((prevRules || []).map((r) => String(r.alias || "").trim()).filter(Boolean));

  // Delete aliases removed from routes (only if we own them: they still point at the route's target)
  const aliases = await getModelAliases();
  for (const alias of prevAliases) {
    if (!nextByAlias.has(alias)) {
      await deleteModelAlias(alias).catch(() => {});
    }
  }
  // Upsert current ones
  for (const [alias, target] of nextByAlias.entries()) {
    await setModelAlias(alias, target);
  }
  return nextByAlias;
}

export async function GET() {
  try {
    const [settings, connections] = await Promise.all([
      getSettings(),
      getProviderConnections({ isActive: true }),
    ]);
    const routing = normalizeRouting(settings.accountRouting);

    // Build the simple pickers: provider → models, provider → accounts.
    const providers = pickProviderList(connections).map(({ provider, count }) => {
      const conns = connections.filter((c) => c.provider === provider);
      return {
        id: provider,
        name: AI_PROVIDERS[provider]?.name || provider,
        alias: provider,
        connectionCount: count,
        models: pickModelList(provider, conns),
        accounts: conns.map((c) => ({
          id: c.id,
          name: c.displayName || c.name || c.email || c.id,
          email: c.email || null,
          plan: c.providerSpecificData?.chatgptPlanType || null,
          priority: c.priority ?? null,
          isActive: c.isActive !== false,
        })),
      };
    });

    return NextResponse.json({ accountRouting: routing, providers }, { headers: RESPONSE_HEADERS });
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
    const settings = await getSettings();
    const prevRules = normalizeRouting(settings.accountRouting).rules;
    const routing = normalizeRouting(body.accountRouting);
    const rules = routing.rules.map((r) => normalizeRule(r));

    // Validate every rule that requests a callable alias
    for (const rule of rules) {
      if (!rule.alias) continue;
      const target = { provider: rule.match?.providers?.[0], model: rule.match?.models?.[0] };
      const problem = await validateRouteAlias(rule.alias, target, rules);
      if (problem) {
        return NextResponse.json({ error: `Route "${rule.name || rule.id}": ${problem}` }, { status: 400 });
      }
    }

    routing.rules = rules;
    await updateSettings({ accountRouting: routing });
    await syncRouteAliases(rules, prevRules);

    return NextResponse.json({ accountRouting: routing }, { headers: RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error saving account routing:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    // Dry-run: which accounts would serve this provider+model, and why.
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
