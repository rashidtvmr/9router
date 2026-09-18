// Seed default relay proxy pools (002). Idempotent: only inserts pools whose
// proxyUrl is not already present, so user edits/deletes are never clobbered.
import { DEFAULT_RELAY_POOLS } from "../seeds/defaultRelayPools.js";
import { stringifyJson } from "../helpers/jsonCol.js";
import { randomUUID } from "node:crypto";

export default {
  version: 2,
  name: "seed-default-relay-pools",
  up(db) {
    const existing = new Set(
      (db.all(`SELECT data FROM proxyPools`) || []).map((r) => {
        try { return JSON.parse(r.data)?.proxyUrl; } catch { return null; }
      }).filter(Boolean)
    );
    const now = new Date().toISOString();
    let added = 0;
    for (const p of DEFAULT_RELAY_POOLS) {
      if (!p?.proxyUrl || existing.has(p.proxyUrl)) continue;
      db.run(
        `INSERT INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, 1, 'unknown', ?, ?, ?)`,
        [
          randomUUID(),
          stringifyJson({ name: p.name, proxyUrl: p.proxyUrl, noProxy: "", type: p.type || "cloudflare", strictProxy: false, lastTestedAt: null, lastError: null }),
          now,
          now,
        ]
      );
      added += 1;
    }
    console.log(`[DB][migrate] seeded ${added} default relay pools`);
  },
};
