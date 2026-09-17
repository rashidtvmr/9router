# OpenCode Free session rotation

The free executor caches up to eight native session contexts for five minutes.
On a FreeTierError, quota exhaustion, or rate limit, a chat-completions request
is retried once with the cached native `x-session-id`, `x-session-affinity`, and
versioned `User-Agent`. The cached native body is only a shape template; the
current model and messages remain authoritative. Non-chat bodies are not retried.

Upstream rotation is opt-in through the config hook:

```js
import { OPENCODE_FREE_SESSION_ROTATION } from "./opencodeFreeSession.js";

OPENCODE_FREE_SESSION_ROTATION.rotateUpstream = async (provider, currentBaseUrl) => {
  if (provider !== "opencode") return currentBaseUrl;
  return process.env.OPENCODE_ROTATED_BASE_URL || currentBaseUrl;
};
```

The default hook returns the current base URL. Rotation failures fail open and
preserve the configured upstream.
