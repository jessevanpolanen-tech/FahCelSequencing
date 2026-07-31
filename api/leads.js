// ── Read the pipeline ───────────────────────────────────────────────
// GET /api/leads  → leads with their live enrollment status + click count.
// Lets the dashboard show REAL sequence state instead of localStorage.
// Read-only; CORS open for the static dashboard.
//
// Node.js classic (req, res) handler — required on Vercel's Node runtime so
// the response completes (the Web/Fetch `Response` style can hang here).
import { sql, deleteAllLeads, DEFAULT_TENANT } from '../lib/db.js';

export const config = { runtime: 'nodejs' };

const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // DELETE /api/leads  { confirm: 'DELETE_ALL_LEADS' }  → wipes every lead
  // (enrollments + events cascade via FK). Requires the exact confirm string
  // so an empty/blank body can never trigger it by accident.
  if (req.method === 'DELETE') {
    try {
      const body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');
      if (body.confirm !== 'DELETE_ALL_LEADS') {
        res.status(400).json({ error: 'missing confirmation' });
        return;
      }
      // Scoped wipe — never touches the other tenant's leads.
      const delTenant = (body.tenant || req.query?.tenant || DEFAULT_TENANT).toString().trim().toLowerCase();
      const deleted = await deleteAllLeads(delTenant);
      res.status(200).json({ ok: true, deleted, tenant: delTenant });
    } catch (err) {
      res.status(500).json({ error: String((err && err.message) || err) });
    }
    return;
  }

  try {
    const tenant = (req.query?.tenant || DEFAULT_TENANT).toString().trim().toLowerCase();
    const rows = await sql`
      select
        l.id, l.email, l.name, l.org, l.role, l.created_at, l.tenant,
        e.sequence_id, e.step_index, e.status, e.next_due_at, e.enrolled_at,
        (select count(*) from events ev where ev.lead_id = l.id and ev.type = 'clicked') as clicks,
        (select max(ev.created_at) from events ev where ev.lead_id = l.id and ev.type = 'replied') as replied_at
      from leads l
      left join lateral (
        select * from enrollments en where en.lead_id = l.id order by en.enrolled_at desc limit 1
      ) e on true
      where l.tenant = ${tenant}
      order by l.created_at desc
      limit 500;`;

    res.status(200).json({ leads: rows, tenant });
  } catch (err) {
    // Surface the real reason instead of an opaque 500 page.
    res.status(500).json({ error: String((err && err.message) || err) });
  }
}
