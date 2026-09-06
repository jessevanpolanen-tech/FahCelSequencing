// ── Read the pipeline ───────────────────────────────────────────────
// GET /api/leads  → leads with their live enrollment status, per-lead
// engagement rollup, and the message-by-message status of everything we sent
// them. Lets the dashboard show REAL sequence state instead of localStorage.
// Read-only; CORS open for the static dashboard.
//
// Per-message status is reconstructed by joining each `sent` event to the
// delivered/opened/clicked/bounced/complained events that share its
// `resend_id`. The response also carries a `cursor` (the current max events.id)
// so the dashboard can switch to tailing /api/events/since from this point.
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

    // The cursor is read alongside the leads, so anything that lands after this
    // read is picked up by the client's first /api/events/since call.
    const [rows, cursorRows] = await Promise.all([
      sql`
      select
        l.id, l.email, l.name, l.org, l.role, l.created_at, l.tenant,
        e.sequence_id, e.step_index, e.status, e.next_due_at, e.enrolled_at,
        (select count(*) from events ev where ev.lead_id = l.id and ev.type = 'clicked')::int as clicks,
        (select max(ev.created_at) from events ev where ev.lead_id = l.id and ev.type = 'replied') as replied_at,
        eng.engagement,
        coalesce(se.sent_events, '[]'::jsonb) as sent_events
      from leads l
      left join lateral (
        select * from enrollments en where en.lead_id = l.id order by en.enrolled_at desc limit 1
      ) e on true

      -- Per-lead rollup across every event we ever recorded for them.
      left join lateral (
        select jsonb_build_object(
          'delivered',     (count(*) filter (where ev.type = 'delivered'))::int,
          'opened',        (count(*) filter (where ev.type = 'opened'))::int,
          'clicked',       (count(*) filter (where ev.type = 'clicked'))::int,
          'bounced',       coalesce(bool_or(ev.type = 'bounced'), false),
          'complained',    coalesce(bool_or(ev.type = 'complained'), false),
          'unsubscribed',  coalesce(bool_or(ev.type = 'unsubscribed'), false),
          'last_event_at', to_char(max(ev.created_at) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ) as engagement
        from events ev
        where ev.lead_id = l.id
      ) eng on true

      -- The 50 most recent sends, each carrying the furthest status it reached.
      left join lateral (
        select jsonb_agg(m.obj order by m.created_at desc) as sent_events
        from (
          select
            s.created_at,
            jsonb_build_object(
              'resend_id',     s.resend_id,
              'type',          'sent',
              'subject',       coalesce(s.meta->>'subject', ''),
              'body',          coalesce(s.meta->>'text', s.meta->>'body', ''),
              'step',          coalesce(s.meta->>'step', ''),
              -- rows written before meta.source existed are all sequence sends
              'source',        coalesce(nullif(s.meta->>'source', ''), 'sequence'),
              'created_at',    to_char(s.created_at    at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'delivered_at',  to_char(st.delivered_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'opened_at',     to_char(st.opened_at    at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'clicked_at',    to_char(st.clicked_at   at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'bounced_at',    to_char(st.bounced_at   at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'complained_at', to_char(st.complained_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              -- furthest point reached; a bounce/complaint always wins
              'status', case
                when st.complained_at is not null then 'complained'
                when st.bounced_at    is not null then 'bounced'
                when st.clicked_at    is not null then 'clicked'
                when st.opened_at     is not null then 'opened'
                when st.delivered_at  is not null then 'delivered'
                else 'sent'
              end
            ) as obj
          from (
            select ev.* from events ev
            where ev.lead_id = l.id and ev.type = 'sent'
            order by ev.created_at desc
            limit 50
          ) s
          -- Legacy sends have no resend_id; the guard below leaves every
          -- timestamp null for them so they still show up as 'sent'.
          left join lateral (
            select
              min(x.created_at) filter (where x.type = 'delivered')  as delivered_at,
              min(x.created_at) filter (where x.type = 'opened')     as opened_at,
              min(x.created_at) filter (where x.type = 'clicked')    as clicked_at,
              min(x.created_at) filter (where x.type = 'bounced')    as bounced_at,
              min(x.created_at) filter (where x.type = 'complained') as complained_at
            from events x
            where s.resend_id is not null
              and x.lead_id = l.id
              and x.resend_id = s.resend_id
              and x.created_at >= s.created_at
              and x.type in ('delivered', 'opened', 'clicked', 'bounced', 'complained')
          ) st on true
        ) m
      ) se on true

      where l.tenant = ${tenant}
      order by l.created_at desc
      limit 500;`,
      sql`select coalesce(max(id), 0)::text as cursor from events;`,
    ]);

    res.status(200).json({ cursor: cursorRows[0].cursor, leads: rows, tenant });
  } catch (err) {
    // Surface the real reason instead of an opaque 500 page.
    res.status(500).json({ error: String((err && err.message) || err) });
  }
}
