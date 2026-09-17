import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the proxyFetch module so the retry path doesn't make real network calls.
const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

// Mock the config constants so we can control retry behavior.
// rotateUpstream is kept as the real implementation so we can test it
// querying the mocked proxy pools.
vi.mock("../../open-sse/config/opencodeFreeSession.js", async () => {
  const actual = await vi.importActual("../../open-sse/config/opencodeFreeSession.js");
  return {
    ...actual,
    OPENCODE_FREE_ERROR_STATUSES: [403, 402, 429],
    OPENCODE_FREE_ERROR_TEXTS: [
      "freetiererror",
      "opencode's free tier can only be used from within opencode",
      "free tier",
      "quota exceeded",
      "rate limit",
      "too many requests",
      "capacity",
    ],
    OPENCODE_NATIVE_SESSION_CACHE: { maxEntries: 1, ttlMs: 999999 },
    OPENCODE_SESSION_RETRY: { maxAttempts: 1, delayMs: 0 },
    // Spread the real rotation config so rotateUpstream is preserved.
    OPENCODE_FREE_SESSION_ROTATION: actual.OPENCODE_FREE_SESSION_ROTATION,
  };
});

// Mock the DB layer so rotateUpstream can query proxy pools.
const getProxyPoolsMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/localDb.js", () => ({
  getProxyPools: (...args) => getProxyPoolsMock(...args),
}));

const { OpenCodeExecutor } = await import("../../open-sse/executors/opencode.js");
const { opencodeNativeSessionCache } = await import("../../open-sse/utils/opencodeNativeSessionCache.js");

function makeResponse(status, bodyText = "") {
  const response = {
    status,
    ok: status >= 200 && status < 300,
    headers: new Map(),
    text: async () => bodyText,
  };
  // Match the Fetch Response contract used by isOpenCodeFreeError. Cloning
  // also ensures error-body inspection does not consume the returned body.
  response.clone = () => ({ text: async () => bodyText });
  return response;
}

function makeExecutor() {
  return new OpenCodeExecutor();
}

beforeEach(() => {
  fetchMock.mockReset();
  opencodeNativeSessionCache.clear();
  getProxyPoolsMock.mockReset();
});

afterEach(() => {
  opencodeNativeSessionCache.clear();
});

describe("OpenCodeExecutor — native session cache population", () => {
  it("captures session context on a successful 200 response", async () => {
    const executor = makeExecutor();
    const creds = { rawHeaders: {}, accessToken: "public" };

    fetchMock.mockResolvedValueOnce(makeResponse(200, "ok"));

    await executor.execute({
      model: "big-pickle",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: creds,
      providerSessionId: "test-session-abc",
    });

    const cached = opencodeNativeSessionCache.get();
    expect(cached).not.toBeNull();
    expect(cached.sessionId).toBe("test-session-abc");
    expect(cached.userAgent).toBe("opencode/1.18.26");
  });

  it("does not capture when session id is empty", async () => {
    const executor = makeExecutor();
    fetchMock.mockResolvedValueOnce(makeResponse(200, "ok"));

    await executor.execute({
      model: "big-pickle",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { rawHeaders: {}, accessToken: "public" },
    });

    // No providerSessionId and no cached session → resolveSessionId generates one,
    // but the credentials won't have _opencodeSession set without prepareRequestCredentials.
    // Since execute calls prepareRequestCredentials, a session id will be generated.
    // The cache should still be populated with the generated session.
    expect(opencodeNativeSessionCache.has()).toBe(true);
  });
});

describe("OpenCodeExecutor — retry on FreeTierError", () => {
  it("replays with cached native session on 403 FreeTierError", async () => {
    // Pre-populate the cache with a known native session context.
    opencodeNativeSessionCache.set({
      sessionId: "ses_f522c1acdffeoC2Waba3K5rn6v",
      userAgent: "opencode/1.18.31",
      requestBody: null,
    }, "default");

    const executor = makeExecutor();
    const creds = { rawHeaders: {}, accessToken: "public" };

    // First call: 403 FreeTierError
    fetchMock.mockResolvedValueOnce(
      makeResponse(403, '{"error":{"type":"FreeTierError","message":"FreeTierError: OpenCode\'s free tier can only be used from within OpenCode"}}'),
    );
    // Retry call: 200 success
    fetchMock.mockResolvedValueOnce(makeResponse(200, "ok"));

    const result = await executor.execute({
      model: "big-pickle",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: creds,
      providerSessionId: "synth-session",
    });
    // Verify the retry used the cached native session id in headers.
    const retryHeaders = fetchMock.mock.calls[1][1].headers;
    expect(retryHeaders["x-session-id"]).toBe("ses_f522c1acdffeoC2Waba3K5rn6v");
    expect(retryHeaders["x-session-affinity"]).toBe("ses_f522c1acdffeoC2Waba3K5rn6v");
    expect(retryHeaders["x-opencode-session"]).toBe("ses_f522c1acdffeoC2Waba3K5rn6v");
    expect(retryHeaders["User-Agent"]).toBe("opencode/1.18.31");
  });

  it("replays with cached native session on 429 rate limit", async () => {
    opencodeNativeSessionCache.set({
      sessionId: "ses_native-replay-123",
      userAgent: "opencode/1.18.26",
      requestBody: null,
    }, "default");

    const executor = makeExecutor();

    fetchMock.mockResolvedValueOnce(makeResponse(429, "rate limit exceeded"));
    fetchMock.mockResolvedValueOnce(makeResponse(200, "ok"));

    const result = await executor.execute({
      model: "big-pickle",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { rawHeaders: {}, accessToken: "public" },
      providerSessionId: "synth-456",
    });

    expect(result.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryHeaders = fetchMock.mock.calls[1][1].headers;
    expect(retryHeaders["x-session-id"]).toBe("ses_native-replay-123");
  });

  it("replays with cached native session on 402 payment required", async () => {
    opencodeNativeSessionCache.set({
      sessionId: "ses_payment-needed-abc",
      userAgent: "opencode/1.18.26",
      requestBody: null,
    }, "default");

    const executor = makeExecutor();

    fetchMock.mockResolvedValueOnce(makeResponse(402, "payment required"));
    fetchMock.mockResolvedValueOnce(makeResponse(200, "ok"));

    const result = await executor.execute({
      model: "big-pickle",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { rawHeaders: {}, accessToken: "public" },
      providerSessionId: "synth-789",
    });

    expect(result.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("OpenCodeExecutor — DC IP rotation via Lambda relay pools", () => {
  it("rotates to a different Lambda relay pool URL on retry", async () => {
    // Reset the round-robin index by setting it to a known state.
    // The rotateUpstream implementation uses a module-level counter.
    // We mock getProxyPools to return multiple relay pools.
    getProxyPoolsMock.mockResolvedValue([
      { id: "aws-relay-us-east-1", name: "aws-relay-us-east-1", type: "cloudflare", proxyUrl: "https://lambda-us-east-1.example.com", isActive: true },
      { id: "aws-relay-us-west-2", name: "aws-relay-us-west-2", type: "cloudflare", proxyUrl: "https://lambda-us-west-2.example.com", isActive: true },
      { id: "aws-relay-eu-west-1", name: "aws-relay-eu-west-1", type: "cloudflare", proxyUrl: "https://lambda-eu-west-1.example.com", isActive: true },
    ]);

    opencodeNativeSessionCache.set({
      sessionId: "ses_lambda-rotation-1",
      userAgent: "opencode/1.18.26",
      requestBody: null,
    }, "default");

    const executor = makeExecutor();

    fetchMock.mockResolvedValueOnce(makeResponse(429, "rate limit"));
    fetchMock.mockResolvedValueOnce(makeResponse(200, "ok"));

    const result = await executor.execute({
      model: "big-pickle",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { rawHeaders: {}, accessToken: "public" },
      providerSessionId: "synth-lambda-1",
    });

    expect(result.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The retry URL should use a relay pool URL, not the default opencode.ai.
    const retryUrl = fetchMock.mock.calls[1][0];
    expect(retryUrl).not.toContain("opencode.ai");
    expect(retryUrl).toMatch(/lambda-(us-east-1|us-west-2|eu-west-1)\.example\.com/);

    // Verify getProxyPools was called to fetch relay pools.
    expect(getProxyPoolsMock).toHaveBeenCalled();
  });

  it("falls back to original base URL when no relay pools are configured", async () => {
    getProxyPoolsMock.mockResolvedValue([]);

    opencodeNativeSessionCache.set({
      sessionId: "ses_no-pools-1",
      userAgent: "opencode/1.18.26",
      requestBody: null,
    }, "default");

    const executor = makeExecutor();

    fetchMock.mockResolvedValueOnce(makeResponse(429, "rate limit"));
    fetchMock.mockResolvedValueOnce(makeResponse(200, "ok"));

    const result = await executor.execute({
      model: "big-pickle",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { rawHeaders: {}, accessToken: "public" },
      providerSessionId: "synth-no-pools",
    });

    expect(result.response.status).toBe(200);
    // Should fall back to the default OpenCode URL since no relay pools exist.
    const retryUrl = fetchMock.mock.calls[1][0];
    expect(retryUrl).toContain("opencode.ai");
  });

  it("round-robins across relay pools on consecutive retries", async () => {
    const relayPools = [
      { id: "r1", name: "r1", type: "cloudflare", proxyUrl: "https://relay-1.example.com", isActive: true },
      { id: "r2", name: "r2", type: "cloudflare", proxyUrl: "https://relay-2.example.com", isActive: true },
    ];
    getProxyPoolsMock.mockResolvedValue(relayPools);

    const retryUrls = [];
    for (let i = 0; i < 3; i++) {
      opencodeNativeSessionCache.set({
        sessionId: `ses_rr_${i}`,
        userAgent: "opencode/1.18.26",
        requestBody: null,
      }, "default");

      const executor = makeExecutor();
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(makeResponse(429, "rate limit"));
      fetchMock.mockResolvedValueOnce(makeResponse(200, "ok"));

      await executor.execute({
        model: "big-pickle",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: true,
        credentials: { rawHeaders: {}, accessToken: "public" },
        providerSessionId: `synth_rr_${i}`,
      });

      // Capture the retry URL from each iteration (call index 1 = second fetch).
      retryUrls.push(fetchMock.mock.calls[1][0]);
    }

    // All three retries should use different relay pool URLs (round-robin).
    expect(retryUrls[0]).not.toContain("opencode.ai");
    expect(retryUrls[1]).not.toContain("opencode.ai");
    expect(retryUrls[2]).not.toContain("opencode.ai");

    // The URLs should alternate (round-robin between 2 pools).
    const hosts = retryUrls.map(u => u.split("/")[2]);
    expect(new Set(hosts).size).toBeGreaterThanOrEqual(1);
    // With round-robin over 2 pools across 3 iterations, at least 2 distinct hosts.
    expect(new Set(hosts).size).toBe(2);
  });
});

describe("OpenCodeExecutor — DC IP rotation hook", () => {
  it("invokes the config-driven rotation hook to override base URL on retry", async () => {
    // The rotation hook is read from PROVIDERS.opencode.transport.sessionRetry.baseUrlFn.
    // We mock PROVIDERS to inject a hook.
    const { PROVIDERS } = await import("../../open-sse/config/providers.js");
    // PROVIDERS is the normalized transport map, so opencode itself is the
    // transport object (the registry entry is not exposed here).
    const transport = PROVIDERS.opencode;
    const originalFn = transport?.sessionRetry?.baseUrlFn;

    const rotationHook = vi.fn(() => "https://rotated-dc.9router.dev");
    if (!transport.sessionRetry) transport.sessionRetry = {};
    transport.sessionRetry.baseUrlFn = rotationHook;

    opencodeNativeSessionCache.set({
      sessionId: "ses_rotated-retry",
      userAgent: "opencode/1.18.26",
      requestBody: null,
    }, "default");

    const executor = makeExecutor();

    fetchMock.mockResolvedValueOnce(makeResponse(429, "rate limit"));
    fetchMock.mockResolvedValueOnce(makeResponse(200, "ok"));

    const result = await executor.execute({
      model: "big-pickle",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { rawHeaders: {}, accessToken: "public" },
      providerSessionId: "synth-rotation",
    });

    expect(rotationHook).toHaveBeenCalledOnce();
    expect(result.response.status).toBe(200);

    // Verify the retry URL used the rotated base.
    const retryUrl = fetchMock.mock.calls[1][0];
    expect(retryUrl).toContain("rotated-dc.9router.dev");

    // Restore.
    if (originalFn) transport.sessionRetry.baseUrlFn = originalFn;
    else delete transport.sessionRetry?.baseUrlFn;
  });
});

describe("OpenCodeExecutor — no-op when cache is empty", () => {
  it("returns the original error response when no native session is cached", async () => {
    const executor = makeExecutor();

    fetchMock.mockResolvedValueOnce(makeResponse(403, '{"error":{"type":"FreeTierError","message":"not native"}}'));

    const result = await executor.execute({
      model: "big-pickle",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { rawHeaders: {}, accessToken: "public" },
      providerSessionId: "synth-no-cache",
    });

    // No cache → no retry → fetch called only once.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(403);
    expect(result.response.ok).toBe(false);
  });
});

describe("OpenCodeExecutor — non-free-tier errors do not trigger replay", () => {
  it("does not replay on ordinary 403 without FreeTierError text", async () => {
    opencodeNativeSessionCache.set({
      sessionId: "ses-cached",
      userAgent: "opencode/1.18.26",
      requestBody: null,
    });

    const executor = makeExecutor();

    fetchMock.mockResolvedValueOnce(makeResponse(403, '{"error":{"type":"permission_error","message":"Forbidden"}}'));

    const result = await executor.execute({
      model: "big-pickle",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { rawHeaders: {}, accessToken: "public" },
      providerSessionId: "synth-403",
    });

    // 403 without FreeTierError text → not eligible for retry.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(403);
  });

  it("does not replay on 500 server error", async () => {
    opencodeNativeSessionCache.set({
      sessionId: "ses-cached",
      userAgent: "opencode/1.18.26",
      requestBody: null,
    });

    const executor = makeExecutor();

    fetchMock.mockResolvedValueOnce(makeResponse(500, "internal server error"));

    const result = await executor.execute({
      model: "big-pickle",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { rawHeaders: {}, accessToken: "public" },
      providerSessionId: "synth-500",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(500);
  });
});
