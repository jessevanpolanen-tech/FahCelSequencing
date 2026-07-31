// ── Public lead capture ─────────────────────────────────────────────
// POST /api/capture-lead  { email, name?, org?, role?, phone?, note?, enroll? }
//
// Called from the public website (preorder / contact forms). Upserts the
// lead and logs a `captured` event. Pass enroll:true to also start the
// founding-outreach sequence (default OFF — people who contacted YOU
// shouldn't get cold outreach).
//
// Node.js classic (req, res) handler. CORS open (*) for the website origin.
import { upsertLead, createEnrollment, logEvent, DEFAULT_TENANT } from '../lib/db.js';
import { SEQUENCES } from '../lib/sequences.js';
import { notifyNewLead } from '../lib/resend.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  try {
    const body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');

    const email = (body.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { res.status(400).json({ error: 'valid email required' }); return; }

    // Tenant tag keeps FahCel and Dr. Fry leads apart on the shared database.
    const tenant = (body.tenant || req.query?.tenant || DEFAULT_TENANT).toString().trim().toLowerCase();

    const lead = await upsertLead({
      email,
      name: body.name || '',
      org: body.org || '',
      role: body.role || 'Website lead',
      phone: body.phone || '',
      note: body.note || '',
      tenant,
    });

    await logEvent({ leadId: lead.id, email, type: 'captured', meta: { source: body.source || 'website', tenant } });

    let enrollment = null;
    // Enroll when asked. Honor an explicit sequenceId so inbound playbook leads
    // get the FahCel playbook-nurture copy — NOT the Dr Fry founding-outreach
    // sequence. Default stays OFF (people who contacted YOU shouldn't get cold
    // outreach), and an unknown/absent sequenceId falls back to founding-outreach.
    if (body.enroll === true || body.sequenceId) {
      const seq = SEQUENCES[body.sequenceId] || SEQUENCES['founding-outreach'];
      const firstDueAt = new Date(Date.now() + (seq.steps[0].dayOffset || 0) * 86400000);
      enrollment = await createEnrollment({ leadId: lead.id, email, sequenceId: seq.id, firstDueAt });
      await logEvent({ leadId: lead.id, enrollmentId: enrollment.id, email, type: 'enrolled', meta: { sequenceId: seq.id, source: body.source || 'website' } });
    }

    // Notify the operator on a genuinely new lead (not a repeat submission of an existing one).
    if (lead._inserted) {
      try { await notifyNewLead(lead, body.source || 'website'); } catch (e) { /* never fail capture on a notify hiccup */ }
    }

    res.status(200).json({ ok: true, lead, enrollment });
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
}
