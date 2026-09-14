import { NextResponse } from "next/server";
import {
  getSettings,
  updateSettings,
  getProviderConnections,
  getProviderNodes,
  getCustomModels,
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

function pickProviderList(connections, nodeMap = new Map()) {
  // Providers that actually have connections, ordered by count desc then name.
  const byProvider = new Map();
  for (const c of connections || []) {
    const entry = byProvider.get(c.provider) || { provider: c.provider, count: 0 };
    entry.count += 1;
    byProvider.set(c.provider, entry);
  }
  return [...byProvider.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    const nameA = nodeMap.get(a.provider)?.name || AI_PROVIDERS[a.provider]?.name || a.provider;
    const nameB = nodeMap.get(b.provider)?.name || AI_PROVIDERS[b.provider]?.name || b.provider;
    return nameA.localeCompare(nameB);
  });
}

function pickModelList(providerId, connections, customModels = [], modelAliases = {}, node = null) {
  // Models the provider actually exposes across static catalog, custom models, aliases, and connection data.
  const ids = new Set();
  const prefix = node?.prefix;
  const alias = AI_PROVIDERS[providerId]?.alias || providerId;

  // 1. Static catalog models
  for (const m of getModelsByProviderId(providerId) || []) {
    if (m?.id) ids.add(m.id);
  }

  // 2. Custom models registered in DB (matches providerId, node prefix, or alias)
  for (const m of customModels || []) {
    if (
      m?.id &&
      (m.providerAlias === providerId ||
        (prefix && m.providerAlias === prefix) ||
        (alias && m.providerAlias === alias))
    ) {
      ids.add(m.id);
    }
  }

  // 3. Model aliases in KV
  for (const [, target] of Object.entries(modelAliases || {})) {
    if (typeof target === "string") {
      if (target.startsWith(`${providerId}/`)) ids.add(target.slice(providerId.length + 1));
      else if (prefix && target.startsWith(`${prefix}/`)) ids.add(target.slice(prefix.length + 1));
      else if (alias && target.startsWith(`${alias}/`)) ids.add(target.slice(alias.length + 1));
    }
  }

  // 4. Connection metadata (enabledModels, models array, defaultModel)
  for (const c of connections || []) {
    const psd = c?.providerSpecificData;
    if (Array.isArray(psd?.enabledModels)) {
      psd.enabledModels.forEach((m) => m && ids.add(m));
    }
    if (Array.isArray(c?.models)) {
      c.models.forEach((m) => m && ids.add(m));
    }
    if (Array.isArray(psd?.models)) {
      psd.models.forEach((m) => m && ids.add(m));
    }
    if (typeof psd?.defaultModel === "string" && psd.defaultModel.trim()) {
      ids.add(psd.defaultModel.trim());
    }
    if (typeof c?.defaultModel === "string" && c.defaultModel.trim()) {
      ids.add(c.defaultModel.trim());
    }
  }

  return [...ids].sort();
}

/** A route alias (routed model id) must be non-empty, unique, and not shadow combos, other routes, or reserved provider prefixes. */
async function validateRouteAlias(alias, target, rules, ruleId) {
  const name = String(alias || "").trim();
  if (!name) return "Routed Model ID is required";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    return "Routed Model ID may only contain letters, numbers, dots, dashes, underscores";
  }
  if (name.includes("/")) return "Routed Model ID must not contain '/'";

  const [aliases, combos] = await Promise.all([getModelAliases(), getCombos().catch(() => [])]);
  if (combos?.some((c) => c.name?.toLowerCase() === name.toLowerCase())) {
    return `Routed Model ID "${name}" is already a combo name`;
  }

  // Check duplicate across rules being saved (case-insensitive)
  const duplicates = (rules || []).filter(
    (r) => String(r.alias || "").trim().toLowerCase() === name.toLowerCase() && r.id !== ruleId
  );
  if (duplicates.length > 0) {
    return `Routed Model ID "${name}" is already used by another route`;
  }

  const targetModel = `${target.provider}/${target.model}`;
  if (aliases[name] && aliases[name] !== targetModel) {
    const isOtherRoute = (rules || []).some(
      (r) => r.id !== ruleId && String(r.alias || "").trim().toLowerCase() === name.toLowerCase()
    );
    if (isOtherRoute) {
      return `Routed Model ID "${name}" is already used`;
    }
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
    const [settings, connections, nodes, customModels, modelAliases] = await Promise.all([
      getSettings(),
      getProviderConnections({ isActive: true }),
      getProviderNodes().catch(() => []),
      getCustomModels().catch(() => []),
      getModelAliases().catch(() => ({})),
    ]);
    const routing = normalizeRouting(settings.accountRouting);
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));

    // Build the simple pickers: provider -> models, provider -> accounts.
    const providers = pickProviderList(connections, nodeMap).map(({ provider, count }) => {
      const conns = connections.filter((c) => c.provider === provider);
      const node = nodeMap.get(provider);
      const providerInfo = AI_PROVIDERS[provider];
      const name =
        node?.name ||
        providerInfo?.name ||
        conns[0]?.providerSpecificData?.providerName ||
        conns[0]?.providerSpecificData?.nodeName ||
        conns[0]?.name ||
        provider;
      const alias = node?.prefix || providerInfo?.alias || provider;

      return {
        id: provider,
        name,
        alias,
        connectionCount: count,
        models: pickModelList(provider, conns, customModels, modelAliases, node),
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

    // Validate every rule: alias (routed model id) is mandatory and unique
    for (const rule of rules) {
      const alias = String(rule.alias || "").trim();
      if (!alias) {
        return NextResponse.json(
          { error: `Route "${rule.name || rule.id}": Routed Model ID is required` },
          { status: 400 }
        );
      }
      const target = { provider: rule.match?.providers?.[0], model: rule.match?.models?.[0] };
      const problem = await validateRouteAlias(alias, target, rules, rule.id);
      if (problem) {
        return NextResponse.json({ error: `Route "${rule.name || rule.id}": ${problem}` }, { status: 400 });
      }
      rule.alias = alias;
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
