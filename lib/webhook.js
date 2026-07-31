// Verify a Resend (Svix) webhook signature on the edge runtime.
// Resend signs each webhook endpoint with its OWN secret (looks like "whsec_…").
// Because we run two endpoints (events + inbound), we check the signature
// against every configured secret and pass if ANY matches:
//   RESEND_WEBHOOK_SECRET          (shared / single-webhook setups)
//   RESEND_WEBHOOK_SECRET_EVENTS   (the events webhook)
//   RESEND_WEBHOOK_SECRET_INBOUND  (the inbound webhook)
// If none are set, verification is skipped (fine for testing, NOT production).

function b64ToBytes(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function bytesToB64(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}

// Returns true if the raw request body is authentic. `rawBody` must be the
// exact string received (read BEFORE JSON.parse).
//
// Header access works for BOTH runtimes: Fetch-style `req.headers.get(name)`
// AND Node classic handlers where `req.headers` is a plain lowercased object.
function getHeader(req, name) {
  const h = req && req.headers;
  if (!h) return undefined;
  if (typeof h.get === 'function') return h.get(name);
  return h[name] || h[name.toLowerCase()];
}

export async function verifyResendSignature(req, rawBody) {
  const secrets = [
    process.env.RESEND_WEBHOOK_SECRET,
    process.env.RESEND_WEBHOOK_SECRET_EVENTS,
    process.env.RESEND_WEBHOOK_SECRET_INBOUND,
  ].filter(Boolean);
  if (secrets.length === 0) return true; // dev fallback

  const id = getHeader(req, 'svix-id');
  const ts = getHeader(req, 'svix-timestamp');
  const sigHeader = getHeader(req, 'svix-signature');
  if (!id || !ts || !sigHeader) return false;

  const signed = new TextEncoder().encode(`${id}.${ts}.${rawBody}`);
  for (const secret of secrets) {
    try {
      const secretBytes = b64ToBytes(secret.split('_')[1] || secret);
      const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const mac = await crypto.subtle.sign('HMAC', key, signed);
      const expected = bytesToB64(mac);
      // Header is a space-separated list of "v1,<sig>" pairs.
      if (sigHeader.split(' ').some((part) => part.split(',')[1] === expected)) return true;
    } catch {}
  }
  return false;
}
