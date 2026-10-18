import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { PROVIDER_MODELS, getModelTargetFormat } from "../../open-sse/config/providerModels.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";

const MODEL = "muse-spark-1.2-contributor-free";
const PROVIDER = "opencode";

const input = [{
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "Think, then answer: 2 + 2?" }],
}];

describe("OpenCode Free Muse Spark thinking", () => {
  it("translates a conversation hint into a deterministic ses_ session", () => {
    const executor = new OpenCodeExecutor();
    const prepare = (tool, providerSessionId) => executor.prepareRequestCredentials({
      body: { messages: [{ role: "user", content: tool }] },
      credentials: { connectionId: "connection-a", rawHeaders: {} },
      providerSessionId,
    });
    const first = executor.buildHeaders(prepare("first", "conversation-first"), true);
    const second = executor.buildHeaders(prepare("second", "conversation-second"), true);
    // Same conversation → same translated session (deterministic digest).
    const firstAgain = executor.buildHeaders(prepare("first", "conversation-first"), true);

    expect(first["x-opencode-session"]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(first["x-opencode-session"]).not.toBe(second["x-opencode-session"]);
    expect(firstAgain["x-opencode-session"]).toBe(first["x-opencode-session"]);
    expect(first["x-session-id"]).toBe(first["x-opencode-session"]);
    expect(first["x-session-affinity"]).toBe(first["x-opencode-session"]);
    expect(second["x-session-id"]).toBe(second["x-opencode-session"]);
    expect(second["x-session-affinity"]).toBe(second["x-opencode-session"]);
  });

  it("preserves a native ses_ session header verbatim", () => {
    const executor = new OpenCodeExecutor();
    const native = "ses_0123456789abABCDEFGHIJKLMN";
    const credentials = executor.prepareRequestCredentials({
      body: { messages: [{ role: "user", content: "hello" }] },
      credentials: {
        connectionId: "connection-a",
        rawHeaders: { "X-OpenCode-Session": ` ${native} ` },
      },
      providerSessionId: "translated-session",
    });

    expect(executor.buildHeaders(credentials, true)["x-opencode-session"]).toBe(native);
    expect(executor.buildHeaders(credentials, true)["x-session-id"]).toBe(native);
    expect(executor.buildHeaders(credentials, true)["x-session-affinity"]).toBe(native);
  });

  it("uses the v2 OpenCode user agent for free-tier compatibility", () => {
    const executor = new OpenCodeExecutor();
    const V2_UA = "opencode/latest/2.0.26/cli";

    expect(executor.buildHeaders({ rawHeaders: {} }, true)["User-Agent"]).toBe(V2_UA);
    // v1 UAs are rejected upstream with 403 FreeTierError → spoof the v2 client.
    expect(executor.buildHeaders({ rawHeaders: { "user-agent": "opencode/1.18.26" } }, true)["User-Agent"])
      .toBe(V2_UA);
    // A genuine v2 downstream UA is preserved.
    expect(executor.buildHeaders({ rawHeaders: { "user-agent": V2_UA } }, true)["User-Agent"])
      .toBe(V2_UA);
  });

  it("advertises reasoning and the requested model limits", () => {
    expect(PROVIDER_MODELS.oc?.some((model) => model.id === MODEL)).toBe(true);
    expect(PROVIDER_MODELS.oc?.some((model) => model.id === "muse-spark-1.3-contributor-free")).toBe(true);
    for (const m of [MODEL, "muse-spark-1.3-contributor-free", "muse-spark-1.4-contributor-free", "muse-spark-2.0-contributor-free"]) {
      expect(getCapabilitiesForModel(PROVIDER, m)).toMatchObject({
        reasoning: true,
        thinkingFormat: "openai",
        contextWindow: 1048576,
        maxOutput: 131072,
      });
      expect(getCapabilitiesForModel(PROVIDER, `oc/${m}`)).toMatchObject({
        reasoning: true,
        contextWindow: 1048576,
        maxOutput: 131072,
      });
      expect(getThinkingLevels(PROVIDER, m)).toEqual([
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
      ]);
      expect(getModelTargetFormat("oc", m)).toBe(FORMATS.OPENAI_RESPONSES);
      expect(getModelTargetFormat("opencode", m)).toBe(FORMATS.OPENAI_RESPONSES);
      expect(getModelTargetFormat("openrouter", m)).toBeNull();
    }
  });

  it("clamps max to xhigh and emits the Responses reasoning shape", () => {
    const body = {
      input,
      reasoning: { effort: "max" },
      max_tokens: 131072,
    };

    const out = new OpenCodeExecutor().transformRequest(MODEL, body, true, {
      connectionId: "opencode-muse-spark-test",
    });

    expect(out.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.max_output_tokens).toBe(131072);
    expect(out.max_tokens).toBeUndefined();
  });

  it("routes Union Alpha through Anthropic Messages", () => {
    const caps = getCapabilitiesForModel(PROVIDER, "union-alpha");
    expect(caps.vision).toBe(true);
    expect(caps.contextWindow).toBe(262144);
    expect(caps.maxOutput).toBe(131072);

    const executor = new OpenCodeExecutor();

    expect(getModelTargetFormat("oc", "union-alpha")).toBe(FORMATS.CLAUDE);
    const url = executor.buildUrl("union-alpha");
    expect(url).toBe("https://opencode.ai/inference/v1/messages");
    expect(executor.buildHeaders({}, true, url)).toMatchObject({
      "anthropic-version": "2023-06-01",
    });
    expect(executor.buildHeaders({}, true, executor.buildUrl("big-pickle")))
      .not.toHaveProperty("anthropic-version");

    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.CLAUDE,
      "union-alpha",
      { messages: [{ role: "user", content: "ping" }], max_tokens: 1 },
      false,
      {},
      PROVIDER,
    );
    expect(translated).toMatchObject({
      model: "union-alpha",
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
      max_tokens: 1,
    });
  });

  it("leaves the other free models on Chat Completions", () => {
    const executor = new OpenCodeExecutor();
    const body = { messages: [{ role: "user", content: "hi" }], max_tokens: 1024 };
    executor.transformRequest("big-pickle", body, true, {});
    expect(executor.buildUrl("big-pickle")).toBe("https://opencode.ai/inference/v1/chat/completions");
    expect(body.max_tokens).toBe(1024);
    expect(body.max_output_tokens).toBeUndefined();
  });

  it("translates Chat Completions max thinking into a Responses request", () => {
    const body = {
      model: `oc/${MODEL}`,
      messages: [{ role: "user", content: "Think, then answer: 2 + 2?" }],
      reasoning_effort: "max",
      max_tokens: 131072,
    };

    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
      MODEL,
      body,
      true,
      {},
      PROVIDER,
    );
    const out = new OpenCodeExecutor().transformRequest(MODEL, translated, true, {
      connectionId: "opencode-muse-spark-translation-test",
    });

    expect(out.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
    expect(out.max_output_tokens).toBe(131072);
    expect(out.max_tokens).toBeUndefined();
  });

  it("routes muse-spark-1.3-contributor-free and future Muse Spark models to Responses API", () => {
    const executor = new OpenCodeExecutor();
    const futureModel = "muse-spark-1.4-contributor-free";

    for (const m of ["muse-spark-1.3-contributor-free", futureModel]) {
      expect(executor.buildUrl(m)).toBe("https://opencode.ai/inference/v1/responses");
      expect(executor.buildUrl(`${m}(high)`)).toBe("https://opencode.ai/inference/v1/responses");
      expect(getModelTargetFormat("oc", m)).toBe("openai-responses");

      const body = {
        model: `oc/${m}`,
        messages: [{ role: "user", content: "Hello" }],
        reasoning_effort: "high",
        max_tokens: 2048,
      };

      const translated = translateRequest(
        FORMATS.OPENAI,
        FORMATS.OPENAI_RESPONSES,
        m,
        body,
        true,
        {},
        PROVIDER,
      );
      const out = executor.transformRequest(m, translated, true, {
        connectionId: "opencode-muse-spark-13-test",
      });

      expect(out.reasoning).toEqual({ effort: "high", summary: "auto" });
      expect(out.max_output_tokens).toBe(2048);
      expect(out.max_tokens).toBeUndefined();
    }
  });

  it("strips prior-turn reasoning items carrying encrypted_content from input", () => {
    const executor = new OpenCodeExecutor();
    const model = "muse-spark-1.3-contributor-free";
    const body = {
      model,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "say hi" }] },
        {
          type: "reasoning",
          id: "rs_123",
          encrypted_content: "ENC_BLOB_TURN_1",
          summary: [{ type: "summary_text", text: "thinking text" }],
        },
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "shell",
          arguments: JSON.stringify({ command: "echo hi" }),
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "hi",
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "now say bye" }] },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "shell",
            description: "Run shell command",
            parameters: { type: "object" },
          },
        },
      ],
    };

    const out = executor.transformRequest(model, body, true, {});
    expect(out.stream).toBe(true);
    expect(out.store).toBe(false);
    // Prior reasoning items stripped to prevent 400 "reasoning encrypted_content was not issued to this caller"
    expect(out.input.some((item) => item.type === "reasoning")).toBe(false);
    expect(JSON.stringify(out.input)).not.toContain("ENC_BLOB_TURN_1");
    // User message, function_call, function_call_output, and next user message survive
    const types = out.input.map((item) => item.type);
    expect(types).toEqual(["message", "function_call", "function_call_output", "message"]);
    // Tools flattened and empty properties added. The caller's own `shell` clashes
    // with OpenCode's fingerprint tool, so it (and its prior call) travel under an
    // alias while the exact read/shell definitions are appended.
    expect(out.tools.slice(0, 1)).toEqual([
      {
        type: "function",
        name: "shell_client",
        description: "Run shell command",
        parameters: { type: "object", properties: {} },
      },
    ]);
    expect(out.tools.map((t) => t.name)).toEqual(["shell_client", "read", "shell"]);
    expect(out.input.find((item) => item.type === "function_call").name).toBe("shell_client");
  });
});
