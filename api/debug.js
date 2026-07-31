// ── TEMP diagnostic ─────────────────────────────────────────────────
// GET /api/debug  → shows the DB clock and every enrollment's due state,
// so we can see exactly why the scheduler finds (or misses) a lead.
// DELETE THIS FILE once the sequencer is confirmed working.
import { sql } from '../lib/db.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const clock = await sql`select now() as db_now`;
    const rows = await sql`
      select
        id, email, sequence_id, step_index, status,
        next_due_at,
        now() as db_now,
        (status = 'active' and next_due_at <= now()) as is_due,
        extract(epoch from (now() - next_due_at)) as seconds_overdue
      from enrollments
      order by enrolled_at desc
      limit 50;`;
    // What the scheduler's own query returns, verbatim:
    const dueNow = await sql`
      select id, email, status, next_due_at from enrollments
      where status = 'active' and next_due_at <= now()
      order by next_due_at asc limit 50;`;

    res.status(200).json({
      db_now: clock[0].db_now,
      enrollments: rows,
      scheduler_would_send: dueNow,
    });
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
}
