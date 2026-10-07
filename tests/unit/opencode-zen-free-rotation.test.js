import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the proxyFetch module so the retry path doesn't make real network calls.
const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

// Keep the real rotateUpstream, but pin the rotation config so the enabled
// flag and relay list are deterministic.
const rotateUpstreamMock = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/config/opencodeFreeSession.js", async () => {
  const actual = await vi.importActual("../../open-sse/config/opencodeFreeSession.js");
  return {
    ...actual,
    OPENCODE_ZEN_FREE_ROTATION: {
      enabled: true,
      maxAttempts: 1,
      rotateUpstream: rotateUpstreamMock,
    },
  };
});

const { OpenCodeZenExecutor, openCodeZenRotationStats } = await import(
  "../../open-sse/executors/opencode-zen.js"
);
const { isOpenCodeFreeModel } = await import("../../open-sse/providers/models/helpers.js");
const { isOpenCodeFreeError, isOpenCodeZenFreeTierError } = await import(
  "../../open-sse/utils/opencodeFreeSessionError.js"
);

function makeResponse(status, bodyText = "") {
  const response = {
    status,
    ok: status >= 200 && status < 300,
    headers: new Map(),
    text: async () => bodyText,
  };
  response.clone = () => ({ text: async () => bodyText });
  return response;
}

const CHAT_URL = "https://opencode.ai/zen/v1/chat/completions";

function runExecutor(model, responses) {
  const executor = new OpenCodeZenExecutor();
  let call = 0;
  fetchMock.mockImplementation(async () => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return next;
  });
  return executor.execute({
    model,
    body: { model, messages: [{ role: "user", content: "hi" }] },
    stream: true,
    credentials: {},
    log: { debug: () => {}, warn: () => {} },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  rotateUpstreamMock.mockReset();
  rotateUpstreamMock.mockResolvedValue("https://relay-one.vercel.app");
});

describe("isOpenCodeFreeModel", () => {
  it("matches the -free suffix", () => {
    for (const id of [
      "mimo-v2.6-flash-free",
      "nemotron-3-ultra-free",
      "ling-3.0-flash-fin-free",
      "muse-spark-1.3-contributor-free",
    ]) {
      expect(isOpenCodeFreeModel(id)).toBe(true);
    }
  });

  it("matches big-pickle, which is free without the suffix", () => {
    expect(isOpenCodeFreeModel("big-pickle")).toBe(true);
  });

  it("rejects paid models", () => {
    for (const id of ["claude-fable-5", "glm-5.2", "gpt-5.6", "union-alpha"]) {
      expect(isOpenCodeFreeModel(id)).toBe(false);
    }
  });

  it("strips the thinking suffix before matching", () => {
    expect(isOpenCodeFreeModel("mimo-v2.6-flash-free(max)")).toBe(true);
  });
});

describe("keyed-lane free-tier predicate", () => {
  it("accepts free-tier wording on any watched status", async () => {
    for (const body of ["FreeTierError", "quota exceeded", "free tier", "rate limit", "too many requests", "capacity"]) {
      expect(await isOpenCodeZenFreeTierError(makeResponse(403, body))).toBe(true);
      expect(await isOpenCodeZenFreeTierError(makeResponse(429, body))).toBe(true);
    }
  });

  it("rejects an ordinary per-key 429", async () => {
    expect(await isOpenCodeZenFreeTierError(makeResponse(429, ""))).toBe(false);
    expect(await isOpenCodeZenFreeTierError(makeResponse(429, "slow down"))).toBe(false);
  });

  it("rejects a billing 402", async () => {
    expect(await isOpenCodeZenFreeTierError(makeResponse(402, "insufficient credits"))).toBe(false);
  });

  it("still accepts a bare 403 (free-tier gate with no readable body)", async () => {
    expect(await isOpenCodeZenFreeTierError(makeResponse(403, ""))).toBe(true);
  });

  it("leaves the anonymous-lane predicate short-circuiting 429/402", async () => {
    // The keyed tightening must not leak into the anonymous lane, whose quota
    // really is IP-keyed.
    expect(await isOpenCodeFreeError(makeResponse(429, ""))).toBe(true);
    expect(await isOpenCodeFreeError(makeResponse(402, ""))).toBe(true);
  });
});

describe("opencode-zen free-tier IP rotation", () => {
  it("rotates the origin and recovers a free-tier 403", async () => {
    const result = await runExecutor("mimo-v2.6-flash-free", [
      makeResponse(403, "FreeTierError"),
      makeResponse(200, ""),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [retryUrl, retryInit] = fetchMock.mock.calls[1];
    expect(retryUrl).toBe("https://relay-one.vercel.app/zen/v1/chat/completions");
    expect(retryInit.method).toBe("POST");
    expect(result.response.ok).toBe(true);
  });

  it("preserves the Zen path when rotating the responses route", async () => {
    await runExecutor("muse-spark-1.3-contributor-free", [
      makeResponse(403, "FreeTierError"),
      makeResponse(200, ""),
    ]);

    const [retryUrl] = fetchMock.mock.calls[1];
    expect(retryUrl).toBe("https://relay-one.vercel.app/zen/v1/responses");
  });

  it("does not rotate a paid model's 429", async () => {
    const result = await runExecutor("claude-fable-5", [makeResponse(429, "rate limit")]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rotateUpstreamMock).not.toHaveBeenCalled();
    expect(result.response.status).toBe(429);
  });

  it("does not rotate on a non-free-tier failure", async () => {
    await runExecutor("mimo-v2.5-free", [makeResponse(500, "internal error")]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rotateUpstreamMock).not.toHaveBeenCalled();
  });

  it("returns the original response when no alternate relay exists", async () => {
    rotateUpstreamMock.mockResolvedValue("https://opencode.ai");

    const result = await runExecutor("nemotron-3-ultra-free", [makeResponse(403, "FreeTierError")]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(403);
  });

  it("returns the original response when rotation throws", async () => {
    rotateUpstreamMock.mockRejectedValue(new Error("db down"));

    const result = await runExecutor("ling-3.0-flash-fin-free", [makeResponse(402, "quota exceeded")]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(402);
  });

  it("returns the original response when the rotated retry also fails", async () => {
    const before = openCodeZenRotationStats();
    const result = await runExecutor("mimo-v2.6-flash-free", [
      makeResponse(403, "FreeTierError"),
      makeResponse(403, "FreeTierError"),
    ]);

    expect(result.response.status).toBe(403);
    // Counters are module-level and shared across cases in this file, so assert
    // the delta rather than an absolute rate.
    const after = openCodeZenRotationStats();
    expect(after.attempts).toBe(before.attempts + 1);
    expect(after.recovered).toBe(before.recovered);
    expect(after.exhausted).toBe(before.exhausted + 1);
  });

  it("does not spend a second request on an ordinary per-key 429", async () => {
    const before = openCodeZenRotationStats().attempts;
    const result = await runExecutor("mimo-v2.6-flash-free", [makeResponse(429, "slow down")]);

    // A keyed connection's plain rate limit is not IP-keyed quota; rotating the
    // egress origin would recover nothing and cost a full extra generation.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rotateUpstreamMock).not.toHaveBeenCalled();
    expect(openCodeZenRotationStats().attempts).toBe(before);
    expect(result.response.status).toBe(429);
  });

  it("keeps rotation state off the shared executor instance", async () => {
    const executor = new OpenCodeZenExecutor();
    // A paid request interleaved between the free failure and its replay must
    // not inherit the rotated origin.
    fetchMock
      .mockResolvedValueOnce(makeResponse(403, "FreeTierError"))
      .mockResolvedValueOnce(makeResponse(403, "FreeTierError"))
      .mockImplementation(async () => makeResponse(200, ""));

    await executor.execute({
      model: "mimo-v2.6-flash-free",
      body: { messages: [] },
      stream: true,
      credentials: {},
      log: { debug: () => {}, warn: () => {} },
    });

    const urls = fetchMock.mock.calls.map(([url]) => url);
    for (const url of urls) expect(url.startsWith(CHAT_URL) || url.includes("relay-one")).toBe(true);
    // The final call is a fresh paid request and must not be rotated.
    expect(urls[urls.length - 1]).toBe(CHAT_URL);
  });
});
