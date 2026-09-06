// Regression: upstreams (MiniMax, OpenRouter-backed) reject tools with
// empty/null/non-string/over-length function.description with
// "Invalid value for 'tools.N.function.description'".
// filterToOpenAIFormat must sanitize every tool shape (OpenAI, Claude, Gemini).
import { describe, it, expect } from "vitest";
import { filterToOpenAIFormat } from "../../open-sse/translator/formats/openai.js";

describe("tool description sanitize (tools.N.function.description invalid)", () => {
  it("replaces empty/null/missing description on OpenAI-format tools", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "a", description: "Valid", parameters: { type: "object", properties: {} } } },
        { type: "function", function: { name: "b", description: "", parameters: { type: "object", properties: {} } } },
        { type: "function", function: { name: "c", description: null, parameters: { type: "object", properties: {} } } },
        { type: "function", function: { name: "d", parameters: { type: "object", properties: {} } } },
        { type: "function", function: { name: "e", description: "   ", parameters: { type: "object", properties: {} } } },
      ],
    };
    const out = filterToOpenAIFormat(body);
    expect(out.tools.map((t) => t.function.description)).toEqual([
      "Valid",
      "No description provided",
      "No description provided",
      "No description provided",
      "No description provided",
    ]);
  });

  it("strips control chars and caps over-length descriptions", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "a", description: "line\u0000clean\u0007", parameters: { type: "object", properties: {} } } },
        { type: "function", function: { name: "b", description: "X".repeat(5000), parameters: { type: "object", properties: {} } } },
      ],
    };
    const out = filterToOpenAIFormat(body);
    expect(out.tools[0].function.description).toBe("lineclean");
    expect(out.tools[1].function.description.length).toBe(1024);
  });

  it("sanitizes Claude-format tools before normalization", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "claude_tool", description: "", input_schema: { type: "object", properties: {} } },
      ],
    };
    const out = filterToOpenAIFormat(body);
    expect(out.tools[0].function.description).toBe("No description provided");
  });

  it("sanitizes Gemini-format functionDeclarations before normalization", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { functionDeclarations: [
          { name: "g1", description: "ok", parameters: { type: "object", properties: {} } },
          { name: "g2", parameters: { type: "object", properties: {} } },
        ] },
      ],
    };
    const out = filterToOpenAIFormat(body);
    expect(out.tools.map((t) => t.function.description)).toEqual(["ok", "No description provided"]);
  });

  it("leaves already-valid descriptions untouched", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "a", description: "Get weather for a city", parameters: { type: "object", properties: {} } } },
      ],
    };
    const out = filterToOpenAIFormat(body);
    expect(out.tools[0].function.description).toBe("Get weather for a city");
  });
});
