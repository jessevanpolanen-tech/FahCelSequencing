// ── Send-one-email proxy ────────────────────────────────────────────
// Used by the dashboard's Compose → Send (Delivery mode: "Resend · proxy").
// POST /api/send  { to, subject, text, from?, replyTo? }
// Holds the Resend API key server-side so it never touches the browser.
//
// This is the endpoint the dashboard's "Proxy endpoint URL" field should point
// at:  https://<your-backend>/api/send
//
// Every manual send is also recorded: the recipient is upserted as a lead and a
// `sent` event is written carrying the Resend message id. Without that id the
// delivered/opened/clicked webhooks that arrive later have nothing to correlate
// against, and manual sends would stay permanently status-less.
//
// Node.js classic (req, res) handler.
import { sendEmail, fromLine } from '../lib/resend.js';
import { upsertLead, logEvent, DEFAULT_TENANT } from '../lib/db.js';

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

    const to = (p.to || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) { res.status(400).json({ error: 'invalid-to' }); return; }
    if (!p.subject) { res.status(400).json({ error: 'missing-subject' }); return; }

    const subject = p.subject;
    const text = p.text || '';
    const tenant = (p.tenant || req.query?.tenant || DEFAULT_TENANT).toString().trim().toLowerCase();

    // Make sure the recipient exists as a lead so the send has something to hang
    // off. A DB hiccup must not block the actual email — worst case we send with
    // leadId null and the event log is thinner.
    let leadId = null;
    try {
      const lead = await upsertLead({
        email: to,
        name: p.name || '',
        org: p.org || '',
        role: 'Manual send',
        tenant,
      });
      leadId = lead ? lead.id : null;
    } catch (e) { /* keep sending */ }

    // `from` and reply-to from the dashboard are ignored in favour of the
    // server's verified FROM_EMAIL / REPLY_TO, so nobody can spoof them through
    // this open endpoint — and replies always route through the receiving
    // subdomain (fahcel.eu) so the inbound webhook fires. Set REPLY_TO
    // in Vercel; it is the single source of truth.
    let result;
    try {
      result = await sendEmail({
        to,
        subject,
        text,
        tags: [{ name: 'kind', value: 'manual-compose' }],
      });
    } catch (err) {
      // Mirror api/cron/tick.js: record the failure, then surface the 502.
      try {
        await logEvent({
          leadId,
          email: to,
          type: 'send_failed',
          meta: { subject, text, step: '', source: 'manual', error: String(err).slice(0, 300) },
        });
      } catch (e) { /* never mask the send error behind a logging error */ }
      res.status(502).json({ ok: false, error: String(err).slice(0, 300) });
      return;
    }

    // The resend_id here is what lets /api/leads correlate the later
    // delivered/opened/clicked webhooks back to this exact message.
    try {
      await logEvent({
        leadId,
        email: to,
        type: 'sent',
        meta: { subject, text, step: '', source: 'manual' },
        resendId: result.id || null,
      });
    } catch (e) { /* the email went out; don't fail the request on a log write */ }

    res.status(200).json({ ok: true, id: result.id, from: fromLine() });
  } catch (err) {
    res.status(502).json({ ok: false, error: String(err).slice(0, 300) });
  }
}
