# Scratchpad: OpenCode Free Tier Native Session Bootstrap

## Problem
The 9da31e44 commit implemented **session replay** only. On a fresh install
(empty cache), the first request to OpenCode free tier returns 403, and there
is nothing cached to replay with. Lambda relay IP rotation only runs on retry,
so it cannot fix the cold-start. The native-looking headers (x-session-id,
x-opencode-session, etc.) identify a session but do NOT establish one.

## Solution
Added a **cold-start bootstrap** probe inside the retry path of
`OpenCodeExecutor._retryWithNativeSession()`. When a free-tier request hits a
FreeTierError and the cache is empty, we fire a lightweight probe to
`/zen/v1/chat/completions` (1 token, single "hi" message). The probe's
`x-session-id` response header gives us a native session id, which we cache
and replay with on a fresh egress IP via the existing relay rotation.

## Final design
- Bootstrap is **lazy** — only fires on a free-tier 403 with empty cache.
- It runs inside `_retryWithNativeSession()` (not before the main request),
  so existing tests' mock-sequence assumptions are preserved.
- Single-flight guard via module-level `nativeBootstrapPromise` prevents
  concurrent duplicate probes.
- Fail-open: bootstrap failure returns `null` from the cache check, so
  `_retryWithNativeSession` returns `null` and the original 403 is returned to
  the client.
- Authenticated (non-public) connections skip bootstrap entirely.

## Files changed
- `open-sse/config/opencodeFreeSession.js` — added `OPENCODE_NATIVE_SESSION_BOOTSTRAP`
- `open-sse/executors/opencode.js` — added `nativeBootstrapPromise` guard,
  `bootstrapNativeSession()` method, and bootstrap invocation in `_retryWithNativeSession()`
- `tests/unit/opencode-free-session-rotation.test.js` — replaced the obsolete
  "no-op when cache is empty" test with 3 new cold-start tests

## Test results
All 14 tests in `tests/unit/opencode-free-session-rotation.test.js` pass.
The pre-existing failure in `opencode-muse-spark-thinking.test.js` is unrelated
(missing `@/lib/dataDir.js` alias — fails on clean master too).

## Implementation status: DONE
