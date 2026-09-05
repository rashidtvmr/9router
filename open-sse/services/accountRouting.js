/**
 * Custom model → account router.
 *
 * Given the connections that are already available for a provider, narrow and
 * order them according to user-defined rules (see `config/accountRoutingConfig.js`).
 * Pure and synchronous: no DB, no fetch, no throwing — the caller owns I/O and
 * decides what to do with the verdict.
 *
 * Typical use: keep a paid-tier-only model (Codex `gpt-5.6-sol`) on Plus/Team
 * accounts, while a cheap model (`gpt-5.6-luna`) may use every account but
 * drains the free ones first.
 */

import {
  ACCOUNT_FIELDS,
  DEFAULT_RULE,
  UNKNOWN_PLAN_ELIGIBLE,
  ROUTING_STRATEGIES,
  ON_EMPTY_BEHAVIOURS,
} from "../config/accountRoutingConfig.js";

/* ------------------------------------------------------------------ values */

function readPath(obj, path) {
  if (!obj || !path) return undefined;
  return String(path).split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

/**
 * Resolve a rule field to a connection value.
 * Known fields come from ACCOUNT_FIELDS; `psd.<key>` reads providerSpecificData
 * directly so a provider-specific value never needs a code change.
 */
export function resolveField(connection, field) {
  if (!connection || !field) return undefined;
  const key = String(field);

  if (key.startsWith("psd.")) {
    return readPath(connection.providerSpecificData, key.slice(4));
  }
  const spec = ACCOUNT_FIELDS[key];
  if (!spec) return readPath(connection, key);

  const value = readPath(connection, spec.path);
  if (spec.transform === "domain" && typeof value === "string") {
    const at = value.lastIndexOf("@");
    return at === -1 ? value.toLowerCase() : value.slice(at + 1).toLowerCase();
  }
  return value;
}

function toComparable(value) {
  return typeof value === "string" ? value.toLowerCase() : value;
}

function toList(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

/** `*` and `?` wildcards; `/re/flags` is treated as a regex. */
function globToRegExp(pattern) {
  const raw = String(pattern);
  const asRegex = raw.match(/^\/(.*)\/([gimsuy]*)$/);
  if (asRegex) {
    try {
      return new RegExp(asRegex[1], asRegex[2].includes("i") ? asRegex[2] : `${asRegex[2]}i`);
    } catch {
      return null;
    }
  }
  const escaped = raw.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  try {
    return new RegExp(`^${escaped}$`, "i");
  } catch {
    return null;
  }
}

/** Operator table. Values are already lowercased for string comparisons. */
const OPERATOR_FNS = {
  eq: (a, b) => toComparable(a) === toComparable(b),
  neq: (a, b) => toComparable(a) !== toComparable(b),
  in: (a, b) => {
    const actual = toList(a).map(toComparable);
    const expected = toList(b).map(toComparable);
    return actual.some((v) => expected.includes(v));
  },
  nin: (a, b) => !OPERATOR_FNS.in(a, b),
  contains: (a, b) => {
    const expected = toComparable(b);
    if (Array.isArray(a)) return a.map(toComparable).includes(expected);
    return String(toComparable(a) ?? "").includes(String(expected ?? ""));
  },
  startsWith: (a, b) => String(toComparable(a) ?? "").startsWith(String(toComparable(b) ?? "")),
  endsWith: (a, b) => String(toComparable(a) ?? "").endsWith(String(toComparable(b) ?? "")),
  glob: (a, b) => {
    const re = globToRegExp(b);
    if (!re) return false;
    return toList(a).some((v) => re.test(String(v ?? "")));
  },
  regex: (a, b) => OPERATOR_FNS.glob(a, String(b).startsWith("/") ? b : `/${b}/`),
  lt: (a, b) => Number(a) < Number(b),
  lte: (a, b) => Number(a) <= Number(b),
  gt: (a, b) => Number(a) > Number(b),
  gte: (a, b) => Number(a) >= Number(b),
  exists: (a) => a !== undefined && a !== null && a !== "" && !(Array.isArray(a) && a.length === 0),
  empty: (a) => !OPERATOR_FNS.exists(a),
};

/**
 * Evaluate one condition against a connection.
 * Unknown operators return false (fail closed) so a malformed rule can never
 * silently widen access.
 */
export function evaluateCondition(connection, condition) {
  if (!condition || typeof condition !== "object" || !condition.field || !condition.op) return false;
  const fn = OPERATOR_FNS[condition.op];
  if (!fn) return false;

  const actual = resolveField(connection, condition.field);

  // A rule that filters on plan must not match accounts with an unknown plan,
  // otherwise a stale/never-refreshed account can burn paid quota.
  if (
    condition.field === "plan" &&
    !UNKNOWN_PLAN_ELIGIBLE &&
    (actual === undefined || actual === null || actual === "") &&
    !["empty", "exists", "neq", "nin"].includes(condition.op)
  ) {
    return false;
  }
  // A regex/glob with no usable pattern can never match — fail closed.
  if (["glob", "regex"].includes(condition.op) && (condition.value === undefined || condition.value === null || String(condition.value) === "")) {
    return false;
  }
  return fn(actual, condition.value);
}

/** All conditions must pass (AND). No conditions → vacuously true. */
export function matchesAll(connection, conditions) {
  const list = Array.isArray(conditions) ? conditions : [];
  return list.every((c) => evaluateCondition(connection, c));
}

/** Any condition passes (OR). No conditions → false. */
export function matchesAny(connection, conditions) {
  const list = Array.isArray(conditions) ? conditions : [];
  return list.some((c) => evaluateCondition(connection, c));
}

/* ------------------------------------------------------------------- rules */

/** Merge a persisted rule over DEFAULT_RULE so partial rules are always safe. Never throws. */
export function normalizeRule(rule = {}) {
  const src = rule && typeof rule === "object" ? rule : {};
  const pick = (obj, key, fallback) => (obj && typeof obj[key] === "object" && obj[key] !== null ? obj[key] : fallback);
  return {
    ...DEFAULT_RULE,
    ...src,
    match: { ...DEFAULT_RULE.match, ...pick(src, "match", {}) },
    select: { ...DEFAULT_RULE.select, ...pick(src, "select", {}) },
    order: { ...DEFAULT_RULE.order, ...pick(src, "order", {}) },
    onEmpty: ON_EMPTY_BEHAVIOURS[src.onEmpty] ? src.onEmpty : DEFAULT_RULE.onEmpty,
  };
}

export function normalizeRouting(routing) {
  const src = routing && typeof routing === "object" ? routing : {};
  const rules = Array.isArray(src.rules) ? src.rules : [];
  return {
    enabled: src.enabled !== false,
    rules: rules.map((r) => normalizeRule(r)),
  };
}

function patternListMatches(patterns, candidates) {
  const list = toList(patterns).filter((p) => typeof p === "string" && p.trim() !== "");
  if (list.length === 0) return null; // no constraint
  return list.some((p) => {
    const re = globToRegExp(p);
    return re ? candidates.some((c) => re.test(String(c ?? ""))) : false;
  });
}

/**
 * Does this rule apply to the given provider + model?
 * Model is matched against the bare id (`gpt-5.6-sol`) and the qualified id
 * (`codex/gpt-5.6-sol`), so either form works in a rule.
 */
export function ruleApplies(rule, providerId, model) {
  const r = normalizeRule(rule);
  if (!r.enabled) return false;

  const providerMatch = patternListMatches(r.match.providers, [providerId]);
  if (providerMatch === false) return false;

  const candidates = [model, providerId && model ? `${providerId}/${model}` : null].filter(Boolean);
  if (candidates.length === 0) {
    // No model in context (e.g. a credential probe): only model-agnostic rules apply.
    return toList(r.match.models).length === 0;
  }
  if (patternListMatches(r.match.excludeModels, candidates) === true) return false;

  const modelMatch = patternListMatches(r.match.models, candidates);
  return modelMatch !== false;
}

/** Applicable rules, lowest `priority` first; `stopOnMatch` truncates the list. */
export function selectRules(routing, providerId, model) {
  const { enabled, rules } = normalizeRouting(routing);
  if (!enabled) return [];

  const applicable = rules
    .filter((r) => ruleApplies(r, providerId, model))
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

  const stopAt = applicable.findIndex((r) => r.stopOnMatch);
  return stopAt === -1 ? applicable : applicable.slice(0, stopAt + 1);
}

/* --------------------------------------------------------------- selection */

/**
 * A connection may declare `providerSpecificData.enabledModels`. When set, it
 * serves only those models. This is the same field the model catalog honours
 * (`src/app/api/v1/models/route.js`), applied here so listing and routing agree.
 */
export function respectsEnabledModels(connection, model) {
  const enabled = connection?.providerSpecificData?.enabledModels;
  if (!Array.isArray(enabled) || enabled.length === 0) return true;
  if (!model) return true;

  const wanted = [model, String(model).split("/").pop()].map((m) => String(m).toLowerCase());
  return enabled.some((entry) => {
    const value = String(entry ?? "").toLowerCase();
    if (!value) return false;
    if (wanted.includes(value)) return true;
    const re = globToRegExp(entry);
    return re ? wanted.some((w) => re.test(w)) : false;
  });
}

/**
 * Apply the router to a set of already-available connections.
 *
 * @param {object}   params
 * @param {object[]} params.connections  Available connections (post lock/exclude filtering).
 * @param {string}   params.providerId
 * @param {string|null} params.model
 * @param {object}   params.routing      `settings.accountRouting`.
 * @returns {{
 *   connections: object[],       // eligible, ordered
 *   applied: object[],           // rules that took effect
 *   strategy: string|null,       // strategy override, null = inherit
 *   stickyLimit: number|null,
 *   blocked: boolean,            // a rule with onEmpty:"error" emptied the set
 *   reason: string|null,         // human-readable explanation
 *   filteredOut: object[],       // connections the router removed
 * }}
 */
export function applyAccountRouting({ connections, providerId, model, routing } = {}) {
  const input = Array.isArray(connections) ? connections : [];
  const result = {
    connections: input,
    applied: [],
    strategy: null,
    stickyLimit: null,
    preferredIds: [],
    fallbackIds: [],
    blocked: false,
    reason: null,
    filteredOut: [],
  };

  // Always-on: a connection's own model allowlist.
  const allowlisted = input.filter((c) => respectsEnabledModels(c, model));
  if (allowlisted.length !== input.length) {
    result.filteredOut.push(...input.filter((c) => !allowlisted.includes(c)));
  }
  if (allowlisted.length === 0 && input.length > 0) {
    return {
      ...result,
      connections: [],
      blocked: true,
      reason: `no account lists "${model}" in its enabled models`,
    };
  }
  result.connections = allowlisted;

  const rules = selectRules(routing, providerId, model);
  if (rules.length === 0) return result;

  for (const rule of rules) {
    const before = result.connections;
    let candidates = before.filter((c) => matchesAll(c, rule.select.include));
    if (rule.select.exclude?.length) {
      candidates = candidates.filter((c) => !matchesAny(c, rule.select.exclude));
    }

    if (candidates.length === 0) {
      if (rule.onEmpty === "error") {
        return {
          ...result,
          connections: [],
          applied: [...result.applied, rule],
          blocked: true,
          reason: `rule "${rule.name || rule.id}" left no eligible account for ${model}`,
          filteredOut: [...result.filteredOut, ...before],
        };
      }
      continue; // fallthrough: rule contributes nothing
    }

    const preferConditions = Array.isArray(rule.order.prefer) ? rule.order.prefer : [];
    if (preferConditions.length > 0) {
      // Soft partition: drain preferred accounts first even under round-robin,
      // so a "prefer free" rule never spends paid quota while a free account is idle.
      const preferredIds = candidates.filter((c) => matchesAny(c, preferConditions)).map((c) => c.id);
      const restIds = candidates.filter((c) => !preferredIds.includes(c.id)).map((c) => c.id);
      result.preferredIds = preferredIds;
      result.fallbackIds = restIds;
      candidates = [
        ...candidates.filter((c) => preferredIds.includes(c.id)),
        ...candidates.filter((c) => restIds.includes(c.id)),
      ];
    }

    result.filteredOut.push(...before.filter((c) => !candidates.includes(c)));
    result.connections = candidates;
    result.applied.push(rule);

    if (rule.order.strategy && rule.order.strategy !== "inherit" && ROUTING_STRATEGIES[rule.order.strategy]) {
      result.strategy = rule.order.strategy;
    }
    if (Number.isFinite(Number(rule.order.stickyLimit)) && Number(rule.order.stickyLimit) > 0) {
      result.stickyLimit = Number(rule.order.stickyLimit);
    }
    if (rule.order.reverse) result.connections = [...result.connections].reverse();
  }

  if (result.applied.length > 0) {
    const names = result.applied.map((r) => r.name || r.id).filter(Boolean).join(", ");
    result.reason = `${result.connections.length}/${input.length} accounts eligible via ${names || "routing rules"}`;
  }
  return result;
}

/**
 * Dry-run helper for the dashboard: which accounts would serve this model, why,
 * and which were dropped. Never throws.
 */
export function explainAccountRouting({ connections, providerId, model, routing } = {}) {
  const outcome = applyAccountRouting({ connections, providerId, model, routing });
  const describe = (c) => {
    const conn = c && typeof c === "object" ? c : {};
    return {
      id: conn.id,
      name: conn.displayName || conn.name || conn.email || conn.id,
      plan: resolveField(conn, "plan") ?? null,
      priority: conn.priority ?? null,
    };
  };
  return {
    model: model || null,
    provider: providerId || null,
    eligible: outcome.connections.map(describe),
    filteredOut: outcome.filteredOut.map(describe),
    appliedRules: outcome.applied.map((r) => ({ id: r.id, name: r.name })),
    strategy: outcome.strategy,
    stickyLimit: outcome.stickyLimit,
    blocked: outcome.blocked,
    reason: outcome.reason,
  };
}
