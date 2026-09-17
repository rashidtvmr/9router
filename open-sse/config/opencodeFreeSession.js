export const OPENCODE_FREE_ERROR_STATUSES = [403, 402, 429];
export const OPENCODE_FREE_ERROR_TEXTS = [
  "freetiererror",
  "opencode's free tier can only be used from within opencode",
  "free tier",
  "quota exceeded",
  "rate limit",
  "too many requests",
  "capacity",
];

// Round-robin state for Lambda relay IP rotation (in-memory, per-process).
let relayRoundRobinIndex = 0;

/**
 * Rotate the upstream base URL to a different AWS Lambda relay pool on retry.
 *
 * OpenCode's free tier keys quota on the connecting egress IP. When the free
 * tier returns 403/402/429, replaying with the cached native session on the
 * *same IP* will likely fail again. We cycle through all active relay pools
 * (Vercel/Cloudflare/Deno edge proxies that front AWS Lambda functions, each
 * with a distinct egress IP) to get a fresh IP for the retry attempt.
 */
export const OPENCODE_FREE_SESSION_ROTATION = {
  enabled: true,
  ttlMs: 300000,
  maxEntries: 8,
  rotateUpstream: async (_provider, currentBaseUrl) => {
    // Dynamic import to avoid pulling DB deps at module load time.
    const { getProxyPools } = await import("@/lib/localDb.js");
    const RELAY_TYPES = new Set(["vercel", "cloudflare", "deno"]);
    try {
      const pools = await getProxyPools({ isActive: true });
      const relayPools = (pools || [])
        .filter((p) => RELAY_TYPES.has(p.type) && p.proxyUrl)
        .map((p) => p.proxyUrl);
      if (relayPools.length === 0) return currentBaseUrl;

      // Round-robin across relays, skipping the pool whose URL matches the
      // one we're already on, so we always get a genuinely different egress IP.
      const currentNormalized = currentBaseUrl.replace(/\/+$/, "");
      let rotated = null;
      for (let i = 0; i < relayPools.length; i += 1) {
        const idx = (relayRoundRobinIndex + i) % relayPools.length;
        relayRoundRobinIndex = (relayRoundRobinIndex + 1) % relayPools.length;
        const candidate = relayPools[idx].replace(/\/+$/, "");
        if (candidate !== currentNormalized) {
          rotated = relayPools[idx];
          break;
        }
      }
      return rotated || relayPools[relayRoundRobinIndex % relayPools.length];
    } catch {
      return currentBaseUrl;
    }
  },
};

// Compatibility aliases for callers introduced during the initial rollout.
export const OPENCODE_NATIVE_SESSION_CACHE = OPENCODE_FREE_SESSION_ROTATION;
export const OPENCODE_SESSION_RETRY = { maxAttempts: 1, delayMs: 0 };
