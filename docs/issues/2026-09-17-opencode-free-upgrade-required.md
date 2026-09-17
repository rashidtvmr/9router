# OpenCode Free 426 UpgradeRequired

## Issue

OpenCode Free requests for Muse Spark 1.3 failed through 9Router with:

```text
[426]: {"type":"error","error":{"type":"UpgradeRequired","message":"Error from provider (Console): OpenCode 1.17.0 or newer is required to use the free tier"}}
```

The failure occurred even though the request was routed to the correct
OpenCode Free Responses API endpoint and included a versioned upstream
`User-Agent`. The remaining compatibility signal was the native OpenCode
session context.

## Root cause

`open-sse/executors/opencode.js` used the bare value `opencode` when the
downstream caller did not send an OpenCode user agent. OpenCode Console treats
that value as an old or unknown client and blocks anonymous free-tier traffic.

The previous implementation also forwarded any downstream user agent containing
the word `opencode`, including versions older than the required `1.17.0`.

Native OpenCode requests also send `x-session-id` and `x-session-affinity` with
the same stable session value. The Console free-tier gate rejects synthetic
requests without those headers, even when the user agent and request body match
a successful native request.

## Fix

The OpenCode Free executor now:

1. Sends `opencode/1.18.26` by default, which satisfies the current upstream
   minimum version.
2. Preserves a downstream OpenCode user agent only when it has a parseable
   version greater than or equal to `1.17.0`.
3. Replaces missing, malformed, non-OpenCode, and older OpenCode user agents
   with the supported versioned user agent.
4. Sends native OpenCode `x-session-id` and `x-session-affinity` headers using
   the same request-local session value.
5. Retains the existing `x-opencode-*` compatibility headers.

## Verification

- Added regression coverage for the versioned user-agent fallback and legacy
  downstream OpenCode user agents.
- Added regression coverage for native OpenCode session headers.
- The native OpenCode-to-9Router Big Pickle smoke test remains successful.
- Run the focused OpenCode tests with:

```bash
npx vitest run --config tests/vitest.config.js \
  tests/unit/opencode-muse-spark-thinking.test.js \
  tests/unit/opencode-go-session.test.js \
  tests/unit/opencode-go-muse-spark-responses.test.js
```

## Scope

This change only affects the OpenCode Free executor's upstream client and
session compatibility. It does not change authentication, model routing,
response translation, or proxy selection.
