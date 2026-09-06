# Dr. Fry / FahCel Sequencer — backend

Cold-outreach email sequencing on Resend. Vercel serverless functions +
Postgres (Supabase). Deployed at **https://dr-fry-sequencerr.vercel.app**
(Vercel project `dr-fry-sequencerr`). There is a separate frontend repo — the
static dashboard — which consumes `/api/leads` and `/api/events/since`.

## Layout

```
api/
  leads.js               GET  pipeline read (+ DELETE all, guarded by a confirm string)
  events/since.js        GET  cursor tail of the events log — the real-time feed
  send.js                POST manual Compose → Send proxy
  enroll.js              POST start a sequence for a lead
  capture-lead.js        POST public website form intake
  unsubscribe.js         GET  opt-out link target, returns an HTML page
  cron/tick.js           the scheduler (Vercel Cron, see vercel.json)
  webhooks/resend-events.js    delivered/opened/clicked/bounced/complained
  webhooks/resend-inbound.js   replies — stops the sequence
  debug.js               TEMP diagnostic; delete once the sequencer is trusted
lib/db.js                postgres.js access layer + all query helpers
lib/resend.js            the one place that talks to the Resend REST API
lib/sequences.js         sequence definitions and step rendering
lib/webhook.js           Svix signature verification
db/schema.sql            idempotent; safe to re-run against a live database
```

## Hard requirements

- **Every route that touches the DB needs `export const config = { runtime: 'nodejs' }`.**
  postgres.js opens raw TCP sockets; the Edge runtime cannot.
- **Use classic `(req, res)` handlers**, not the Web/Fetch `Response` style — the
  latter can hang on Vercel's Node runtime here.
- `lib/db.js` sets `prepare: false`. Required by Supabase's transaction-mode
  pooler (port 6543). Don't remove it.
- `db/schema.sql` is written to be re-runnable (`if not exists` everywhere, plus
  `alter table … add column if not exists` for columns added later). Keep it that
  way — it is also the migration mechanism.

## Do not change

- Svix verification in `lib/webhook.js` or either webhook's verification path.
- `FROM_EMAIL` / `REPLY_TO` staying server-side in `api/send.js`. The dashboard
  must never be able to spoof the from address.
- The `CRON_SECRET` guard on `api/cron/tick.js`.
- Existing response field names in `/api/leads`. **Add** fields; renaming or
  removing breaks the deployed dashboard.

## Data model

`leads` → `enrollments` (a lead's run through one sequence) → `events`
(append-only log of everything: sent, delivered, opened, clicked, bounced,
complained, replied, unsubscribed, enrolled, captured, send_failed).

**`events.resend_id` is the correlation key.** A `sent` row carries the Resend
message id; the status webhooks that arrive later carry the same id. That is how
`/api/leads` reconstructs per-message status. A send with no `resend_id` can
never get a status — this is why `api/send.js` must log its `sent` event.

**`meta.source`** on a `sent` row is `'sequence'` or `'manual'`. Rows written
before that field existed have no `source`; **treat missing as `'sequence'`**.

**Tenant scoping.** FahCel and Dr. Fry share one database; `leads.tenant`
separates them and every read and wipe is scoped by it. It is written on INSERT
only — an existing lead never switches tenant. `DEFAULT_TENANT` is `'fahcel'`
unless the `TENANT` env var overrides it. `events` has no tenant column; scope by
joining through `lead_id` when you need it.

## API contract (shared with the frontend repo — don't change unilaterally)

`GET /api/leads` → `{ cursor, leads: [...], tenant }`. Each lead carries an
`engagement` rollup and `sent_events` (newest first, capped at 50; leads capped
at 500).

Per-message `status` is the **furthest point reached**:
`complained` > `bounced` > `clicked` > `opened` > `delivered` > `sent`.
Bounced/complained always win even if a delivered/opened arrived first.

`GET /api/events/since?cursor=<id>&limit=200` → `{ cursor, events }`, ordered by
`id` ASC, limit capped at 500. **No cursor or `cursor=0` returns the current max
id with an empty list** so a client tails from "now" instead of replaying
history. An empty page holds the cursor where it was.

`events.id` is a bigserial, so `id > cursor order by id asc` is a cheap range
scan on the primary key. Keep this endpoint join-free.

Timestamps embedded inside `jsonb_build_object` must be formatted explicitly —
Postgres' native jsonb rendering is `+00:00`, not the `.000Z` the contract uses:

```sql
to_char(ts at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
```

Top-level columns don't need this; postgres.js returns them as JS `Date`s which
already serialize to `.000Z`.

Postgres `count(*)` is a bigint and serializes as a **string**. Cast counts to
int (`(count(*) filter (where …))::int`) or the dashboard gets `"clicks":"0"`.

## Testing against a real Postgres

`vercel env pull` returns every secret as `"[SENSITIVE]"`, so **the live database
is not reachable from a local checkout.** Validate SQL against a throwaway
container instead. `lib/db.js` hardcodes `ssl: 'require'`, so the container needs
TLS on if you want to exercise the real handlers unmodified:

```bash
docker run -d --name pgtest -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test \
  -p 55432:5432 postgres:16-alpine
docker exec pgtest sh -c '
  D=/var/lib/postgresql/data
  apk add --no-cache openssl
  openssl req -new -x509 -days 3 -nodes -subj "/CN=localhost" \
    -out $D/server.crt -keyout $D/server.key
  chmod 600 $D/server.key
  chown postgres:postgres $D/server.key $D/server.crt
  echo "ssl = on"                      >> $D/postgresql.conf
  echo "ssl_cert_file = '"'"'server.crt'"'"'" >> $D/postgresql.conf
  echo "ssl_key_file = '"'"'server.key'"'"'"  >> $D/postgresql.conf
'
docker restart pgtest   # then wait for: docker exec pgtest pg_isready -U postgres
docker exec -i pgtest psql -U postgres -d test -v ON_ERROR_STOP=1 < db/schema.sql
POSTGRES_URL="postgres://postgres:test@127.0.0.1:55432/test" node your-harness.mjs
```

Import the handler and hand it a mock `res` with `setHeader/status/json/end`.
Stub `globalThis.fetch` to fake Resend rather than sending real mail.

Schema changes therefore have to be applied **by hand in the Supabase SQL
console** — add them to `db/schema.sql` and say so, don't assume they are live.

## Care

- **`/api/cron/tick` sends real email to real prospects.** Don't curl it to
  "check something". `CRON_SECRET` is currently **not set in production**, which
  means the endpoint is unguarded — worth fixing.
- `DELETE /api/leads` requires `{ "confirm": "DELETE_ALL_LEADS" }` and is tenant
  scoped. It cascades to enrollments and events.
- The Resend sandbox rejects `@example.com` recipients; use their test address.

## Deploy

```bash
npx vercel --prod --yes
```
