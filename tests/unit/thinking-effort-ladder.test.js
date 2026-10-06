import { describe, it, expect } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { effortToThinkingLevel } from "../../open-sse/translator/concerns/thinking.js";
import {
  getThinkingLevels,
  getSelectableThinkingLevels,
  THINKING_EFFORT_LADDER,
} from "../../open-sse/providers/thinkingLevels.js";

// Drive applyThinking with an explicit level via the "model(level)" suffix.
const send = (model, level, provider) => {
  const body = { model: level ? `${model}(${level})` : model, messages: [] };
  applyThinking(undefined, body.model, body, provider);
  return body;
};

// Each native wire shape carries the level somewhere different.
const wireLevel = (body) =>
  body.reasoning_effort
  ?? body.output_config?.effort
  ?? body.params?.reasoning_effort
  ?? body.generationConfig?.thinkingConfig?.thinkingLevel
  ?? body.thinkingConfig?.thinkingLevel
  ?? body.request?.generationConfig?.thinkingConfig?.thinkingLevel;

describe("selectable thinking ladder", () => {
  it("spans low through ultra", () => {
    expect(THINKING_EFFORT_LADDER).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  });

  it("offers the full ladder for every reasoning model", () => {
    const cases = [
      ["gemini", "gemini-3-pro"],
      ["claude", "claude-opus-5"],
      ["openai", "gpt-5.6"],
      ["deepseek", "deepseek-v4-pro"],
      ["kimi", "kimi-k3"],
      ["zai", "glm-5.2"],
      ["step", "step-3.5-flash"],
      ["codex", "gpt-5.6-sol"],
      ["tokenrouter", "deepseek-v4-pro"],
    ];
    for (const [provider, model] of cases) {
      expect(getSelectableThinkingLevels(provider, model)).toEqual(THINKING_EFFORT_LADDER);
    }
  });

  it("agrees with the native set on whether a model can reason at all", () => {
    for (const [provider, model] of [["openai", "gpt-5.6"], ["gemini", "gemini-3-pro"]]) {
      expect(getSelectableThinkingLevels(provider, model) === null)
        .toBe(getThinkingLevels(provider, model) === null);
    }
  });

  it("leaves the native set unwidened — it stays the clamp source", () => {
    // If this ever widens, providers get offered levels their API rejects.
    expect(getThinkingLevels("gemini", "gemini-3-pro")).not.toContain("ultra");
    expect(getThinkingLevels("deepseek", "deepseek-v4-pro")).not.toContain("ultra");
  });
});

describe("ultra is downgraded on the wire, never sent raw", () => {
  it("never leaks raw ultra to a provider that lacks it", () => {
    const cases = [
      ["gemini", "gemini-3-pro"],
      ["claude", "claude-opus-5"],
      ["deepseek", "deepseek-v4-pro"],
      ["zai", "glm-5.2"],
      ["step", "step-3.5-flash"],
      ["tokenrouter", "deepseek-v4-pro"],
      ["codex", "gpt-5.6"],
      ["kimi", "kimi-k3"],
    ];
    for (const [provider, model] of cases) {
      expect(wireLevel(send(model, "ultra", provider))).not.toBe("ultra");
    }
  });

  it("folds onto the top rung each format actually implements", () => {
    expect(effortToThinkingLevel("ultra")).toBe("high");  // gemini tops out at high
    expect(wireLevel(send("gemini-3-pro", "ultra", "gemini"))).toBe("high");
    expect(wireLevel(send("claude-opus-5", "ultra", "claude"))).toBe("max");
    expect(wireLevel(send("deepseek-v4-pro", "ultra", "deepseek"))).toBe("max");
    expect(wireLevel(send("step-3.5-flash", "ultra", "step"))).toBe("high");
  });

  it("leaves ultra intact where it is native (codex sol/terra)", () => {
    expect(wireLevel(send("gpt-5.6-sol", "ultra", "codex"))).toBe("ultra");
  });
});

describe("existing level behaviour is unchanged", () => {
  it("still passes max through untouched on tokenrouter", () => {
    expect(wireLevel(send("deepseek-v4-pro", "max", "tokenrouter"))).toBe("max");
    expect(wireLevel(send("deepseek-v4-pro", "ultra", "tokenrouter"))).toBe("max");
  });

  it("still maps the mid-ladder as before", () => {
    expect(wireLevel(send("gemini-3-pro", "low", "gemini"))).toBe("low");
    expect(wireLevel(send("gemini-3-pro", "high", "gemini"))).toBe("high");
    expect(wireLevel(send("deepseek-v4-pro", "xhigh", "deepseek"))).toBe("max");
    expect(wireLevel(send("deepseek-v4-pro", "low", "deepseek"))).toBe("high");
    expect(wireLevel(send("gpt-5.6", "xhigh", "codex"))).toBe("xhigh");
  });
});
