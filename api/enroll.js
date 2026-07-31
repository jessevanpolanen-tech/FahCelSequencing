// ── Enroll a lead into a sequence ───────────────────────────────────
// POST /api/enroll  { email, name?, org?, role?, phone?, note?, sequenceId? }
// Called by the dashboard's "Add cold outreach lead" button (and anything else).
// Upserts the lead, starts the sequence, and fires step 0 on the next cron tick.
//
// Node.js classic (req, res) handler.
import { upsertLead, createEnrollment, logEvent, DEFAULT_TENANT } from '../lib/db.js';
import { getSequence, dueAtForStep } from '../lib/sequences.js';
import { notifyNewLead } from '../lib/resend.js';

export const config = { runtime: 'nodejs' };

const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method' }); return; }

  try {
    const payload = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');

    const email = (payload.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { res.status(400).json({ error: 'invalid-email' }); return; }

    const sequenceId = payload.sequenceId || 'founding-outreach';
    const seq = getSequence(sequenceId);
    if (!seq) { res.status(400).json({ error: 'unknown-sequence' }); return; }

    const tenant = (payload.tenant || req.query?.tenant || DEFAULT_TENANT).toString().trim().toLowerCase();

    const lead = await upsertLead({
      email,
      name: payload.name || '',
      org: payload.org || '',
      role: payload.role || 'Cold outreach',
      phone: payload.phone || '',
      note: payload.note || '',
      tenant,
    });

    const enrolledAt = new Date();
    const firstDueAt = dueAtForStep(enrolledAt, seq, 0);
    const enrollment = await createEnrollment({ leadId: lead.id, email, sequenceId, firstDueAt });
    await logEvent({ leadId: lead.id, enrollmentId: enrollment.id, email, type: 'enrolled', meta: { sequenceId, tenant } });

    // Notify the operator on a genuinely new lead (not a re-enroll of an existing one).
    if (lead._inserted) {
      try { await notifyNewLead(lead, 'dashboard'); } catch (e) { /* never fail the enroll on a notify hiccup */ }
    }

    res.status(200).json({ ok: true, leadId: lead.id, enrollmentId: enrollment.id, sequenceId });
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
}
