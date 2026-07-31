// ── Resend inbound (reply) webhook ──────────────────────────────────
// Makes sequences reply-aware AND keeps replies in your Outlook.
//
// Setup (see README): in Resend → Webhooks, add an endpoint pointing here with
// the event type `email.received`, and add the MX record for your receiving
// subdomain (e.g. reply.fahcel.co). Set REPLY_TO to an address on that subdomain.
//
// Node.js classic (req, res) handler. bodyParser disabled for signature checks.
import { findLeadByEmail, stopEnrollmentsForEmail, logEvent } from '../../lib/db.js';
import { verifyResendSignature } from '../../lib/webhook.js';
import { sendEmail } from '../../lib/resend.js';

export const config = { runtime: 'nodejs', api: { bodyParser: false } };

const OUTLOOK = process.env.FORWARD_TO || 'sales@fahcel.co';

async function readRawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function extractEmail(s = '') {
  const m = String(s).match(/[^\s<>"]+@[^\s<>"]+/);
  return m ? m[0].toLowerCase() : '';
}

// The received-email content lives behind a separate API call. The REST path
// has varied across Resend versions, so try the known candidates and use the
// first that returns a body. Falls back to '' (we still forward metadata).
async function fetchReceivedBody(emailId) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !emailId) return '';
  const urls = [
    `https://api.resend.com/emails/receiving/${emailId}`,
    `https://api.resend.com/emails/${emailId}`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
      if (!r.ok) continue;
      const j = await r.json();
      const text = j.text || j.plain_text || (j.html ? j.html.replace(/<[^>]+>/g, ' ') : '');
      if (text) return text;
    } catch {}
  }
  return '';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method' }); return; }

  try {
    const raw = await readRawBody(req);
    if (!(await verifyResendSignature(req, raw))) { res.status(401).json({ error: 'bad-signature' }); return; }

    let evt;
    try { evt = JSON.parse(raw); } catch { res.status(400).json({ error: 'bad-json' }); return; }
    if (evt.type && evt.type !== 'email.received') { res.status(200).json({ ok: true, skipped: evt.type }); return; }

    const data = evt.data || evt;
    const sender = extractEmail(data.from);
    const subject = data.subject || '(no subject)';
    if (!sender) { res.status(200).json({ ok: true, skipped: 'no-sender' }); return; }

    // 1. Stop any active sequence for this sender — returns how many were stopped.
    const stopped = await stopEnrollmentsForEmail(sender, 'replied');
    const lead = await findLeadByEmail(sender);
    await logEvent({ leadId: lead ? lead.id : null, email: sender, type: 'replied', meta: { subject } });

    // 2. Fetch the body, then forward to Outlook so you see and can answer it.
    const body = await fetchReceivedBody(data.email_id);
    const who = lead ? (lead.name || sender) + (lead.org ? ' · ' + lead.org : '') : sender;
    const statusLine = !lead
      ? `${sender} replied, but is not a lead in the pipeline — nothing to stop.`
      : stopped > 0
        ? `${who} replied — their active sequence has been stopped automatically.`
        : `${who} replied. No active sequence was running, so nothing was stopped.`;
    try {
      await sendEmail({
        to: OUTLOOK,
        subject: `↩ Reply from ${sender}: ${subject}`,
        text:
          `${statusLine}\n\n` +
          `———\nFrom: ${data.from}\nSubject: ${subject}\n\n` +
          (body || '[Body not retrieved — open this message in the Resend dashboard → Emails → Receiving.]'),
        replyTo: sender, // answering the forward goes straight back to the lead
        tags: [{ name: 'kind', value: 'reply-forward' }],
      });
    } catch (err) {
      await logEvent({ email: sender, type: 'forward_failed', meta: { error: String(err).slice(0, 200) } });
    }

    res.status(200).json({ ok: true, replied: sender });
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
}
