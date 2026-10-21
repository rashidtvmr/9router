#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# AWS Lambda Relay Pool Registration Script
# =============================================================================
# Registers the 34 AWS Lambda Function URLs (17 regions x 2 AWS accounts) with
# a local 9router instance.
#
# Canonical inventory:
#   src/lib/db/seeds/defaultRelayPools.js
# Keep the two maps below in sync with that file. The inventory test in
# tests/unit/relay-pool-seed.test.js checks the 17 + 17 URLs and the docs.
#
# Usage:
#   ./deploy-relay.sh            # destructive: replace all aws* relay pools
#   ./deploy-relay.sh --check    # read-only: verify counts, change nothing
#   ROUTER_PORT=20128 ./deploy-relay.sh
#
# The dashboard API is auth-protected by default. This script derives the local
# x-9r-cli-token from <DATA_DIR>/machine-id and <DATA_DIR>/auth/cli-secret
# (DATA_DIR defaults to ~/.9router). Set NINEROUTER_CLI_TOKEN to override.
#
# Indexed arrays and plain strings keep this compatible with macOS Bash 3.2.
# Each entry is "region|function-url".
# =============================================================================

PORT=${ROUTER_PORT:-20128}
BASE_URL="http://localhost:${PORT}"

CHECK_ONLY=0
case "${1:-}" in
  "")
    ;;
  --check)
    CHECK_ONLY=1
    ;;
  *)
    echo "Usage: $0 [--check]" >&2
    exit 2
    ;;
esac

# Account 1 (AWS 135775792878): 17 live regions. ap-south-2 is intentionally
# absent because CreateFunctionUrlConfig fails there on both accounts.
REGIONS_ACCT1=(
  "us-east-1|https://73ycczrhgtlloarfy7eoewnrem0upmbt.lambda-url.us-east-1.on.aws/"
  "us-east-2|https://kggf7cm4rxdpnnbnyjpubl76zy0gzsby.lambda-url.us-east-2.on.aws/"
  "us-west-1|https://tcpomdgtrevccx75pri5hs3cuq0wwpih.lambda-url.us-west-1.on.aws/"
  "us-west-2|https://sh367d2imdc7deu4gvij3miopa0hqayp.lambda-url.us-west-2.on.aws/"
  "ca-central-1|https://kzu4s5pg3s37cau35d2wwcwq6i0flyie.lambda-url.ca-central-1.on.aws/"
  "sa-east-1|https://6ss3eyuqn7ijhvasddiouubega0pvvov.lambda-url.sa-east-1.on.aws/"
  "eu-west-1|https://elfchvs2k2vfj3nyxpfg7ypuea0gqukp.lambda-url.eu-west-1.on.aws/"
  "eu-west-2|https://kbmbl3ugfyf2pty47wdi4xnp2y0rfcme.lambda-url.eu-west-2.on.aws/"
  "eu-west-3|https://4dmhydmdeutwhrlcwltsbcdnwm0xoros.lambda-url.eu-west-3.on.aws/"
  "eu-central-1|https://i6nlphgtx7vqmsuwsqnbtrbmqu0xmswm.lambda-url.eu-central-1.on.aws/"
  "eu-north-1|https://kifrwk2qpuyj7fnhafpnella3q0nzgqm.lambda-url.eu-north-1.on.aws/"
  "ap-south-1|https://unhbbbzarjcld3fjf472dzsgjy0nushh.lambda-url.ap-south-1.on.aws/"
  "ap-southeast-1|https://bcscvebmzkdkbvjvkqkfj7g6sq0rutdh.lambda-url.ap-southeast-1.on.aws/"
  "ap-southeast-2|https://ahtkkij52qpizvspk7bvt6owne0mqtqd.lambda-url.ap-southeast-2.on.aws/"
  "ap-northeast-1|https://i2l7mk74cu7qa2m5jvfz4aiaye0uosun.lambda-url.ap-northeast-1.on.aws/"
  "ap-northeast-2|https://zihehckt4zcuaqvjz6scjr53qi0etxxo.lambda-url.ap-northeast-2.on.aws/"
  "ap-northeast-3|https://fdcdnaeuvbmcmbrzwqay33mwqq0lvaqp.lambda-url.ap-northeast-3.on.aws/"
)

# Account 2 (AWS 042467473346, profile relay2): 17 live regions, pools are
# named aws2-relay-<region>. The URLs are distinct from Account 1 even in the
# same region, which is the point of running two accounts.
REGIONS_ACCT2=(
  "us-east-1|https://32oypghcxlfd5ze2ybihm7toka0iptbz.lambda-url.us-east-1.on.aws/"
  "us-east-2|https://h7awctsz544g7mbh2azppbs6ka0vvgdu.lambda-url.us-east-2.on.aws/"
  "us-west-1|https://c5uk4dlkkytkkob5pgbtblwnqy0qviue.lambda-url.us-west-1.on.aws/"
  "us-west-2|https://2aggiayr5awhnyguw4oe4yxzuu0jhyiz.lambda-url.us-west-2.on.aws/"
  "ca-central-1|https://qi24iirizssqe4kewgumk6f6bq0vqwjg.lambda-url.ca-central-1.on.aws/"
  "sa-east-1|https://6p7lvrbedpp23ian4mb7luf2xq0ndvpe.lambda-url.sa-east-1.on.aws/"
  "eu-west-1|https://jpryz5vyndnk2zis2dxza4r3p40gqpyn.lambda-url.eu-west-1.on.aws/"
  "eu-west-2|https://tlk5tjcyhlmgbvp7melgd7lowe0tcizv.lambda-url.eu-west-2.on.aws/"
  "eu-west-3|https://5vekwwpemmx5b6hpjicyffhmli0ahmro.lambda-url.eu-west-3.on.aws/"
  "eu-central-1|https://7ctkf27oudrjmud73ek3bna5oa0lqgwj.lambda-url.eu-central-1.on.aws/"
  "eu-north-1|https://e63ltnmvootkzy7vfxsfsn7spq0qtwqr.lambda-url.eu-north-1.on.aws/"
  "ap-south-1|https://mbishlq4stdlqrtoflar25ee2m0idwhu.lambda-url.ap-south-1.on.aws/"
  "ap-southeast-1|https://iw2yi3ezg4paw2ujrdz4q46ssi0xibwa.lambda-url.ap-southeast-1.on.aws/"
  "ap-southeast-2|https://almlmfesqu5fgeowv5jl27kuy40xgadq.lambda-url.ap-southeast-2.on.aws/"
  "ap-northeast-1|https://3mtwgnny4kvnos5vlc6j2a37y40vfdod.lambda-url.ap-northeast-1.on.aws/"
  "ap-northeast-2|https://lj4bg6d3ufg6pqevrfr5tnzrjq0lhgzc.lambda-url.ap-northeast-2.on.aws/"
  "ap-northeast-3|https://nj7gj4pmnnisgtbnxwtfvllaii0tiach.lambda-url.ap-northeast-3.on.aws/"
)

# Derive the local CLI token used by the dashboard API. This mirrors
# src/shared/utils/machineId.js: sha256(machine-id + "9r-cli-auth" + secret).
CLI_TOKEN=${NINEROUTER_CLI_TOKEN:-}
if [ -z "${CLI_TOKEN}" ]; then
  CLI_TOKEN=$(node -e '
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const dir = process.env.DATA_DIR || path.join(os.homedir(), ".9router");
try {
  const raw = fs.readFileSync(path.join(dir, "machine-id"), "utf8").trim();
  const secret = fs.readFileSync(path.join(dir, "auth", "cli-secret"), "utf8").trim();
  process.stdout.write(crypto.createHash("sha256").update(raw + "9r-cli-auth" + secret).digest("hex").substring(0, 16));
} catch {}
' 2>/dev/null || true)
fi

api_curl() {
  if [ -n "${CLI_TOKEN}" ]; then
    curl -H "x-9r-cli-token: ${CLI_TOKEN}" "$@"
  else
    curl "$@"
  fi
}

echo "=== AWS Lambda Relay Pool Registration ==="
echo "Target: ${BASE_URL}"
if [ "${CHECK_ONLY}" -eq 1 ]; then
  echo "Mode: check-only (no pools will be deleted or created)"
else
  echo "Mode: replace (existing aws-relay-* and aws2-relay-* pools will be recreated)"
fi
echo ""

# Preflight before deleting anything: fail with a useful message if the local
# API is down or the CLI token is wrong.
HTTP_CODE=$(api_curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/api/proxy-pools" || true)
if [ "${HTTP_CODE}" != "200" ]; then
  echo "ERROR: GET ${BASE_URL}/api/proxy-pools returned HTTP ${HTTP_CODE:-000}." >&2
  echo "Start 9router, then retry. If it uses a custom DATA_DIR, export DATA_DIR;" >&2
  echo "otherwise set NINEROUTER_CLI_TOKEN to the local CLI token." >&2
  exit 1
fi

if [ "${CHECK_ONLY}" -eq 0 ]; then
  # Remove stale pools matching either account's naming prefix. Parse the API
  # JSON with Node so field order/formatting changes don't break the cleanup.
  echo "Cleaning old aws-relay/aws2-relay pools..."
  POOLS_JSON=$(api_curl -s "${BASE_URL}/api/proxy-pools" 2>/dev/null || true)
  POOL_IDS=$(printf '%s' "${POOLS_JSON}" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  try {
    for (const p of JSON.parse(s).proxyPools || []) {
      if (/^aws2?-relay-/.test(p.name || "")) console.log(p.id);
    }
  } catch {}
});
' 2>/dev/null || true)
  while IFS= read -r id; do
    [ -n "${id}" ] || continue
    echo "  deleting ${id}"
    api_curl -s -X DELETE "${BASE_URL}/api/proxy-pools/${id}" >/dev/null 2>&1 || true
  done <<< "${POOL_IDS}"

  # Create one proxy pool record. AWS Function URLs use the same header contract
  # as the Cloudflare/Vercel relays, so they are stored as type "cloudflare".
  create_pool() {
    local name=$1
    local url=$2
    echo "  creating ${name}"
    api_curl -s -X POST "${BASE_URL}/api/proxy-pools" \
      -H "Content-Type: application/json" \
      -d "{\"name\":\"${name}\",\"proxyUrl\":\"${url}\",\"type\":\"cloudflare\",\"isActive\":true,\"strictProxy\":false,\"noProxy\":\"\",\"port\":null,\"isVercelEdge\":true,\"strictProxyMode\":false,\"rateLimit\":100}" \
      >/dev/null
  }

  # Register Account 1 pools
  echo ""
  echo "Registering account 1 pools..."
  for entry in "${REGIONS_ACCT1[@]}"; do
    create_pool "aws-relay-${entry%%|*}" "${entry#*|}"
  done

  # Register Account 2 pools
  echo ""
  echo "Registering account 2 pools..."
  for entry in "${REGIONS_ACCT2[@]}"; do
    create_pool "aws2-relay-${entry%%|*}" "${entry#*|}"
  done
fi

# Verify both account prefixes and URL uniqueness.
echo ""
echo "=== Verification ==="
POOLS_JSON=$(api_curl -s "${BASE_URL}/api/proxy-pools" 2>/dev/null || true)
STATS=$(printf '%s' "${POOLS_JSON}" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  try {
    const pools = (JSON.parse(s).proxyPools || []).filter((p) => /^aws2?-relay-/.test(p.name || ""));
    const urls = new Set(pools.map((p) => p.proxyUrl));
    const a1 = pools.filter((p) => p.name.startsWith("aws-relay-")).length;
    const a2 = pools.filter((p) => p.name.startsWith("aws2-relay-")).length;
    console.log([pools.length, a1, a2, urls.size].join(" "));
  } catch {
    console.log("0 0 0 0");
  }
});
' 2>/dev/null || true)
read -r TOTAL ACCT1 ACCT2 UNIQUE <<< "${STATS:-0 0 0 0}"
echo "Registered: total=${TOTAL} account1=${ACCT1} account2=${ACCT2} uniqueUrls=${UNIQUE}"

if [ "${TOTAL}" -eq 34 ] && [ "${ACCT1}" -eq 17 ] && [ "${ACCT2}" -eq 17 ] && [ "${UNIQUE}" -eq 34 ]; then
  echo "SUCCESS: All 34 AWS Lambda relay pools registered (17 per account, 34 unique URLs)"
  exit 0
else
  echo "WARNING: Expected 34 pools (17/account, 34 unique URLs), found ${TOTAL} (${ACCT1}/${ACCT2}, ${UNIQUE} unique)"
  exit 1
fi
