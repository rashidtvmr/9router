import { describe, expect, it } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// Regression: Claude Code sends thinking effort "max" (its top level). When
// 9router routes to an OpenAI-format provider, applyThinking() case "openai"
// must clamp "max"→"xhigh" because OpenAI's reasoning_effort enum has no "max"
// (L.openai caps at "xhigh"). Without the clamp, upstream returns HTTP 400
// "max effort not support". See open-sse/providers/thinkingLevels.js:10.
describe("applyThinking (openai): clamp max effort to xhigh", () => {
  it("client output_config.effort:\"max\" → reasoning_effort:\"xhigh\" (not \"max\")", () => {
    const body = { output_config: { effort: "max" } };
    const out = applyThinking(FORMATS.OPENAI, "gpt-5", body, "openai");
    expect(out.reasoning_effort).toBe("xhigh");
  });

  it("direct reasoning_effort:\"max\" clamped to \"xhigh\"", () => {
    const body = { reasoning_effort: "max" };
    const out = applyThinking(FORMATS.OPENAI, "gpt-5", body, "openai");
    expect(out.reasoning_effort).toBe("xhigh");
  });

  it("\"xhigh\" passes through unchanged (highest valid OpenAI level)", () => {
    const body = { reasoning_effort: "xhigh" };
    const out = applyThinking(FORMATS.OPENAI, "gpt-5", body, "openai");
    expect(out.reasoning_effort).toBe("xhigh");
  });

  it("\"high\" passes through unchanged", () => {
    const body = { reasoning_effort: "high" };
    const out = applyThinking(FORMATS.OPENAI, "gpt-5", body, "openai");
    expect(out.reasoning_effort).toBe("high");
  });

  it("max budget (thinking.budget_tokens:128000) → reasoning_effort:\"xhigh\" (budgetToLevel caps at xhigh)", () => {
    const body = { thinking: { type: "enabled", budget_tokens: 128000 } };
    const out = applyThinking(FORMATS.OPENAI, "gpt-5", body, "openai");
    expect(out.reasoning_effort).toBe("xhigh");
  });
});

// Free-lane regression (probed live through the relay pools): models whose
// native set stops below xhigh must never receive "xhigh" — big-pickle answers
// with 400 'reasoning_effort must be one of "none", "low", "medium" or "high"'
// — and models that do accept max keep it.
describe("applyThinking (openai): clamp to the model's own levels", () => {
  it("big-pickle: \"max\" clamps down to \"high\" (no xhigh in its set)", () => {
    const body = { reasoning_effort: "max" };
    const out = applyThinking(FORMATS.OPENAI, "big-pickle", body, "opencode");
    expect(out.reasoning_effort).toBe("high");
  });

  it("nemotron-3.5-super-vl-free: \"max\" clamps down to \"high\"", () => {
    const body = { reasoning_effort: "max" };
    const out = applyThinking(FORMATS.OPENAI, "nemotron-3.5-super-vl-free", body, "opencode");
    expect(out.reasoning_effort).toBe("high");
  });

  it("glm-5.3-flash-free: \"max\" stays \"max\" (declared on the free lane)", () => {
    const body = { reasoning_effort: "max" };
    const out = applyThinking(FORMATS.OPENAI, "glm-5.3-flash-free", body, "opencode");
    expect(out.reasoning_effort).toBe("max");
  });

  it("deepseek-v4.1-flash-free: \"max\" stays \"max\"", () => {
    const body = { reasoning_effort: "max" };
    const out = applyThinking(FORMATS.OPENAI, "deepseek-v4.1-flash-free", body, "opencode");
    expect(out.reasoning_effort).toBe("max");
  });

  it("never clamps down to \"none\" (that would disable thinking)", () => {
    const body = { reasoning_effort: "low" };
    const out = applyThinking(FORMATS.OPENAI, "deepseek-v4-flash-free", body, "opencode");
    // levels: ["none","high","max"] — "low" must rise to "high", not fall to "none".
    expect(out.reasoning_effort).toBe("high");
  });
});