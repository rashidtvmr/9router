#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# AWS Lambda Relay Pool Registration Script
# =============================================================================
# Usage: Run on any machine with 9router running on port 20128 after Lambda
# functions are deployed in both AWS accounts (see DEPLOY.md for that).
# =============================================================================

PORT=${9ROUTER_PORT:-20128}
BASE_URL="http://localhost:${PORT}"

# Account 1: 17 working regions (ap-south-2 blocked, eu-north-1 blocked on some accounts)
declare -A URLS_ACCT1=(
  ["us-east-1"]="https://73ycczrhgtlloarfy7eoewnrem0upmbt.lambda-url.us-east-1.on.aws/"
  ["us-east-2"]="https://kggf7cm4rxdpnnbnyjpubl76zy0gzsby.lambda-url.us-east-2.on.aws/"
  ["us-west-1"]="https://tcpomdgtrevccx75pri5hs3cuq0wwpih.lambda-url.us-west-1.on.aws/"
  ["us-west-2"]="https://sh367d2imdc7deu4gvij3miopa0hqayp.lambda-url.us-west-2.on.aws/"
  ["ca-central-1"]="https://kzu4s5pg3s37cau35d2wwcwq6i0flyie.lambda-url.ca-central-1.on.aws/"
  ["sa-east-1"]="https://6ss3eyuqn7ijhvasddiouubega0pvvov.lambda-url.sa-east-1.on.aws/"
  ["eu-west-1"]="https://elfchvs2k2vfj3nyxpfg7ypuea0gqukp.lambda-url.eu-west-1.on.aws/"
  ["eu-west-2"]="https://kbmbl3ugfyf2pty47wdi4xnp2y0rfcme.lambda-url.eu-west-2.on.aws/"
  ["eu-west-3"]="https://4dmhydmdeutwhrlcwltsbcdnwm0xoros.lambda-url.eu-west-3.on.aws/"
  ["eu-central-1"]="https://i6nlphgtx7vqmsuwsqnbtrbmqu0xmswm.lambda-url.eu-central-1.on.aws/"
  ["ap-south-1"]="https://unhbbbzarjcld3fjf472dzsgjy0nushh.lambda-url.ap-south-1.on.aws/"
  ["ap-southeast-1"]="https://bcscvebmzkdkbvjvkqkfj7g6sq0rutdh.lambda-url.ap-southeast-1.on.aws/"
  ["ap-southeast-2"]="https://ahtkkij52qpizvspk7bvt6owne0mqtqd.lambda-url.ap-southeast-2.on.aws/"
  ["ap-northeast-1"]="https://i2l7mk74cu7qa2m5jvfz4aiaye0uosun.lambda-url.ap-northeast-1.on.aws/"
  ["ap-northeast-2"]="https://zihehckt4zcuaqvjz6scjr53qi0etxxo.lambda-url.ap-northeast-2.on.aws/"
  ["ap-northeast-3"]="https://fdcdnaeuvbmcmbrzwqay33mwqq0lvaqp.lambda-url.ap-northeast-3.on.aws/"
)

# Account 2: 17 working regions (aws2-relay-* naming)
declare -A URLS_ACCT2=(
  ["us-east-1"]="https://32oypghcxlfd5ze2ybihm7toka0iptbz.lambda-url.us-east-1.on.aws/"
  ["us-east-2"]="https://h7awctsz544g7mbh2azppbs6ka0vvgdu.lambda-url.us-east-2.on.aws/"
  ["us-west-1"]="https://c5uk4dlkkytkkob5pgbtblwnqy0qviue.lambda-url.us-west-1.on.aws/"
  ["us-west-2"]="https://2aggiayr5awhnyguw4oe4yxzuu0jhyiz.lambda-url.us-west-2.on.aws/"
  ["ca-central-1"]="https://qi24iirizssqe4kewgumk6f6bq0vqwjg.lambda-url.ca-central-1.on.aws/"
  ["sa-east-1"]="https://6p7lvrbedpp23ian4mb7luf2xq0ndvpe.lambda-url.sa-east-1.on.aws/"
  ["eu-west-1"]="https://jpryz5vyndnk2zis2dxza4r3p40gqpyn.lambda-url.eu-west-1.on.aws/"
  ["eu-west-2"]="https://kbmbl3ugfyf2pty47wdi4xnp2y0rfcme.lambda-url.eu-west-2.on.aws/"
  ["eu-west-3"]="https://5vekwwpemmx5b6hpjicyffhmli0ahmro.lambda-url.eu-west-3.on.aws/"
  ["eu-central-1"]="https://7ctkf27oudrjmud73ek3bna5oa0lqgwj.lambda-url.eu-central-1.on.aws/"
  ["ap-south-1"]="https://mbishlq4stdlqrtoflar25ee2m0idwhu.lambda-url.ap-south-1.on.aws/"
  ["ap-southeast-1"]="https://iw2yi3ezg4paw2ujrdz4q46ssi0xibwa.lambda-url.ap-southeast-1.on.aws/"
  ["ap-southeast-2"]="https://almlmfesqu5fgeowv5jl27kuy40xgadq.lambda-url.ap-southeast-2.on.aws/"
  ["ap-northeast-1"]="https://3mtwgnny4kvnos5vlc6j2a37y40vfdod.lambda-url.ap-northeast-1.on.aws/"
  ["ap-northeast-2"]="https://zihehckt4zcuaqvjz6scjr53qi0etxxo.lambda-url.ap-northeast-2.on.aws/"
  ["ap-northeast-3"]="https://nj7gj4pmnnisgtbnxwtfvllaii0tiach.lambda-url.ap-northeast-3.on.aws/"
)

echo "=== AWS Lambda Relay Pool Registration ==="
echo "Target: ${BASE_URL}"
echo ""

# Remove old stale pools (only those matching our pattern)
echo "Cleaning old aws-relay pools..."
POOL_IDS=$(curl -s "${BASE_URL}/api/proxy-pools" 2>/dev/null | grep -oE '"id":"[^"]+"[^}]*"name":"aws-relay-[^"]*"' | cut -d'"' -f4)
for id in $POOL_IDS; do
  echo "  deleting ${id}"
  curl -s -X DELETE "${BASE_URL}/api/proxy-pools/${id}" >/dev/null 2>&1 || true
done

# Function to create a pool record
create_pool() {
  local name=$1
  local url=$2
  echo "  creating ${name}"
  curl -s -X POST "${BASE_URL}/api/proxy-pools" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"${name}\",\"proxyUrl\":\"${url}\",\"type\":\"cloudflare\",\"isActive\":true,\"strictProxy\":false,\"noProxy\":\"\",\"port\":null,\"isVercelEdge\":true,\"strictProxyMode\":false,\"rateLimit\":100}" \
    >/dev/null
}

# Register Account 1 pools
echo ""
echo "Registering account 1 pools..."
for region in "${!URLS_ACCT1[@]}"; do
  create_pool "aws-relay-${region}" "${URLS_ACCT1[$region]}"
done

# Register Account 2 pools
echo ""
echo "Registering account 2 pools..."
for region in "${!URLS_ACCT2[@]}"; do
  create_pool "aws2-relay-${region}" "${URLS_ACCT2[$region]}"
done

# Verify
echo ""
echo "=== Verification ==="
TOTAL=$(curl -s "${BASE_URL}/api/proxy-pools" | grep -c '"name":"aws-relay-' || echo 0)
echo "Total aws-relay pools registered: ${TOTAL}"

if [ "$TOTAL" -eq 34 ]; then
  echo "SUCCESS: All 34 pools registered"
  exit 0
else
  echo "WARNING: Expected 34 pools, found ${TOTAL}"
  exit 1
fi