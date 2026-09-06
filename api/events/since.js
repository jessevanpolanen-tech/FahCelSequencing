// ── Event tail ──────────────────────────────────────────────────────
// GET /api/events/since?cursor=<id>&limit=200
//   → { cursor, events: [...] }  — everything logged after `cursor`, oldest
//     first, so the dashboard can poll every few seconds instead of re-pulling
//     the whole lead table.
//
// `events.id` is a bigserial, so it is monotonic and the primary key index
// makes `id > cursor order by id asc limit n` a cheap range scan. No join.
//
// No cursor (or cursor=0) means "start tailing from now": we return the current
// max id and an empty list rather than replaying all of history.
//
// Optional `?tenant=` filters to one tenant's leads; omitted (the default) the
// tail is unscoped, which keeps its cursor comparable with /api/leads's.
//
// Node.js classic (req, res) handler.
import { sql } from '../../lib/db.js';

export const config = { runtime: 'nodejs' };

const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'method' }); return; }

  try {
    const rawCursor = (req.query?.cursor ?? '').toString().trim();
    const cursor = /^\d+$/.test(rawCursor) ? Number(rawCursor) : 0;

    const rawLimit = Number.parseInt((req.query?.limit ?? '').toString(), 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;

    const tenant = (req.query?.tenant || '').toString().trim().toLowerCase();

    // Cold start: hand back "now" so the client tails forward from here.
    if (!cursor) {
      const [row] = await sql`select coalesce(max(id), 0)::text as cursor from events;`;
      res.status(200).json({ cursor: row.cursor, events: [] });
      return;
    }

    const rows = tenant
      ? await sql`
          select ev.id::text as id, ev.lead_id, ev.email, ev.type, ev.resend_id, ev.meta, ev.created_at
          from events ev
          where ev.id > ${cursor}
            and exists (select 1 from leads l where l.id = ev.lead_id and l.tenant = ${tenant})
          order by ev.id asc
          limit ${limit};`
      : await sql`
          select ev.id::text as id, ev.lead_id, ev.email, ev.type, ev.resend_id, ev.meta, ev.created_at
          from events ev
          where ev.id > ${cursor}
          order by ev.id asc
          limit ${limit};`;

    const events = rows.map((r) => ({
      id: Number(r.id),
      lead_id: r.lead_id,
      email: r.email,
      type: r.type,
      resend_id: r.resend_id,
      meta: r.meta || {},
      created_at: r.created_at,
    }));

    // Empty page → hold the cursor where it was, so nothing is skipped.
    const next = events.length ? String(events[events.length - 1].id) : String(cursor);
    res.status(200).json({ cursor: next, events });
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
}
