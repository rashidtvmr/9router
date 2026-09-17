import { OPENCODE_NATIVE_SESSION_CACHE } from "../config/opencodeFreeSession.js";

class NativeSessionCache {
  constructor({ maxEntries = OPENCODE_NATIVE_SESSION_CACHE?.maxEntries ?? 8, ttlMs = OPENCODE_NATIVE_SESSION_CACHE?.ttlMs ?? 300000 } = {}) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.store = new Map();
  }

  set(entry, key = entry?.sessionId || "default") {
    if (!entry || typeof entry !== "object" || !entry.sessionId) return false;
    this.store.delete(key);
    this.store.set(key, { entry, expiresAt: Date.now() + this.ttlMs });
    while (this.store.size > this.maxEntries) this.store.delete(this.store.keys().next().value);
    return true;
  }

  get(key) {
    const first = key === undefined ? this.store.entries().next().value : [key, this.store.get(key)];
    if (!first) return null;
    const [foundKey, wrapped] = first;
    if (!wrapped || wrapped.expiresAt <= Date.now()) {
      if (foundKey !== undefined) this.store.delete(foundKey);
      return null;
    }
    this.store.delete(foundKey);
    this.store.set(foundKey, wrapped);
    return wrapped.entry;
  }

  has(key) { return this.get(key) !== null; }
  clear() { this.store.clear(); }
  get size() { return this.store.size; }
}

export { NativeSessionCache };
export const opencodeNativeSessionCache = new NativeSessionCache();
