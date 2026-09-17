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

export const OPENCODE_FREE_SESSION_ROTATION = {
  enabled: true,
  ttlMs: 300000,
  maxEntries: 8,
  rotateUpstream: async (_provider, currentBaseUrl) => currentBaseUrl,
};

// Compatibility aliases for callers introduced during the initial rollout.
export const OPENCODE_NATIVE_SESSION_CACHE = OPENCODE_FREE_SESSION_ROTATION;
export const OPENCODE_SESSION_RETRY = { maxAttempts: 1, delayMs: 0 };
