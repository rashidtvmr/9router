# OpenCode Free session rotation

The free executor caches up to eight native session contexts for five minutes.
On a FreeTierError, quota exhaustion, or rate limit, a chat-completions request
is retried once with the cached native `x-session-id`, `x-session-affinity`, and
versioned `User-Agent`. The cached native body is only a shape template; the
current model and messages remain authoritative. Non-chat bodies are not retried.

## DC / Lambda relay IP rotation

OpenCode's anonymous free tier keys quota on the connecting egress IP. When the
free tier returns a rate-limit or eligibility error, replaying the request on the
*same IP* will fail again. The default `rotateUpstream` hook cycles through all
active relay/proxy pool entries (Vercel, Cloudflare Workers, or Deno Deploy — the
backends used for AWS Lambda relay functions, each with a distinct egress IP)
and returns a different `proxyUrl` for the retry attempt.

The selection uses round-robin across all eligible pools, skipping the pool whose
URL matches the currently-bound base URL so the retry always gets a genuinely
fresh egress IP. If no relay pools are configured or the DB lookup fails, the
hook fails open and returns the original base URL.

```js
// Configuration is in open-sse/config/opencodeFreeSession.js
OPENCODE_FREE_SESSION_ROTATION.rotateUpstream = async (provider, currentBaseUrl) => {
  // ...queries getProxyPools() for relay-type pools and round-robins
  return rotatedBaseUrl; // or currentBaseUrl on error/empty
};
```
