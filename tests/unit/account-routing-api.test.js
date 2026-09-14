import { describe, it, expect } from "vitest";

describe("account-routing model & provider resolution logic", () => {
  function pickModelList(providerId, connections, customModels = [], modelAliases = {}, node = null) {
    const ids = new Set();
    const prefix = node?.prefix;
    const alias = providerId;

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

    for (const [, target] of Object.entries(modelAliases || {})) {
      if (typeof target === "string") {
        if (target.startsWith(`${providerId}/`)) ids.add(target.slice(providerId.length + 1));
        else if (prefix && target.startsWith(`${prefix}/`)) ids.add(target.slice(prefix.length + 1));
      }
    }

    for (const c of connections || []) {
      const psd = c?.providerSpecificData;
      if (Array.isArray(psd?.enabledModels)) {
        psd.enabledModels.forEach((m) => m && ids.add(m));
      }
      if (typeof psd?.defaultModel === "string" && psd.defaultModel.trim()) {
        ids.add(psd.defaultModel.trim());
      }
    }

    return [...ids].sort();
  }

  it("resolves custom models and aliases for custom compatible providers", () => {
    const providerId = "openai-compatible-chat-custom-123";
    const node = { id: providerId, name: "My Custom Provider", prefix: "mycustom" };
    const customModels = [
      { id: "llama-3-70b", providerAlias: "mycustom" },
      { id: "qwen-2.5-72b", providerAlias: providerId },
      { id: "other-model", providerAlias: "other" },
    ];
    const modelAliases = {
      "fast-alias": `${providerId}/deepseek-v3`,
      "prefix-alias": "mycustom/mixtral-8x7b",
    };
    const connections = [
      { provider: providerId, providerSpecificData: { enabledModels: ["conn-model-1"] } },
    ];

    const models = pickModelList(providerId, connections, customModels, modelAliases, node);
    expect(models).toEqual([
      "conn-model-1",
      "deepseek-v3",
      "llama-3-70b",
      "mixtral-8x7b",
      "qwen-2.5-72b",
    ]);
  });

  it("validates routed model ID requirements (mandatory, unique, format)", () => {
    function validate(alias, existingRules = [], currentRuleId = null) {
      const name = String(alias || "").trim();
      if (!name) return "Routed Model ID is required";
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
        return "Routed Model ID may only contain letters, numbers, dots, dashes, underscores";
      }
      if (name.includes("/")) return "Routed Model ID must not contain '/'";

      const duplicate = existingRules.find(
        (r) => r.id !== currentRuleId && String(r.alias || "").trim().toLowerCase() === name.toLowerCase()
      );
      if (duplicate) return "Routed Model ID is already used by another route";
      return null;
    }

    expect(validate("")).toBe("Routed Model ID is required");
    expect(validate("   ")).toBe("Routed Model ID is required");
    expect(validate("invalid/id")).toBe("Routed Model ID may only contain letters, numbers, dots, dashes, underscores");
    expect(validate("valid-model.id_1")).toBeNull();

    const rules = [{ id: "r1", alias: "my-route" }];
    expect(validate("my-route", rules, "r2")).toBe("Routed Model ID is already used by another route");
    expect(validate("MY-ROUTE", rules, "r2")).toBe("Routed Model ID is already used by another route");
    expect(validate("my-route", rules, "r1")).toBeNull();
  });
});
