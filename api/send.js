// ── Send-one-email proxy ────────────────────────────────────────────
// Used by the dashboard's Compose → Send (Delivery mode: "Resend · proxy").
// POST /api/send  { to, subject, text, from?, replyTo? }
// Holds the Resend API key server-side so it never touches the browser.
//
// This is the endpoint the dashboard's "Proxy endpoint URL" field should point
// at:  https://<your-backend>/api/send
//
// Node.js classic (req, res) handler.
import { sendEmail, fromLine } from '../lib/resend.js';

export const config = { runtime: 'nodejs' };

const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method' }); return; }

  try {
    const p = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');

    const to = (p.to || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) { res.status(400).json({ error: 'invalid-to' }); return; }
    if (!p.subject) { res.status(400).json({ error: 'missing-subject' }); return; }

    // `from` and reply-to from the dashboard are ignored in favour of the
    // server's verified FROM_EMAIL / REPLY_TO, so nobody can spoof them through
    // this open endpoint — and replies always route through the receiving
    // subdomain (mail.fahcel.co) so the inbound webhook fires. Set REPLY_TO
    // in Vercel; it is the single source of truth.
    const result = await sendEmail({
      to,
      subject: p.subject,
      text: p.text || '',
      tags: [{ name: 'kind', value: 'manual-compose' }],
    });
    res.status(200).json({ ok: true, id: result.id, from: fromLine() });
  } catch (err) {
    res.status(502).json({ ok: false, error: String(err).slice(0, 300) });
  }
}
