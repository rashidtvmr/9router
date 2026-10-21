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

  it("keeps the AWS Lambda inventory complete and in sync with deploy-relay.sh", () => {
    const aws1 = DEFAULT_RELAY_POOLS.filter((p) => p.name.startsWith("aws-relay-"));
    const aws2 = DEFAULT_RELAY_POOLS.filter((p) => p.name.startsWith("aws2-relay-"));
    const urls = [...aws1, ...aws2].map((p) => p.proxyUrl);

    expect(aws1).toHaveLength(17);
    expect(aws2).toHaveLength(17);
    expect(new Set(urls).size).toBe(34);
    for (const url of urls) {
      expect(url, `unexpected relay URL: ${url}`).toMatch(
        /^https:\/\/[a-z0-9]+\.lambda-url\.[a-z0-9-]+\.on\.aws\/$/
      );
    }

    const script = fs.readFileSync(
      new URL("../../src/api-deploy/aws-lambda-relay/deploy-relay.sh", import.meta.url),
      "utf8"
    );
    const parseMap = (name) => {
      const marker = `REGIONS_${name}=(`;
      const start = script.indexOf(marker);
      expect(start, `missing ${marker} in deploy-relay.sh`).toBeGreaterThan(-1);
      const end = script.indexOf("\n)", start);
      expect(end, `unterminated ${marker} in deploy-relay.sh`).toBeGreaterThan(start);
      return Object.fromEntries(
        [...script.slice(start, end).matchAll(/"([^"|]+)\|([^"]+)"/g)].map((m) => [m[1], m[2]])
      );
    };

    const scriptAcct1 = parseMap("ACCT1");
    const scriptAcct2 = parseMap("ACCT2");
    expect(Object.keys(scriptAcct1)).toHaveLength(17);
    expect(Object.keys(scriptAcct2)).toHaveLength(17);
    expect(Object.keys(scriptAcct1).sort()).toEqual(Object.keys(scriptAcct2).sort());

    for (const pool of aws1) {
      const region = pool.name.slice("aws-relay-".length);
      expect(scriptAcct1[region], `account 1 ${region} URL`).toBe(pool.proxyUrl);
    }
    for (const pool of aws2) {
      const region = pool.name.slice("aws2-relay-".length);
      expect(scriptAcct2[region], `account 2 ${region} URL`).toBe(pool.proxyUrl);
    }

    const docs = fs.readFileSync(
      new URL("../../src/api-deploy/aws-lambda-relay/DEPLOY.md", import.meta.url),
      "utf8"
    );
    for (const pool of [...aws1, ...aws2]) {
      expect(docs, `DEPLOY.md is missing ${pool.name}`).toContain(pool.proxyUrl);
    }
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
