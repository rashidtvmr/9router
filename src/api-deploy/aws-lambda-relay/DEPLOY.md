# AWS Lambda relay pool (17 regions × 2 accounts = 34 relays)

Streaming pass-through relay for the opencode zen free tier. Deployed as
`zen-relay` (nodejs22.x, arm64, 256MB, timeout 120s) with a public Function
URL (auth NONE, invoke mode RESPONSE_STREAM) per region.

## Source of truth

| Piece | Path |
| --- | --- |
| Canonical seed inventory | `src/lib/db/seeds/defaultRelayPools.js` |
| Registration script | `src/api-deploy/aws-lambda-relay/deploy-relay.sh` |
| Relay handler | `src/api-deploy/aws-lambda-relay/index.mjs` |
| Inventory / parity test | `tests/unit/relay-pool-seed.test.js` |

The seed also contains one Cloudflare Worker (`cloudflare-relay-via-router`);
it is not part of the 34 AWS relays. The seed and the registration script must
contain the same 34 URLs. The inventory test checks 17 + 17, unique URLs, and
that this document lists every URL.

## Why

Zen keys the anonymous (`Bearer public`) free quota on the connecting IP.
Cloudflare Workers relays all share one anycast egress IP, so they are useless
here. Each AWS region egresses from a distinct NAT pool. Running two AWS
accounts per region gives 34 independent egress IPs.

## Relay contract

Identical to the CF/Vercel relay workers:

- headers: `x-relay-target` (`scheme://host`), `x-relay-path` (`/path?query`)
- fallback query: `?target=<full-url>`

Register each function URL as proxy pool type `cloudflare` (same header spec),
named `aws-relay-<region>` or `aws2-relay-<region>`. The `cloudflare` type is the
relay discriminator used by `OPENCODE_FREE_SESSION_ROTATION`
(`vercel`/`cloudflare`/`deno`); it does not mean the relay runs on Cloudflare.

## Inventory

Account 1 (`135775792878`, profile `lenovo-cli`) uses `aws-relay-*`.
Account 2 (`042467473346`, profile `relay2`) uses `aws2-relay-*`.

| Region | Account 1 — `aws-relay-<region>` | Account 2 — `aws2-relay-<region>` |
| --- | --- | --- |
| `us-east-1` | https://73ycczrhgtlloarfy7eoewnrem0upmbt.lambda-url.us-east-1.on.aws/ | https://32oypghcxlfd5ze2ybihm7toka0iptbz.lambda-url.us-east-1.on.aws/ |
| `us-east-2` | https://kggf7cm4rxdpnnbnyjpubl76zy0gzsby.lambda-url.us-east-2.on.aws/ | https://h7awctsz544g7mbh2azppbs6ka0vvgdu.lambda-url.us-east-2.on.aws/ |
| `us-west-1` | https://tcpomdgtrevccx75pri5hs3cuq0wwpih.lambda-url.us-west-1.on.aws/ | https://c5uk4dlkkytkkob5pgbtblwnqy0qviue.lambda-url.us-west-1.on.aws/ |
| `us-west-2` | https://sh367d2imdc7deu4gvij3miopa0hqayp.lambda-url.us-west-2.on.aws/ | https://2aggiayr5awhnyguw4oe4yxzuu0jhyiz.lambda-url.us-west-2.on.aws/ |
| `ca-central-1` | https://kzu4s5pg3s37cau35d2wwcwq6i0flyie.lambda-url.ca-central-1.on.aws/ | https://qi24iirizssqe4kewgumk6f6bq0vqwjg.lambda-url.ca-central-1.on.aws/ |
| `sa-east-1` | https://6ss3eyuqn7ijhvasddiouubega0pvvov.lambda-url.sa-east-1.on.aws/ | https://6p7lvrbedpp23ian4mb7luf2xq0ndvpe.lambda-url.sa-east-1.on.aws/ |
| `eu-west-1` | https://elfchvs2k2vfj3nyxpfg7ypuea0gqukp.lambda-url.eu-west-1.on.aws/ | https://jpryz5vyndnk2zis2dxza4r3p40gqpyn.lambda-url.eu-west-1.on.aws/ |
| `eu-west-2` | https://kbmbl3ugfyf2pty47wdi4xnp2y0rfcme.lambda-url.eu-west-2.on.aws/ | https://tlk5tjcyhlmgbvp7melgd7lowe0tcizv.lambda-url.eu-west-2.on.aws/ |
| `eu-west-3` | https://4dmhydmdeutwhrlcwltsbcdnwm0xoros.lambda-url.eu-west-3.on.aws/ | https://5vekwwpemmx5b6hpjicyffhmli0ahmro.lambda-url.eu-west-3.on.aws/ |
| `eu-central-1` | https://i6nlphgtx7vqmsuwsqnbtrbmqu0xmswm.lambda-url.eu-central-1.on.aws/ | https://7ctkf27oudrjmud73ek3bna5oa0lqgwj.lambda-url.eu-central-1.on.aws/ |
| `eu-north-1` | https://kifrwk2qpuyj7fnhafpnella3q0nzgqm.lambda-url.eu-north-1.on.aws/ | https://e63ltnmvootkzy7vfxsfsn7spq0qtwqr.lambda-url.eu-north-1.on.aws/ |
| `ap-south-1` | https://unhbbbzarjcld3fjf472dzsgjy0nushh.lambda-url.ap-south-1.on.aws/ | https://mbishlq4stdlqrtoflar25ee2m0idwhu.lambda-url.ap-south-1.on.aws/ |
| `ap-southeast-1` | https://bcscvebmzkdkbvjvkqkfj7g6sq0rutdh.lambda-url.ap-southeast-1.on.aws/ | https://iw2yi3ezg4paw2ujrdz4q46ssi0xibwa.lambda-url.ap-southeast-1.on.aws/ |
| `ap-southeast-2` | https://ahtkkij52qpizvspk7bvt6owne0mqtqd.lambda-url.ap-southeast-2.on.aws/ | https://almlmfesqu5fgeowv5jl27kuy40xgadq.lambda-url.ap-southeast-2.on.aws/ |
| `ap-northeast-1` | https://i2l7mk74cu7qa2m5jvfz4aiaye0uosun.lambda-url.ap-northeast-1.on.aws/ | https://3mtwgnny4kvnos5vlc6j2a37y40vfdod.lambda-url.ap-northeast-1.on.aws/ |
| `ap-northeast-2` | https://zihehckt4zcuaqvjz6scjr53qi0etxxo.lambda-url.ap-northeast-2.on.aws/ | https://lj4bg6d3ufg6pqevrfr5tnzrjq0lhgzc.lambda-url.ap-northeast-2.on.aws/ |
| `ap-northeast-3` | https://fdcdnaeuvbmcmbrzwqay33mwqq0lvaqp.lambda-url.ap-northeast-3.on.aws/ | https://nj7gj4pmnnisgtbnxwtfvllaii0tiach.lambda-url.ap-northeast-3.on.aws/ |

`ap-south-2` is intentionally absent: `CreateFunctionUrlConfig` fails there on
both accounts. All URLs are public Function URLs (auth NONE). They are
infrastructure endpoints, not API keys. Do not commit AWS credentials.

## Requirements

New AWS accounts (Oct 2025+) block public function URLs until BOTH permissions
exist on the function (alias `LIVE`):

- `lambda:InvokeFunctionUrl`, principal `*`, `FunctionUrlAuthType NONE`
- `lambda:InvokeFunction`, principal `*`

Only the first is added automatically by `create-function-url-config`.

Note: `put-public-access-block-config` is NOT in AWS CLI 2.34 / boto3 1.43.

## Deploy (per region)

```bash
zip -q relay.zip index.mjs
aws lambda create-function --region $R --function-name zen-relay \
  --runtime nodejs22.x --architectures arm64 --handler index.handler \
  --memory-size 256 --timeout 120 --zip-file fileb://relay.zip \
  --role arn:aws:iam::<account>:role/zen-relay-lambda
aws lambda wait function-active --region $R --function-name zen-relay
aws lambda publish-version --region $R --function-name zen-relay
aws lambda create-alias --region $R --function-name zen-relay --name LIVE --function-version 1
aws lambda add-permission --region $R --function-name zen-relay --qualifier LIVE \
  --action lambda:InvokeFunctionUrl --principal "*" --function-url-auth-type NONE --statement-id urlpub-alias
aws lambda add-permission --region $R --function-name zen-relay --qualifier LIVE \
  --action lambda:InvokeFunction --principal "*" --statement-id urlpub-invoke
aws lambda create-function-url-config --region $R --function-name zen-relay --qualifier LIVE \
  --auth-type NONE --invoke-mode RESPONSE_STREAM \
  --cors '{"AllowHeaders":["*"],"AllowMethods":["*"],"AllowOrigins":["*"],"MaxAge":86400}'
```

## Register with 9router

```bash
# Read-only: verify the 34 rows without changing anything.
ROUTER_PORT=20128 ./src/api-deploy/aws-lambda-relay/deploy-relay.sh --check

# Destructive: delete and recreate all aws-relay-* / aws2-relay-* rows.
ROUTER_PORT=20128 ./src/api-deploy/aws-lambda-relay/deploy-relay.sh
```

`ROUTER_PORT` defaults to `20128`. The script:

- derives the local `x-9r-cli-token` from `<DATA_DIR>/machine-id` and
  `<DATA_DIR>/auth/cli-secret` (default `DATA_DIR` is `~/.9router`), or uses
  `NINEROUTER_CLI_TOKEN` when set;
- preflights `GET /api/proxy-pools` and exits before deleting anything if the
  API is down or returns 401;
- deletes both `aws-relay-*` and `aws2-relay-*` rows, creates 17 + 17, then
  verifies total 34, 17 per account, and 34 unique URLs;
- is Bash 3.2 compatible (it does not use associative arrays).

The non-check run replaces the relay pool rows. The Lambda functions and URLs are
untouched, but pool ids change; if a provider connection pins a relay pool id,
re-point it afterward. To add a single relay without replacing the fleet, use
the dashboard or API instead.

## Update / rotate

1. Deploy the replacement function URL in AWS.
2. Add the URL to `src/lib/db/seeds/defaultRelayPools.js` and
   `deploy-relay.sh`.
3. Run the inventory test and `deploy-relay.sh --check`.
4. For an existing database, migration 002 inserts only missing `proxyUrl`
   values; it does not update an existing row in place. Add the new pool and
   delete the old one (the replace-mode script does this for the whole fleet).

## Verify egress

Each relay should return its own egress IP. For example:

```bash
curl -sS "https://<function-url>/" \
  -H 'x-relay-target: https://api.ipify.org' \
  -H 'x-relay-path: /?format=json'
```

Repeat for Account 1 and Account 2 in the same region; the IPs should differ.
Verified for `us-east-1`: `100.27.49.230` vs `13.221.160.235`. Round-robin
across all 34 active pools therefore yields 34 distinct IPs.

## Failure modes

- Public URL still returns 403: confirm both `add-permission` calls and the
  `LIVE` qualifier; newer accounts need both.
- `ap-south-2`: not deployed; `CreateFunctionUrlConfig` fails.
- `401 Unauthorized` from the local API: dashboard login is enabled and the
  script could not derive the CLI token. Start 9router, set `DATA_DIR` if it is
  non-default, or pass `NINEROUTER_CLI_TOKEN`.
- `ROUTER_PORT` is wrong: nothing listens on `localhost:20128`.
- Account 2 credentials are local deployment credentials only. If your deploy
  tooling reads `AWS_RELAY_ACCOUNT_2_*`, keep them in a gitignored `.env`;
  never commit them.
