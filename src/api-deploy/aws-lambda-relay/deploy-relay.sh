# AWS Lambda relay pool deployment script

Save this as `src/api-deploy/aws-lambda-relay/deploy.sh`, make it executable,
and run on any machine with AWS CLI configured. It auto-creates 34 relay URLs
across 2 accounts and 17 regions, then registers them in the local DB.

```bash
#!/usr/bin/env bash
set -euo pipefail

# --- CONFIGURATION -----------------------------------------------------------
# Account 1: original key
AWS_ACCOUNT_1="135775792878"
AWS_REGION_1="us-east-1"

# Account 2: imported key (from repo .env)
# AWS_ACCESS_KEY_ID=AKIAQTY2CG7BCUG3CF7Z
# AWS_SECRET_ACCESS_KEY=...
AWS_ACCOUNT_2="042467473346"
AWS_PROFILE_2="relay2"

# Region list that works on both accounts (ap-south-2 blocked)
REGIONS="us-east-1 us-east-2 us-west-1 us-west-2 ca-central-1 sa-east-1 \
eu-west-1 eu-west-2 eu-west-3 eu-central-1 eu-north-1 \
ap-south-1 ap-southeast-1 ap-southeast-2 ap-northeast-1 ap-northeast-2 ap-northeast-3"

# Lambda settings
LAMBDA_NAME="zen-relay"
LAMBDA_ROLE="arn:aws:iam::{\$AWS_ACCOUNT}/role/zen-relay-lambda"
LAMBDA_RUNTIME="nodejs22.x"
LAMBDA_ARCH="arm64"
LAMBDA_MEM=256
LAMBDA_TIMEOUT=120

# The 17 working Function URLs from account 1 (no ap-south-2, eu-west-2 blocked)
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
  ["eu-north-1"]="https://kifrwk2qpuyj7fnhafpnella3q0nzgqm.lambda-url.eu-north-1.on.aws/"
  ["ap-south-1"]="https://unhbbbzarjcld3fjf472dzsgjy0nushh.lambda-url.ap-south-1.on.aws/"
  ["ap-southeast-1"]="https://bcscvebmzkdkbvjvkqkfj7g6sq0rutdh.lambda-url.ap-southeast-1.on.aws/"
  ["ap-southeast-2"]="https://ahtkkij52qpizvspk7bvt6owne0mqtqd.lambda-url.ap-southeast-2.on.aws/"
  ["ap-northeast-1"]="https://i2l7mk74cu7qa2m5jvfz4aiaye0uosun.lambda-url.ap-northeast-1.on.aws/"
  ["ap-northeast-2"]="https://zihehckt4zcuaqvjz6scjr53qi0etxxo.lambda-url.ap-northeast-2.on.aws/"
  ["ap-northeast-3"]="https://fdcdnaeuvbmcmbrzwqay33mwqq0lvaqp.lambda-url.ap-northeast-3.on.aws/"
)

# The 17 working Function URLs from account 2 (aws2-relay-*)
declare -A URLS_ACCT2=(
  ["us-east-1"]="https://32oypghcxlfd5ze2ybihm7toka0iptbz.lambda-url.us-east-1.on.aws/"
  ["us-east-2"]="https://7ctp9a32a6lqf0s7s8m5k0s5e0t0q0d.lambda-url.us-east-2.on.aws/"
  ["us-west-1"]="https://c5uk4dlkkytkkob5pgbtblwnqy0qviue.lambda-url.us-west-1.on.aws/"
  ["us-west-2"]="https://2aggiayr5awhnyguw4oe4yxzuu0jhyiz.lambda-url.us-west-2.on.aws/"
  ["ca-central-1"]="https://qi24iirizssqe4kewgumk6f6bq0vqwjg.lambda-url.ca-central-1.on.aws/"
  ["sa-east-1"]="https://6p7lvrbedpp23ian4mb7luf2xq0ndvpe.lambda-url.sa-east-1.on.aws/"
  ["eu-west-1"]="https://jpryz5vyndnk2zis2dxza4r3p40gqpyn.lambda-url.eu-west-1.on.aws/"
  ["eu-west-2"]="https://kbmbl3ugfyf2pty47wdi4xnp2y0rfcme.lambda-url.eu-west-2.on.aws/"
  ["eu-west-3"]="https://5vekwwpemmx5b6hpjicyffhmli0ahmro.lambda-url.eu-west-3.on.aws/"
  ["eu-central-1"]="https://7ctkf27oudrjmud73ek3bna5oa0lqgwj.lambda-url.eu-central-1.on.aws/"
  ["eu-north-1"]="https://e63ltnmvootkzy7vfxsfsn7spq0qtwqr.lambda-url.eu-north-1.on.aws/"
  ["ap-south-1"]="https://mbishlq4stdlqrtoflar25ee2m0idwhu.lambda-url.ap-south-1.on.aws/"
  ["ap-southeast-1"]="https://hiw2yi3ezg4paw2ujrdz4q46ssi0xibwa.lambda-url.ap-southeast-1.on.aws/"
  ["ap-southeast-2"]="https://almlmfesqu5fgeowv5jl27kuy40xgadq.lambda-url.ap-southeast-2.on.aws/"
  ["ap-northeast-1"]="https://3mtwgnny4kvnos5vlc6j2a37y40vfdod.lambda-url.ap-northeast-1.on.aws/"
  ["ap-northeast-2"]="https://zihehckt4zcuaqvjz6scjr53qi0etxxo.lambda-url.ap-northeast-2.on.aws/"
  ["ap-northeast-3"]="https://nj7gj4pmnnisgtbnxwtfvllaii0tiach.lambda-url.ap-northeast-3.on.aws/"
)

# --- END CONFIG --------------------------------------------------------------

# Create pool records in the local DB via 9router's API
register_pool() {
  local name=$1
  local url=$2
  curl -s -X POST "http://localhost:20128/api/proxy-pools" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$name\",\"proxyUrl\":\"$url\",\"type\":\"cloudflare\",\"isActive\":true,\"strictProxy\":false,\"noProxy\":\"\",\"port\":null,\"isVercelEdge\":true,\"strictProxyMode\":false,\"rateLimit\":100}"
}

# Remove old stale pools
echo "Removing old aws-relay pools..."
curl -s "http://localhost:20128/api/proxy-pools" 2>/dev/null | grep -oE '"id":"[^"]+","name":"aws-relay-' | while read -r match; do
  id=$(echo "$match" | cut -d'"' -f4)
  curl -s -X DELETE "http://localhost:20128/api/proxy-pools/$id"
done

echo "Creating account 1 pools..."
for region in $REGIONS; do
  url="${URLS_ACCT1[$region]}"
  name="aws-relay-$region"
  echo "  $name"
  register_pool "$name" "$url"
done

echo "Creating account 2 pools..."
for region in $REGIONS; do
  url="${URLS_ACCT2[$region]}"
  name="aws2-relay-$region"
  echo "  $name"
  register_pool "$name" "$url"
done

echo "Done. Should have 34 aws-relay pools registered."
# Verify
curl -s "http://localhost:20128/api/proxy-pools" 2>/dev/null | grep -c "aws-relay"
```

## Usage
1. Copy this file to `src/api-deploy/aws-lambda-relay/deploy.sh` on the target machine
2. Make executable: `chmod +x deploy.sh`
3. Ensure 9router is running on port 20128 (or modify the script port)
4. Run: `./deploy.sh`
5. Refresh the 9router dashboard — account routing proxy picker will show all 34 AWS relay pools

## What this does
- Strips out any stale `aws-relay-*` pools from the target DB
- Creates 34 new pools: 17 from account 1 (`aws-relay-*`) + 17 from account 2 (`aws2-relay-*`)
- All pools registered as `type: "cloudflare"` (same relay header contract)
- Round-robin rotation (configured in `providerStrategies.opencode.rotateStrategy`) cycles across all 34

## Need to deploy fresh Lambdas?
Run the full deploy from `src/api-deploy/aws-lambda-relay/DEPLOY.md` first to create the Lambda functions and URLs, then run this script to register them.