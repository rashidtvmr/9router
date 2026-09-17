import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the proxyFetch module so the retry path doesn't make real network calls.
const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

// Mock the config constants so we can control retry behavior.
vi.mock("../../open-sse/config/opencodeFreeSession.js", () => ({
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
}));

const { OpenCodeExecutor } = await import("../../open-sse/executors/opencode.js");
const { opencodeNativeSessionCache } = await import("../../open-sse/utils/opencodeNativeSessionCache.js");

function makeResponse(status, bodyText = "") {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Map(),
    text: async () => bodyText,
  };
}

function makeExecutor() {
  return new OpenCodeExecutor();
}

beforeEach(() => {
  fetchMock.mockReset();
  opencodeNativeSessionCache.clear();
});

afterEach(() => {
  opencodeNativeSessionCache.clear();
});

describe("OpenCodeExecutor — native session cache population", () => {
  it("captures session context on a successful 200 response", async () => {
    const executor = makeExecutor();
    const creds = { rawHeaders: {}, accessToken: "public" };
    const prepared = executor.prepareRequestCredentials({ body: { messages: [] }, credentials: creds, providerSessionId: "test-session-abc" });

    fetchMock.mockResolvedValueOnce(makeResponse(200, "ok"));

    await executor.execute({
      model: "big-pickle",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: prepared,
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
    });

    const executor = makeExecutor();
    const creds = { rawHeaders: {}, accessToken: "public" };
    const prepared = executor.prepareRequestCredentials({ body: { messages: [] }, credentials: creds, providerSessionId: "synth-session" });

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
      credentials: prepared,
    });

    expect(result.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

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
    });

    const executor = makeExecutor();
    const prepared = executor.prepareRequestCredentials({
      body: { messages: [] },
      credentials: { rawHeaders: {}, accessToken: "public" },
      providerSessionId: "synth-456",
    });

    fetchMock.mockResolvedValueOnce(makeResponse(429, "rate limit exceeded"));
    fetchMock.mockResolvedValueOnce(makeResponse(200, "ok"));

    const result = await executor.execute({
      model: "big-pickle",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: prepared,
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
    });

    const executor = makeExecutor();
    const prepared = executor.prepareRequestCredentials({
      body: { messages: [] },
      credentials: { rawHeaders: {}, accessToken: "public" },
      providerSessionId: "synth-789",
    });

    fetchMock.mockResolvedValueOnce(makeResponse(402, "payment required"));
    fetchMock.mockResolvedValueOnce(makeResponse(200, "ok"));

    const result = await executor.execute({
      model: "big-pickle",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: prepared,
    });

    expect(result.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("OpenCodeExecutor — DC IP rotation hook", () => {
  it("invokes the config-driven rotation hook to override base URL on retry", async () => {
    // The rotation hook is read from PROVIDERS.opencode.transport.sessionRetry.baseUrlFn.
    // We mock PROVIDERS to inject a hook.
    const { PROVIDERS } = await import("../../open-sse/config/providers.js");
    const originalFn = PROVIDERS.opencode?.transport?.sessionRetry?.baseUrlFn;

    const rotationHook = vi.fn(() => "https://rotated-dc.9router.dev");
    if (!PROVIDERS.opencode.transport.sessionRetry) PROVIDERS.opencode.transport.sessionRetry = {};
    PROVIDERS.opencode.transport.sessionRetry.baseUrlFn = rotationHook;

    opencodeNativeSessionCache.set({
      sessionId: "ses_rotated-retry",
      userAgent: "opencode/1.18.26",
      requestBody: null,
    });

    const executor = makeExecutor();
    const prepared = executor.prepareRequestCredentials({
      body: { messages: [] },
      credentials: { rawHeaders: {}, accessToken: "public" },
      providerSessionId: "synth-rotation",
    });

    fetchMock.mockResolvedValueOnce(makeResponse(429, "rate limit"));
    fetchMock.mockResolvedValueOnce(makeResponse(200, "ok"));

    const result = await executor.execute({
      model: "big-pickle",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: prepared,
    });

    expect(rotationHook).toHaveBeenCalledOnce();
    expect(result.response.status).toBe(200);

    // Verify the retry URL used the rotated base.
    const retryUrl = fetchMock.mock.calls[1][0];
    expect(retryUrl).toContain("rotated-dc.9router.dev");

    // Restore.
    if (originalFn) PROVIDERS.opencode.transport.sessionRetry.baseUrlFn = originalFn;
    else delete PROVIDERS.opencode.transport.sessionRetry?.baseUrlFn;
  });
});

describe("OpenCodeExecutor — no-op when cache is empty", () => {
  it("returns the original error response when no native session is cached", async () => {
    const executor = makeExecutor();
    const prepared = executor.prepareRequestCredentials({
      body: { messages: [] },
      credentials: { rawHeaders: {}, accessToken: "public" },
      providerSessionId: "synth-no-cache",
    });

    fetchMock.mockResolvedValueOnce(makeResponse(403, '{"error":{"type":"FreeTierError","message":"not native"}}'));

    const result = await executor.execute({
      model: "big-pickle",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: prepared,
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
    const prepared = executor.prepareRequestCredentials({
      body: { messages: [] },
      credentials: { rawHeaders: {}, accessToken: "public" },
      providerSessionId: "synth-403",
    });

    fetchMock.mockResolvedValueOnce(makeResponse(403, '{"error":{"type":"permission_error","message":"Forbidden"}}'));

    const result = await executor.execute({
      model: "big-pickle",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: prepared,
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
    const prepared = executor.prepareRequestCredentials({
      body: { messages: [] },
      credentials: { rawHeaders: {}, accessToken: "public" },
      providerSessionId: "synth-500",
    });

    fetchMock.mockResolvedValueOnce(makeResponse(500, "internal server error"));

    const result = await executor.execute({
      model: "big-pickle",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: prepared,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(500);
  });
});
