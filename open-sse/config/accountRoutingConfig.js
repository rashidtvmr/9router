/**
 * Account routing config — ALL constants for the custom model→account router.
 *
 * The router answers one question: for a given provider + model, which of the
 * user's accounts (connections) are allowed to serve it, and in what order.
 * Everything the matcher understands is declared here so rules stay data, not code.
 */

/** Rule fields that can be matched on a connection. Dotted `psd.*` paths also work. */
export const ACCOUNT_FIELDS = {
  plan: { path: "providerSpecificData.chatgptPlanType", label: "Plan tier" },
  id: { path: "id", label: "Connection ID" },
  name: { path: "name", label: "Name" },
  displayName: { path: "displayName", label: "Display name" },
  email: { path: "email", label: "Email" },
  emailDomain: { path: "email", label: "Email domain", transform: "domain" },
  provider: { path: "provider", label: "Provider" },
  authType: { path: "authType", label: "Auth type" },
  priority: { path: "priority", label: "Priority" },
  tag: { path: "providerSpecificData.tags", label: "Tag" },
  enabledModels: { path: "providerSpecificData.enabledModels", label: "Enabled models" },
  proxyPoolId: { path: "providerSpecificData.proxyPoolId", label: "Proxy pool" },
  accountId: { path: "providerSpecificData.chatgptAccountId", label: "Upstream account ID" },
};

/** Comparison operators. Each is a pure (actual, expected) predicate. */
export const MATCH_OPERATORS = {
  eq: { label: "is", arity: 1 },
  neq: { label: "is not", arity: 1 },
  in: { label: "is any of", arity: "many" },
  nin: { label: "is none of", arity: "many" },
  contains: { label: "contains", arity: 1 },
  startsWith: { label: "starts with", arity: 1 },
  endsWith: { label: "ends with", arity: 1 },
  glob: { label: "matches pattern", arity: 1 },
  regex: { label: "matches regex", arity: 1 },
  lt: { label: "less than", arity: 1 },
  lte: { label: "at most", arity: 1 },
  gt: { label: "greater than", arity: 1 },
  gte: { label: "at least", arity: 1 },
  exists: { label: "is set", arity: 0 },
  empty: { label: "is empty", arity: 0 },
};

/** Ordering strategies a rule may impose on its eligible accounts. */
export const ROUTING_STRATEGIES = {
  inherit: { label: "Inherit provider strategy" },
  "fill-first": { label: "Fill first (by priority)" },
  "round-robin": { label: "Round robin" },
  "least-used": { label: "Least recently used" },
  random: { label: "Random" },
  weighted: { label: "Weighted by priority" },
};

/** What to do when a rule leaves zero eligible accounts. */
export const ON_EMPTY_BEHAVIOURS = {
  fallthrough: { label: "Ignore rule (use all accounts)" },
  error: { label: "Fail the request" },
};

/**
 * Known ChatGPT/Codex plan tiers, ordered cheapest→most capable.
 * Used for the plan presets and for the UI plan picker. Unknown plans are
 * allowed as free-text so a new OpenAI tier never blocks the user.
 */
export const CODEX_PLAN_TIERS = ["free", "go", "plus", "business", "team", "pro", "enterprise"];

/** Connections whose plan tier is unknown: refuse when a rule filters on plan. */
export const UNKNOWN_PLAN_ELIGIBLE = false;

/** Default rule scaffold — every persisted rule is normalized to this shape. */
export const DEFAULT_RULE = {
  id: "",
  name: "",
  alias: "",
  enabled: true,
  priority: 100,
  match: { providers: [], models: [], excludeModels: [] },
  select: { include: [], exclude: [] },
  order: { prefer: [], strategy: "inherit", stickyLimit: null, reverse: false },
  onEmpty: "fallthrough",
  stopOnMatch: true,
};

export const DEFAULT_ACCOUNT_ROUTING = { enabled: false, rules: [] };

/**
 * One-click presets. `rules` are partials merged over DEFAULT_RULE.
 * Served by the API for programmatic rule bootstrap; the dashboard wizard
 * writes the simple id-in pin shape directly.
 */
export const ROUTING_PRESETS = {
  "codex-paid-models": {
    label: "Codex: paid-tier models → paid accounts only",
    description: "Restrict a model to Plus/Team/Pro/Business/Enterprise Codex accounts.",
    rule: {
      name: "Paid-tier models → paid accounts",
      match: { providers: ["codex"], models: ["gpt-5.6-sol"] },
      select: { include: [{ field: "plan", op: "in", value: ["plus", "team", "pro", "business", "enterprise"] }] },
    },
  },
  "codex-prefer-free": {
    label: "Codex: cheap models → prefer free accounts",
    description: "Allow every account but drain free ones first, so paid quota is kept in reserve.",
    rule: {
      name: "Cheap models → prefer free accounts",
      match: { providers: ["codex"], models: ["gpt-5.6-luna"] },
      order: { prefer: [{ field: "plan", op: "eq", value: "free" }] },
    },
  },
  "pin-model-to-accounts": {
    label: "Pin a model to specific accounts",
    description: "Only the accounts you list may serve the matched models.",
    rule: {
      name: "Pin model to accounts",
      select: { include: [{ field: "id", op: "in", value: [] }] },
    },
  },
  "exclude-account-from-model": {
    label: "Keep an account away from a model",
    description: "Everything else may serve the model; the listed accounts may not.",
    rule: {
      name: "Exclude accounts from model",
      select: { exclude: [{ field: "id", op: "in", value: [] }] },
    },
  },
};
