import { describe, it, expect } from "vitest";
import {
  resolveField,
  evaluateCondition,
  ruleApplies,
  selectRules,
  applyAccountRouting,
  explainAccountRouting,
  respectsEnabledModels,
  normalizeRouting,
} from "open-sse/services/accountRouting.js";

/**
 * Codex-shaped connections. Plans mirror a real install:
 * free drains first, plus/team are the paid tiers.
 */
function conn(id, plan, extra = {}) {
  return {
    id,
    provider: "codex",
    name: `acct-${id}`,
    email: `${id}@example.com`,
    priority: extra.priority ?? 1,
    lastUsedAt: extra.lastUsedAt ?? null,
    providerSpecificData: {
      chatgptPlanType: plan,
      ...(extra.psd || {}),
    },
    ...(extra.plain || {}),
  };
}

const SOL_ONLY_PLUS = {
  enabled: true,
  rules: [
    {
      id: "r1",
      name: "sol → paid",
      match: { providers: ["codex"], models: ["gpt-5.6-sol"] },
      select: { include: [{ field: "plan", op: "in", value: ["plus", "team", "pro", "business", "enterprise"] }] },
    },
  ],
};

const LUNA_PREFER_FREE = {
  enabled: true,
  rules: [
    {
      id: "r2",
      name: "luna → prefer free",
      match: { providers: ["codex"], models: ["gpt-5.6-luna"] },
      order: { prefer: [{ field: "plan", op: "eq", value: "free" }] },
    },
  ],
};

describe("accountRouting: field resolution", () => {
  it("resolves plan from providerSpecificData.chatgptPlanType", () => {
    expect(resolveField(conn("a", "plus"), "plan")).toBe("plus");
  });

  it("resolves emailDomain with the domain transform", () => {
    expect(resolveField(conn("a", "free"), "emailDomain")).toBe("example.com");
  });

  it("resolves arbitrary psd.* paths without registration", () => {
    const c = conn("a", "plus", { psd: { customFlag: "x" } });
    expect(resolveField(c, "psd.customFlag")).toBe("x");
  });
});

describe("accountRouting: conditions", () => {
  const c = conn("a", "plus", { psd: { tags: ["paid", "fast"] } });

  it("supports eq/neq case-insensitively", () => {
    expect(evaluateCondition(c, { field: "plan", op: "eq", value: "PLUS" })).toBe(true);
    expect(evaluateCondition(c, { field: "plan", op: "neq", value: "free" })).toBe(true);
  });

  it("supports in/nin over scalar and array actuals", () => {
    expect(evaluateCondition(c, { field: "plan", op: "in", value: ["plus", "team"] })).toBe(true);
    expect(evaluateCondition(c, { field: "plan", op: "nin", value: ["free", "go"] })).toBe(true);
    expect(evaluateCondition(c, { field: "tag", op: "in", value: ["paid"] })).toBe(true);
  });

  it("supports glob patterns for models and ids", () => {
    expect(evaluateCondition(c, { field: "id", op: "glob", value: "a*" })).toBe(true);
    expect(evaluateCondition(c, { field: "name", op: "glob", value: "acct-?" })).toBe(true);
  });

  it("supports numeric comparisons on priority", () => {
    expect(evaluateCondition(c, { field: "priority", op: "lte", value: 3 })).toBe(true);
    expect(evaluateCondition(c, { field: "priority", op: "gt", value: 3 })).toBe(false);
  });

  it("fails closed on unknown operator", () => {
    expect(evaluateCondition(c, { field: "plan", op: "bogus", value: "plus" })).toBe(false);
  });

  it("unknown plan fails closed for plan filters", () => {
    const unknown = conn("u", undefined);
    expect(evaluateCondition(unknown, { field: "plan", op: "in", value: ["plus", "team"] })).toBe(false);
    // explicit emptiness checks still work for unknown plans
    expect(evaluateCondition(unknown, { field: "plan", op: "empty" })).toBe(true);
  });
});

describe("accountRouting: rule matching", () => {
  it("applies by provider + model glob, bare or qualified", () => {
    expect(ruleApplies(SOL_ONLY_PLUS.rules[0], "codex", "gpt-5.6-sol")).toBe(true);
    expect(ruleApplies(SOL_ONLY_PLUS.rules[0], "codex", "gpt-5.6-sol-thinking")).toBe(false);
    expect(ruleApplies({ ...SOL_ONLY_PLUS.rules[0], match: { providers: ["codex"], models: ["gpt-5.6-*"] } }, "codex", "gpt-5.6-terra")).toBe(true);
    expect(ruleApplies(SOL_ONLY_PLUS.rules[0], "kimi", "gpt-5.6-sol")).toBe(false);
  });

  it("skips disabled rules", () => {
    expect(selectRules({ enabled: true, rules: [{ ...SOL_ONLY_PLUS.rules[0], enabled: false }] }, "codex", "gpt-5.6-sol")).toHaveLength(0);
  });

  it("returns no rules when routing disabled", () => {
    expect(selectRules({ enabled: false, rules: SOL_ONLY_PLUS.rules }, "codex", "gpt-5.6-sol")).toHaveLength(0);
  });

  it("honors stopOnMatch and priority ordering", () => {
    const rules = [
      { id: "late", name: "late", priority: 50, stopOnMatch: true, match: { providers: ["codex"], models: ["*"] }, select: {}, order: {}, onEmpty: "fallthrough" },
      { id: "early", name: "early", priority: 10, stopOnMatch: false, match: { providers: ["codex"], models: ["gpt-5.6-sol"] }, select: {}, order: {}, onEmpty: "fallthrough" },
      { id: "never", name: "never", priority: 60, match: { providers: ["codex"], models: ["gpt-5.6-sol"] }, select: {}, order: {}, onEmpty: "fallthrough" },
    ];
    const picked = selectRules({ enabled: true, rules }, "codex", "gpt-5.6-sol");
    expect(picked.map((r) => r.id)).toEqual(["early", "late"]);
  });

  it("model-agnostic rules apply when no model in context", () => {
    expect(ruleApplies({ match: { providers: ["codex"], models: [] } }, "codex", null)).toBe(true);
    expect(ruleApplies(SOL_ONLY_PLUS.rules[0], "codex", null)).toBe(false);
  });
});

describe("accountRouting: enabledModels allowlist", () => {
  it("list constrains, empty or missing means all", () => {
    const all = conn("a", "plus");
    const restricted = conn("b", "plus", { psd: { enabledModels: ["gpt-5.6-luna"] } });
    expect(respectsEnabledModels(all, "gpt-5.6-sol")).toBe(true);
    expect(respectsEnabledModels(restricted, "gpt-5.6-luna")).toBe(true);
    expect(respectsEnabledModels(restricted, "gpt-5.6-sol")).toBe(false);
  });

  it("matches qualified model ids against bare entries", () => {
    const c = conn("a", "plus", { psd: { enabledModels: ["gpt-5.6-sol"] } });
    expect(respectsEnabledModels(c, "codex/gpt-5.6-sol")).toBe(true);
  });
});

describe("accountRouting: selection (the codex case)", () => {
  const accounts = [
    conn("free1", "free", { priority: 1 }),
    conn("free2", "free", { priority: 2 }),
    conn("plus1", "plus", { priority: 3 }),
    conn("plus2", "team", { priority: 4 }),
    conn("unknown", undefined, { priority: 5 }),
  ];

  it("sol routes to paid accounts only", () => {
    const out = applyAccountRouting({ connections: accounts, providerId: "codex", model: "gpt-5.6-sol", routing: SOL_ONLY_PLUS });
    expect(out.blocked).toBe(false);
    expect(out.connections.map((c) => c.id)).toEqual(["plus1", "plus2"]);
    expect(out.reason).toContain("2/5 accounts");
  });

  it("luna keeps all accounts but drains free first", () => {
    const out = applyAccountRouting({ connections: accounts, providerId: "codex", model: "gpt-5.6-luna", routing: LUNA_PREFER_FREE });
    expect(out.connections.map((c) => c.id).slice(0, 2)).toEqual(["free1", "free2"]);
    expect(out.connections).toHaveLength(5);
    expect(out.preferredIds).toEqual(["free1", "free2"]);
    expect(out.fallbackIds).toEqual(["plus1", "plus2", "unknown"]);
  });

  it("unknown models fall through to all accounts when no rule matches", () => {
    const out = applyAccountRouting({ connections: accounts, providerId: "codex", model: "gpt-5.5", routing: SOL_ONLY_PLUS });
    expect(out.connections).toHaveLength(5);
    expect(out.applied).toHaveLength(0);
  });

  it("onEmpty:error fails the request instead of widening", () => {
    const strict = {
      enabled: true,
      rules: [{ ...SOL_ONLY_PLUS.rules[0], onEmpty: "error" }],
    };
    const onlyFree = [conn("f", "free")];
    const out = applyAccountRouting({ connections: onlyFree, providerId: "codex", model: "gpt-5.6-sol", routing: strict });
    expect(out.blocked).toBe(true);
    expect(out.connections).toHaveLength(0);
    expect(out.reason).toContain("no eligible account");
  });

  it("exclude keeps named accounts away from a model", () => {
    const rules = {
      enabled: true,
      rules: [{
        id: "ex",
        name: "no team on sol",
        match: { providers: ["codex"], models: ["gpt-5.6-sol"] },
        select: { include: [], exclude: [{ field: "plan", op: "eq", value: "team" }] },
      }],
    };
    const out = applyAccountRouting({ connections: accounts, providerId: "codex", model: "gpt-5.6-sol", routing: rules });
    expect(out.connections.map((c) => c.id).sort()).toEqual(["free1", "free2", "plus1", "unknown"].sort());
  });

  it("per-account enabledModels combine with plan rules", () => {
    const pinned = conn("p", "plus", { psd: { enabledModels: ["gpt-5.6-sol"] } });
    const accounts2 = [pinned, accounts[0], accounts[2]];
    const out = applyAccountRouting({ connections: accounts2, providerId: "codex", model: "gpt-5.6-sol", routing: SOL_ONLY_PLUS });
    expect(out.connections.map((c) => c.id)).toEqual(["p", "plus1"]);
  });

  it("rule can override strategy and sticky limit", () => {
    const rules = {
      enabled: true,
      rules: [{
        id: "s",
        name: "sol round robin fast",
        match: { providers: ["codex"], models: ["gpt-5.6-sol"] },
        select: { include: [{ field: "plan", op: "in", value: ["plus", "team"] }] },
        order: { prefer: [], strategy: "round-robin", stickyLimit: 1 },
      }],
    };
    const out = applyAccountRouting({ connections: accounts, providerId: "codex", model: "gpt-5.6-sol", routing: rules });
    expect(out.strategy).toBe("round-robin");
    expect(out.stickyLimit).toBe(1);
  });
});

describe("accountRouting: explain (dashboard dry-run)", () => {
  it("names eligible accounts and applied rules", () => {
    const accounts = [conn("free1", "free"), conn("plus1", "plus")];
    const out = explainAccountRouting({ connections: accounts, providerId: "codex", model: "gpt-5.6-sol", routing: SOL_ONLY_PLUS });
    expect(out.eligible.map((e) => e.id)).toEqual(["plus1"]);
    expect(out.appliedRules[0].id).toBe("r1");
    expect(out.eligible[0].plan).toBe("plus");
  });

  it("never throws on garbage input", () => {
    expect(() => explainAccountRouting({ connections: "junk", providerId: null, model: 42, routing: {} })).not.toThrow();
  });
});

describe("accountRouting: normalization", () => {
  it("fills defaults and survives partial shapes", () => {
    const r = normalizeRouting({ rules: [{ id: "x" }] });
    expect(r.enabled).toBe(true);
    expect(r.rules[0].onEmpty).toBe("fallthrough");
    expect(r.rules[0].match.providers).toEqual([]);
    expect(normalizeRouting(null).rules).toEqual([]);
  });
});

describe("accountRouting: never throws on malformed persisted data", () => {
  const accounts = [conn("a", "plus"), conn("b", "free")];

  it("survives null/garbage rule entries", () => {
    const routing = { enabled: true, rules: [null, "junk", { id: "partial" }] };
    const out = applyAccountRouting({ connections: accounts, providerId: "codex", model: "gpt-5.6-sol", routing });
    expect(out.connections).toHaveLength(2); // partial rule matches nothing, falls through
  });

  it("survives non-object routing, garbage connections, and null models", () => {
    expect(() => applyAccountRouting({ connections: [null, "x"], providerId: "codex", model: null, routing: "junk" })).not.toThrow();
    expect(() => applyAccountRouting({ connections: [null], providerId: null, model: 42, routing: {} })).not.toThrow();
    expect(() => explainAccountRouting({ connections: [null, undefined], providerId: "codex", model: "m", routing: null })).not.toThrow();
  });

  it("a rule with a broken include condition widens to all accounts (fail-open) under fallthrough", () => {
    const routing = {
      enabled: true,
      rules: [{ match: { providers: ["codex"], models: ["*"] }, select: { include: [{ op: "bogus" }] }, onEmpty: "fallthrough" }],
    };
    const out = applyAccountRouting({ connections: accounts, providerId: "codex", model: "gpt-5.6-sol", routing });
    expect(out.connections).toHaveLength(2);
  });
});

describe("accountRouting: wizard pin shape (dashboard writes this)", () => {
  const accounts = [conn("a", "free"), conn("b", "plus"), conn("c", "team")];

  const pin = (ids, model = "gpt-5.6-sol") => ({
    enabled: true,
    rules: [{
      name: model,
      match: { providers: ["codex"], models: [model] },
      select: { include: [{ field: "id", op: "in", value: ids }] },
      onEmpty: "error",
    }],
  });

  it("narrows to exactly the picked connection ids", () => {
    const out = applyAccountRouting({ connections: accounts, providerId: "codex", model: "gpt-5.6-sol", routing: pin(["b", "c"]) });
    expect(out.connections.map((x) => x.id).sort()).toEqual(["b", "c"]);
    expect(out.blocked).toBe(false);
  });

  it("no picked id available → blocked, never widens", () => {
    const out = applyAccountRouting({ connections: accounts, providerId: "codex", model: "gpt-5.6-sol", routing: pin(["zzz"]) });
    expect(out.blocked).toBe(true);
    expect(out.connections).toHaveLength(0);
  });

  it("string (non-array) condition value still pins correctly", () => {
    const out = applyAccountRouting({ connections: accounts, providerId: "codex", model: "gpt-5.6-sol", routing: pin("b") });
    expect(out.connections.map((x) => x.id)).toEqual(["b"]);
  });

  it("two routes for the same model stop at the first (stopOnMatch default)", () => {
    const routing = {
      enabled: true,
      rules: [
        { name: "r1", priority: 10, match: { providers: ["codex"], models: ["gpt-5.6-sol"] }, select: { include: [{ field: "id", op: "in", value: ["a"] }] }, onEmpty: "error" },
        { name: "r2", priority: 20, match: { providers: ["codex"], models: ["gpt-5.6-sol"] }, select: { include: [{ field: "id", op: "in", value: ["b"] }] }, onEmpty: "error" },
      ],
    };
    const out = applyAccountRouting({ connections: accounts, providerId: "codex", model: "gpt-5.6-sol", routing });
    expect(out.applied.map((r) => r.name)).toEqual(["r1"]);
    expect(out.connections.map((x) => x.id)).toEqual(["a"]);
  });
});

describe("accountRouting: enabledModels edge shapes allow all", () => {
  it("string / null enabledModels and null model are vacuously allowed", () => {
    const c1 = conn("a", "plus", { psd: { enabledModels: "gpt-5.6-sol" } }); // string, not array
    const c2 = conn("b", "plus", { psd: { enabledModels: null } });
    expect(respectsEnabledModels(c1, "gpt-5.6-sol")).toBe(true); // non-array = no restriction
    expect(respectsEnabledModels(c2, "anything")).toBe(true);
    const strict = conn("c", "plus", { psd: { enabledModels: ["gpt-5.6-sol"] } });
    expect(respectsEnabledModels(strict, null)).toBe(true); // no model in context (credential probe)
  });
});
