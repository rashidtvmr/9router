import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nr-seed-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("@/lib/db/driver.js");
const { DEFAULT_RELAY_POOLS } = await import("@/lib/db/seeds/defaultRelayPools.js");

describe("relay pool seed migration (002)", () => {
  it("seeds all default pools on a fresh DB", async () => {
    const db = await getAdapter();
    const rows = db.all(`SELECT data FROM proxyPools`);
    const urls = new Set(rows.map((r) => { try { return JSON.parse(r.data)?.proxyUrl; } catch { return null; } }));
    for (const p of DEFAULT_RELAY_POOLS) {
      expect(urls.has(p.proxyUrl), `missing ${p.name}`).toBe(true);
    }
  });

  it("is idempotent — second migration run adds nothing", async () => {
    const { runMigrationOnce } = await import("@/lib/db/migrate.js");
    const db = await getAdapter();
    const before = db.get(`SELECT COUNT(*) as c FROM proxyPools`).c;
    // force re-run by clearing the per-adapter guard via a fresh adapter path:
    // runMigrationOnce short-circuits on the same adapter, so call the
    // migration's up() directly to prove row-level idempotency.
    const m002 = (await import("@/lib/db/migrations/002-seed-relay-pools.js")).default;
    db.transaction(() => m002.up(db));
    const after = db.get(`SELECT COUNT(*) as c FROM proxyPools`).c;
    expect(after).toBe(before);
  });

  it("never clobbers user pools (matched by proxyUrl)", async () => {
    const db = await getAdapter();
    const victim = DEFAULT_RELAY_POOLS[0];
    const row = db.all(`SELECT * FROM proxyPools`).map((r) => ({ ...r, j: JSON.parse(r.data) })).find((r) => r.j.proxyUrl === victim.proxyUrl);
    expect(row).toBeTruthy();
    db.run(`UPDATE proxyPools SET isActive = 0 WHERE id = ?`, [row.id]);
    const m002 = (await import("@/lib/db/migrations/002-seed-relay-pools.js")).default;
    db.transaction(() => m002.up(db));
    const after = db.get(`SELECT isActive FROM proxyPools WHERE id = ?`, [row.id]);
    expect(after.isActive).toBe(0);
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
