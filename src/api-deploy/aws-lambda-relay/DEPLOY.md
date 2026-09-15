# AWS Lambda relay pool (17 regions)

Streaming pass-through relay for the opencode zen free tier. Deployed as
`zen-relay` (nodejs22.x, arm64, 256MB, timeout 120s) with a public Function
URL (auth NONE, invoke mode RESPONSE_STREAM) per region.

## Why
Zen keys the anonymous (`Bearer public`) free quota on the connecting IP.
Cloudflare Workers relays all share one anycast egress IP, so they are useless
here. Each AWS region egresses from a distinct NAT pool, giving 17 IPs.

## Requirements
New AWS accounts (Oct 2025+) block public function URLs until BOTH
permissions exist on the function (alias `LIVE`):
  - lambda:InvokeFunctionUrl, principal *, FunctionUrlAuthType NONE
  - lambda:InvokeFunction   , principal *
Only the first is added automatically by `create-function-url-config`.

Note: `put-public-access-block-config` is NOT in AWS CLI 2.34 / boto3 1.43.

## Relay contract
Identical to the CF/Vercel relay workers:
  headers: x-relay-target (scheme://host), x-relay-path (/path?query)
  fallback query: ?target=<full-url>
Register each function URL as proxy pool type `cloudflare` (same header
spec), name `aws-relay-<region>`.

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

## Regions live (ap-south-2 fails CreateFunctionUrlConfig on this account)
us-east-1/2, us-west-1/2, ca-central-1, sa-east-1, eu-west-1/2/3, eu-central-1,
eu-north-1, ap-south-1, ap-southeast-1/2, ap-northeast-1/2/3
