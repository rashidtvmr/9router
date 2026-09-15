// zen-relay: streaming pass-through relay for 9router proxy pools.
// Contract identical to the CF/Vercel relay workers:
//   headers: x-relay-target (scheme://host), x-relay-path (/path?query)
//   fallback: ?target=<full-url>&path=</...>
// Streams upstream SSE through the Function URL response body.
// `awslambda` is a global injected by the Node.js Lambda runtime.

const HOP_HEADERS = new Set([
  "x-relay-target", "x-relay-path", "host", "connection", "content-length",
  "transfer-encoding", "keep-alive", "upgrade", "expect",
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
  "x-amzn-trace-id", "x-amz-cf-id", "via", "accept-encoding",
]);

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const q = event.queryStringParameters || {};
  const headers = event.headers || {};
  const target = headers["x-relay-target"] || q.target;
  const relayPath = headers["x-relay-path"] || q.path || "/";
  const method = event.requestContext?.http?.method || event.httpMethod || "GET";

  const bad = (status, obj) => {
    const s = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: status,
      headers: { "content-type": "application/json" },
    });
    s.write(JSON.stringify(obj));
    s.end();
  };

  if (!target) {
    return bad(400, { error: "missing target: set x-relay-target header (plus optional x-relay-path) or ?target=<full-url>" });
  }

  let url;
  try {
    url = new URL(target.replace(/\/$/, "") + relayPath);
  } catch {
    return bad(400, { error: "invalid target url" });
  }

  const fwdHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (HOP_HEADERS.has(lk)) continue;
    if (Array.isArray(v)) fwdHeaders[lk] = v.join(", ");
    else if (v !== undefined && v !== null) fwdHeaders[lk] = String(v);
  }
  fwdHeaders["accept-encoding"] = "identity"; // raw chunks pass through verbatim

  try {
    const body = method === "GET" || method === "HEAD" ? undefined
      : event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString()
      : event.body;
    const upstream = await fetch(url, {
      method,
      headers: fwdHeaders,
      body,
      redirect: "manual",
    });

    const resHeaders = {};
    for (const [k, v] of upstream.headers) {
      const lk = k.toLowerCase();
      if (lk === "content-encoding" || lk === "content-length" || lk === "transfer-encoding") continue;
      resHeaders[lk] = v;
    }

    const stream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: upstream.status,
      headers: resHeaders,
    });

    const reader = upstream.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        stream.write(value);
      }
    } else {
      stream.write(new Uint8Array(await upstream.arrayBuffer()));
    }
    stream.end();
  } catch (err) {
    try {
      bad(502, { error: err?.message || String(err) });
    } catch { /* stream already committed */ }
  }
});
