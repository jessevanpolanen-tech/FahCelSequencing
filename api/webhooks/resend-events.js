// ── Resend events webhook ───────────────────────────────────────────
// Point a Resend webhook at:  POST https://<your-backend>/api/webhooks/resend-events
// Subscribe to: email.delivered, email.opened, email.clicked,
//               email.bounced, email.complained.
//
// Node.js classic (req, res) handler. bodyParser disabled so we can verify the
// Svix signature against the EXACT raw bytes Resend sent.
import { findLeadByEmail, stopEnrollmentsForEmail, logEvent } from '../../lib/db.js';
import { verifyResendSignature } from '../../lib/webhook.js';

export const config = { runtime: 'nodejs', api: { bodyParser: false } };

async function readRawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method' }); return; }

  try {
    const raw = await readRawBody(req);
    if (!(await verifyResendSignature(req, raw))) { res.status(401).json({ error: 'bad-signature' }); return; }

    let evt;
    try { evt = JSON.parse(raw); } catch { res.status(400).json({ error: 'bad-json' }); return; }

    const type = evt.type || '';
    const data = evt.data || {};
    const email = (Array.isArray(data.to) ? data.to[0] : data.to) || '';
    if (!email) { res.status(200).json({ ok: true, skipped: 'no-recipient' }); return; }

    const lead = await findLeadByEmail(email);
    const leadId = lead ? lead.id : null;

    switch (type) {
      case 'email.clicked':
        await logEvent({ leadId, email, type: 'clicked', meta: { link: data.click && data.click.link }, resendId: data.email_id });
        break;
      case 'email.opened':
        await logEvent({ leadId, email, type: 'opened', resendId: data.email_id });
        break;
      case 'email.bounced':
        await stopEnrollmentsForEmail(email, 'bounced');
        await logEvent({ leadId, email, type: 'bounced', meta: { reason: data.bounce || data.reason }, resendId: data.email_id });
        break;
      case 'email.complained':
        await stopEnrollmentsForEmail(email, 'complained');
        await logEvent({ leadId, email, type: 'complained', resendId: data.email_id });
        break;
      case 'email.delivered':
        await logEvent({ leadId, email, type: 'delivered', resendId: data.email_id });
        break;
      default:
        // ignore other event types
        break;
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
}
