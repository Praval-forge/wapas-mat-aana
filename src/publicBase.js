// Trusted public base URL for buyer links in generated messages.
// Order of trust: PUBLIC_BASE_URL (operator-configured) > RENDER_EXTERNAL_URL
// (set by Render for web services) > the request's own origin (local dev only,
// host-validated) > http://localhost:<PORT>. Configure PUBLIC_BASE_URL behind
// any proxy so a spoofed Host header can never put a foreign link in a message.
function fromEnv() {
  for (const v of [process.env.PUBLIC_BASE_URL, process.env.RENDER_EXTERNAL_URL]) {
    if (!v) continue;
    try {
      const u = new URL(v);
      if ((u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password) return u.origin;
    } catch { /* ignore invalid values */ }
  }
  return null;
}

export function trustedBase(req) {
  const env = fromEnv();
  if (env) return env;
  const host = req?.get?.('host');
  if (host && /^[a-z0-9.-]+(:\d{1,5})?$/i.test(host)) return `${req.protocol === 'https' ? 'https' : 'http'}://${host}`;
  return `http://localhost:${Number(process.env.PORT) || 3000}`;
}
