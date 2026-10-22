// Free-lane recovery must replace the spent stable session, try the caller's
// own egress once (relay pools can all be out of quota), then try more than one
// relay for the same request.
import { describe, it, expect } from "vitest";
import { BaseExecutor } from "../../open-sse/executors/base.js";
import {
  OpenCodeExecutor,
  openCodeFreeRotationStats,
  replaceStableSession,
  stableSessionId,
} from "../../open-sse/executors/opencode.js";
import {
  OPENCODE_FREE_SESSION_ROTATION,
  OPENCODE_SESSION_RETRY,
} from "../../open-sse/config/opencodeFreeSession.js";

const FRESH_SESSION = "ses_0123456789abABCDEFGHIJKLMN";

function statsDelta(before, after) {
  return {
    attempts: after.attempts - before.attempts,
    recovered: after.recovered - before.recovered,
    exhausted: after.exhausted - before.exhausted,
    directAttempts: after.directAttempts - before.directAttempts,
    directRecovered: after.directRecovered - before.directRecovered,
    directExhausted: after.directExhausted - before.directExhausted,
  };
}

function freeTier429() {
  return { response: new Response("free tier", { status: 429 }) };
}

describe("opencode free-lane rotation", () => {
  it("replaces the cached stable session", () => {
    const credentials = { rawHeaders: { authorization: "Bearer rotation-session-test" } };
    const original = stableSessionId(credentials);
    const fresh = replaceStableSession(credentials);

    expect(fresh).not.toBe(original);
    expect(stableSessionId(credentials)).toBe(fresh);
  });

  it("tries direct egress before rotating relays, using a fresh session", async () => {
    const originalRotate = OPENCODE_FREE_SESSION_ROTATION.rotateUpstream;
    const originalExecute = BaseExecutor.prototype.execute;
    const originalMax = OPENCODE_SESSION_RETRY.maxAttempts;
    const rotateCalls = [];
    const executeCalls = [];

    try {
      OPENCODE_SESSION_RETRY.maxAttempts = 2;
      OPENCODE_FREE_SESSION_ROTATION.rotateUpstream = async (provider, current) => {
        rotateCalls.push([provider, current]);
        return "https://relay.example/one/";
      };
      BaseExecutor.prototype.execute = async (args) => {
        executeCalls.push(args);
        if (args.proxyOptions?.forceDirect) return freeTier429();
        return { response: new Response("ok", { status: 200 }) };
      };

      const executor = new OpenCodeExecutor();
      const credentials = { rawHeaders: { authorization: "Bearer rotation-direct-fallback-test" } };
      const first = freeTier429();
      const before = openCodeFreeRotationStats();
      const result = await executor._retryOnRotatedEgress(
        {
          model: "glm-5.3-flash-free",
          body: { model: "glm-5.3-flash-free", messages: [] },
          proxyOptions: { vercelRelayUrl: "https://primary.example/" },
          log: null,
        },
        credentials,
        first,
        { model: "glm-5.3-flash-free", messages: [] },
        FRESH_SESSION
      );
      const delta = statsDelta(before, openCodeFreeRotationStats());

      expect(result.response.status).toBe(200);
      expect(executeCalls).toHaveLength(2);
      expect(executeCalls[0].proxyOptions.forceDirect).toBe(true);
      expect(executeCalls[0].proxyOptions.vercelRelayUrl).toBe("");
      expect(executeCalls[0].credentials._opencodeSession).toBe(FRESH_SESSION);
      expect(executeCalls[1].proxyOptions.vercelRelayUrl).toBe("https://relay.example/one");
      expect(executeCalls[1].credentials._opencodeSession).not.toBe(FRESH_SESSION);
      expect(rotateCalls).toHaveLength(1);
      expect(rotateCalls[0][1]).toBe("https://primary.example");
      expect(delta).toEqual({
        attempts: 1,
        recovered: 1,
        exhausted: 0,
        directAttempts: 1,
        directRecovered: 0,
        directExhausted: 1,
      });
    } finally {
      OPENCODE_FREE_SESSION_ROTATION.rotateUpstream = originalRotate;
      BaseExecutor.prototype.execute = originalExecute;
      OPENCODE_SESSION_RETRY.maxAttempts = originalMax;
    }
  });

  it("recovers on direct egress without touching a relay", async () => {
    const originalRotate = OPENCODE_FREE_SESSION_ROTATION.rotateUpstream;
    const originalExecute = BaseExecutor.prototype.execute;
    const rotateCalls = [];
    const executeCalls = [];

    try {
      OPENCODE_FREE_SESSION_ROTATION.rotateUpstream = async (provider, current) => {
        rotateCalls.push([provider, current]);
        return "https://relay.example/should-not-run";
      };
      BaseExecutor.prototype.execute = async (args) => {
        executeCalls.push(args);
        return { response: new Response("ok", { status: 200 }) };
      };

      const executor = new OpenCodeExecutor();
      const credentials = { rawHeaders: { authorization: "Bearer rotation-direct-only-test" } };
      const first = freeTier429();
      const before = openCodeFreeRotationStats();
      const result = await executor._retryOnRotatedEgress(
        {
          model: "deepseek-v4.1-flash-free",
          body: { model: "deepseek-v4.1-flash-free", messages: [] },
          proxyOptions: { vercelRelayUrl: "https://primary.example/" },
          log: null,
        },
        credentials,
        first,
        { model: "deepseek-v4.1-flash-free", messages: [] }
      );
      const delta = statsDelta(before, openCodeFreeRotationStats());

      expect(result.response.status).toBe(200);
      expect(executeCalls).toHaveLength(1);
      expect(executeCalls[0].proxyOptions.forceDirect).toBe(true);
      expect(executeCalls[0].proxyOptions.vercelRelayUrl).toBe("");
      expect(executeCalls[0].credentials._opencodeSession).toMatch(/^ses_/);
      expect(rotateCalls).toHaveLength(0);
      expect(delta).toEqual({
        attempts: 0,
        recovered: 0,
        exhausted: 0,
        directAttempts: 1,
        directRecovered: 1,
        directExhausted: 0,
      });
    } finally {
      OPENCODE_FREE_SESSION_ROTATION.rotateUpstream = originalRotate;
      BaseExecutor.prototype.execute = originalExecute;
    }
  });

  it("surfaces a non-quota direct error instead of masking it with relays", async () => {
    const originalRotate = OPENCODE_FREE_SESSION_ROTATION.rotateUpstream;
    const originalExecute = BaseExecutor.prototype.execute;
    const rotateCalls = [];
    const executeCalls = [];

    try {
      OPENCODE_FREE_SESSION_ROTATION.rotateUpstream = async () => {
        rotateCalls.push("rotate");
        return "https://relay.example/should-not-run";
      };
      BaseExecutor.prototype.execute = async (args) => {
        executeCalls.push(args);
        return { response: new Response("maximum context length exceeded", { status: 400 }) };
      };

      const executor = new OpenCodeExecutor();
      const credentials = { rawHeaders: { authorization: "Bearer rotation-real-error-test" } };
      const before = openCodeFreeRotationStats();
      const result = await executor._retryOnRotatedEgress(
        {
          model: "glm-5.3-flash-free",
          body: { model: "glm-5.3-flash-free", messages: [] },
          proxyOptions: { vercelRelayUrl: "https://primary.example/" },
          log: null,
        },
        credentials,
        freeTier429(),
        { model: "glm-5.3-flash-free", messages: [] }
      );
      const delta = statsDelta(before, openCodeFreeRotationStats());

      expect(result.response.status).toBe(400);
      expect(executeCalls).toHaveLength(1);
      expect(rotateCalls).toHaveLength(0);
      expect(delta).toEqual({
        attempts: 0,
        recovered: 0,
        exhausted: 0,
        directAttempts: 1,
        directRecovered: 0,
        directExhausted: 0,
      });
    } finally {
      OPENCODE_FREE_SESSION_ROTATION.rotateUpstream = originalRotate;
      BaseExecutor.prototype.execute = originalExecute;
    }
  });

  it("tries multiple relays and returns the original 429 when all fail", async () => {
    const originalRotate = OPENCODE_FREE_SESSION_ROTATION.rotateUpstream;
    const originalExecute = BaseExecutor.prototype.execute;
    const originalMax = OPENCODE_SESSION_RETRY.maxAttempts;
    const relays = ["https://relay.example/one", "https://relay.example/two"];

    try {
      OPENCODE_SESSION_RETRY.maxAttempts = 2;
      OPENCODE_FREE_SESSION_ROTATION.rotateUpstream = async () => relays.shift();
      BaseExecutor.prototype.execute = async () => freeTier429();

      const executor = new OpenCodeExecutor();
      const credentials = { rawHeaders: { authorization: "Bearer rotation-failure-test" } };
      const originalSession = stableSessionId(credentials);
      const first = freeTier429();
      const before = openCodeFreeRotationStats();
      const result = await executor._retryOnRotatedEgress(
        {
          model: "glm-5.3-flash-free",
          body: { model: "glm-5.3-flash-free", messages: [] },
          proxyOptions: { vercelRelayUrl: "https://primary.example/" },
          log: null,
        },
        credentials,
        first,
        { model: "glm-5.3-flash-free", messages: [] }
      );
      const delta = statsDelta(before, openCodeFreeRotationStats());

      expect(result).toBe(first);
      expect(delta).toEqual({
        attempts: 2,
        recovered: 0,
        exhausted: 2,
        directAttempts: 1,
        directRecovered: 0,
        directExhausted: 1,
      });
      expect(stableSessionId(credentials)).not.toBe(originalSession);
    } finally {
      OPENCODE_FREE_SESSION_ROTATION.rotateUpstream = originalRotate;
      BaseExecutor.prototype.execute = originalExecute;
      OPENCODE_SESSION_RETRY.maxAttempts = originalMax;
    }
  });

  it("does not repeat direct egress when the primary was already direct", async () => {
    const originalRotate = OPENCODE_FREE_SESSION_ROTATION.rotateUpstream;
    const originalExecute = BaseExecutor.prototype.execute;
    const originalMax = OPENCODE_SESSION_RETRY.maxAttempts;
    const executeCalls = [];

    try {
      OPENCODE_SESSION_RETRY.maxAttempts = 1;
      OPENCODE_FREE_SESSION_ROTATION.rotateUpstream = async () => "https://relay.example/one";
      BaseExecutor.prototype.execute = async (args) => {
        executeCalls.push(args);
        return { response: new Response("ok", { status: 200 }) };
      };

      const executor = new OpenCodeExecutor();
      const credentials = { rawHeaders: { authorization: "Bearer rotation-primary-direct-test" } };
      const before = openCodeFreeRotationStats();
      const result = await executor._retryOnRotatedEgress(
        {
          model: "glm-5.3-flash-free",
          body: { model: "glm-5.3-flash-free", messages: [] },
          proxyOptions: {},
          log: null,
        },
        credentials,
        freeTier429(),
        { model: "glm-5.3-flash-free", messages: [] }
      );
      const delta = statsDelta(before, openCodeFreeRotationStats());

      expect(result.response.status).toBe(200);
      expect(executeCalls).toHaveLength(1);
      expect(executeCalls[0].proxyOptions.forceDirect).toBeUndefined();
      expect(executeCalls[0].proxyOptions.vercelRelayUrl).toBe("https://relay.example/one");
      expect(delta).toEqual({
        attempts: 1,
        recovered: 1,
        exhausted: 0,
        directAttempts: 0,
        directRecovered: 0,
        directExhausted: 0,
      });
    } finally {
      OPENCODE_FREE_SESSION_ROTATION.rotateUpstream = originalRotate;
      BaseExecutor.prototype.execute = originalExecute;
      OPENCODE_SESSION_RETRY.maxAttempts = originalMax;
    }
  });
});
