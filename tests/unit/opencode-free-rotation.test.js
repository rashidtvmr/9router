// Free-lane rotation must replace the spent stable session and try more than
// one relay for the same request.
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
  };
}

describe("opencode free-lane rotation", () => {
  it("replaces the cached stable session", () => {
    const credentials = { rawHeaders: { authorization: "Bearer rotation-session-test" } };
    const original = stableSessionId(credentials);
    const fresh = replaceStableSession(credentials);

    expect(fresh).not.toBe(original);
    expect(stableSessionId(credentials)).toBe(fresh);
  });

  it("replays on a different relay with the fresh session", async () => {
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
        return { response: new Response("ok", { status: 200 }) };
      };

      const executor = new OpenCodeExecutor();
      const credentials = { rawHeaders: { authorization: "Bearer rotation-recovery-test" } };
      const first = { response: new Response("free tier", { status: 429 }) };
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
      expect(executeCalls).toHaveLength(1);
      expect(executeCalls[0].proxyOptions.vercelRelayUrl).toBe("https://relay.example/one");
      expect(executeCalls[0].credentials._opencodeSession).toBe(FRESH_SESSION);
      expect(rotateCalls[0][1]).toBe("https://primary.example");
      expect(delta).toEqual({ attempts: 1, recovered: 1, exhausted: 0 });
    } finally {
      OPENCODE_FREE_SESSION_ROTATION.rotateUpstream = originalRotate;
      BaseExecutor.prototype.execute = originalExecute;
      OPENCODE_SESSION_RETRY.maxAttempts = originalMax;
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
      BaseExecutor.prototype.execute = async () => ({
        response: new Response("free tier", { status: 429 }),
      });

      const executor = new OpenCodeExecutor();
      const credentials = { rawHeaders: { authorization: "Bearer rotation-failure-test" } };
      const originalSession = stableSessionId(credentials);
      const first = { response: new Response("free tier", { status: 429 }) };
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
      expect(delta).toEqual({ attempts: 2, recovered: 0, exhausted: 2 });
      expect(stableSessionId(credentials)).not.toBe(originalSession);
    } finally {
      OPENCODE_FREE_SESSION_ROTATION.rotateUpstream = originalRotate;
      BaseExecutor.prototype.execute = originalExecute;
      OPENCODE_SESSION_RETRY.maxAttempts = originalMax;
    }
  });
});
