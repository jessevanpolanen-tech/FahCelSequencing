// ── Unsubscribe ─────────────────────────────────────────────────────
// GET /api/unsubscribe?t=<base64url(email)>
// Linked from every email footer. Stops all active sequences for that email
// and records the opt-out. Returns a simple confirmation page.
//
// Node.js classic (req, res) handler.
import { findLeadByEmail, stopEnrollmentsForEmail, logEvent } from '../lib/db.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  const host = req.headers.host || 'localhost';
  const url = new URL(req.url, `https://${host}`);
  const token = url.searchParams.get('t') || '';
  let email = '';
  try {
    const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
    email = decodeURIComponent(escape(Buffer.from(b64, 'base64').toString('binary')));
  } catch {}

  if (!email || !email.includes('@')) {
    sendHtml(res, "That unsubscribe link looks invalid. Email sales@fahcel.co and we'll remove you by hand.", 400);
    return;
  }

  try {
    await stopEnrollmentsForEmail(email, 'unsubscribed');
    const lead = await findLeadByEmail(email);
    await logEvent({ leadId: lead ? lead.id : null, email, type: 'unsubscribed', meta: { source: 'link' } });
    sendHtml(res, `You're unsubscribed. <b>${escapeHtml(email)}</b> won't receive any further outreach from FahCel.`);
  } catch (err) {
    sendHtml(res, "Something went wrong unsubscribing you. Email sales@fahcel.co and we'll remove you by hand.", 500);
  }
}

function sendHtml(res, message, status = 200) {
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribe · FahCel</title>
<style>
  body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#F4F1EC;color:#111315;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
  .card{background:#fff;border:1px solid #E4DED3;max-width:440px;padding:40px 36px;text-align:center}
  .dot{width:34px;height:34px;border-radius:50%;background:#111315;margin:0 auto 18px}
  p{font-size:15px;line-height:1.55;color:#3A3F45}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#8A8578;margin-bottom:14px}
</style>
<div class="card"><div class="dot"></div><div class="mono">FahCel</div><p>${message}</p></div>`;
  res.status(status).setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(body);
}

function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
