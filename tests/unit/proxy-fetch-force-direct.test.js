// The free-lane rescue must be able to bypass relay/connection/env proxies.
import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("proxyAwareFetch forceDirect", () => {
  it("bypasses relay and configured proxies", async () => {
    const mock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", mock);
    vi.resetModules();
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    const options = { method: "POST", body: "{}" };
    const response = await proxyAwareFetch(
      "https://upstream.example/v1/chat/completions",
      options,
      {
        forceDirect: true,
        vercelRelayUrl: "https://relay.example",
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://127.0.0.1:9",
      }
    );

    expect(response.status).toBe(200);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0]).toBe("https://upstream.example/v1/chat/completions");
    expect(mock.mock.calls[0][1]).toBe(options);
  });
});
