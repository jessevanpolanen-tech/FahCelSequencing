# FahCel — cold-outreach sequencer (on Resend)

Automatic, reply-aware email sequences on top of your Resend account.
Sends from your verified FahCel sending subdomain, keeps replies in your inbox,
stops on reply/bounce/unsubscribe, and tracks clicks.

> ⚠️ These are **backend files you deploy** — they don't run inside the design
> project. Deploy them once to Vercel and they run 24/7 on their own.

## What each piece does

| File | Role |
|---|---|
| `db/schema.sql` | Tables: `leads`, `enrollments`, `events`. Run once. |
| `db/fix-leads-unique.sql` | One-time fix if capture 500s with *"no unique or exclusion constraint…"* — adds the `leads.email` unique index the upsert needs. |
| `db/fix-tenant.sql` | One-time fix if leads save as `tenant:"drfry"` — adds / re-defaults the `tenant` column to `fahcel` and re-tags mis-tagged FahCel rows. |
| `api/capture-lead.js` | `POST /api/capture-lead` — public website lead capture (landing + booking forms). |
| `api/enroll.js` | `POST /api/enroll` — add a lead + start a sequence. |
| `api/send.js` | `POST /api/send` — send one email now (dashboard Compose → Send). |
| `api/cron/tick.js` | Runs daily (Vercel Cron). Sends due steps, advances each lead. |
| `api/webhooks/resend-events.js` | Opens / clicks / bounces / complaints from Resend. |
| `api/webhooks/resend-inbound.js` | A reply → stop sequence **and** forward to your inbox. |
| `api/unsubscribe.js` | The opt-out link in every email footer. |
| `api/leads.js` | `GET /api/leads` — read live pipeline state (for the dashboard). |
| `lib/sequences.js` | Your sequences + copy. Edit here to change cadence/wording. |

Sequences (`lib/sequences.js`):
- **`founding-outreach`** (cold) — **Day 0** intro → **Day 3** case study →
  **Day 7** ROI / proof → **Day 14** break-up.
- **`playbook-nurture`** (warm inbound) — for leads who downloaded the Cold-Chain
  Excursion Playbook. **Day 0** deliver the guide → **Day 3** the move most teams
  skip → **Day 7** demo CTA. Deliberately **separate copy** from the cold sequence.
  `FahCel Guide Download.html` enrolls into this via `POST /api/capture-lead`
  with `{ enroll:true, sequenceId:"playbook-nurture" }`.

Change cadence/wording in `lib/sequences.js`.

> Before going live, confirm the two config constants at the top of
> `lib/sequences.js`: `SITE` (your public site) and `CONTACT` (reply address).

## Deploy (≈20 min)

### 1. Database
Create a Postgres DB (Supabase, Neon, or Vercel Postgres). The DB layer uses the
`postgres` (postgres.js) driver over TCP, so it works with any standard Postgres.
Endpoints that touch the DB run on the **Node.js runtime** (not Edge).

**Supabase:** use the **Transaction-mode pooler** string from *Connect → Transaction*
— host contains `pooler.supabase.com`, **port 6543** (not the direct 5432 host).
Replace `[PASSWORD]` with your DB password. Transaction mode requires prepared
statements off; the driver is already configured with `prepare: false`.

Load the schema:
```bash
psql "$POSTGRES_URL" -f db/schema.sql
```
(or paste `db/schema.sql` into the provider's SQL console).

### 2. Deploy to Vercel
```bash
npm i -g vercel
cd backend
vercel            # first deploy → gives you https://your-app.vercel.app
vercel --prod
```

### 3. Environment variables (Vercel → Settings → Environment Variables)
| Var | Value |
|---|---|
| `RESEND_API_KEY` | your Resend key (`re_...`) |
| `POSTGRES_URL` | Supabase **Transaction-pooler** string (`...pooler.supabase.com:6543/postgres`); auto-set by Vercel Postgres |
| `FROM_EMAIL` | `sales@mail.fahcel.co` *(your verified sending subdomain)* |
| `FROM_NAME` | `FahCel` |
| `REPLY_TO` | address on your **receiving** subdomain *(see step 5 — must be inbound for reply-detection)* |
| `FORWARD_TO` | `sales@fahcel.co` (your real inbox) |
| `CRON_SECRET` | any long random string |
| `RESEND_WEBHOOK_SECRET_EVENTS` | signing secret of the **events** webhook (`whsec_…`) |
| `RESEND_WEBHOOK_SECRET_INBOUND` | signing secret of the **inbound** webhook (`whsec_…`) |
| `BACKEND_BASE_URL` | `https://your-app.vercel.app` |
| `ALLOW_ORIGIN` | your site + dashboard origin (or `*` while testing) |

Redeploy after setting them: `vercel --prod`.

### 4. Resend webhook — events
Resend → **Webhooks** → add endpoint
`https://your-app.vercel.app/api/webhooks/resend-events`, subscribe to
`email.delivered`, `email.opened`, `email.clicked`, `email.bounced`,
`email.complained`. Copy its signing secret into `RESEND_WEBHOOK_SECRET_EVENTS`.
Then turn **ON open & click tracking** in Resend settings.

### 5. Reply detection (the important bit)
So a reply stops the sequence *and* still reaches your inbox, replies must route
through Resend Inbound, not straight to your mailbox.

1. **Pick a receiving subdomain** — use a *new* one, e.g. `reply.fahcel.co`
   (don't reuse your sending subdomain; keep sending vs receiving separate).
2. **Add the MX record.** Resend → **Emails → Receiving** → add `reply.fahcel.co`
   → add the **MX record** it gives you at your DNS provider. Wait for it to verify.
3. **Add the inbound webhook.** Resend → **Webhooks → Add** →
   URL `https://your-app.vercel.app/api/webhooks/resend-inbound`, event type
   **`email.received`**. Copy its signing secret into `RESEND_WEBHOOK_SECRET_INBOUND`.
4. **Point Reply-To at it:** set `REPLY_TO=sales@reply.fahcel.co`.

Flow: lead replies → mail hits `…@reply.fahcel.co` → Resend Inbound → our webhook
**stops their sequence** and **forwards the message to your `FORWARD_TO` inbox** with
Reply-To set to the lead, so you answer normally.

If you skip this whole step, sending + sequences still work — set
`REPLY_TO=sales@fahcel.co` and watch replies by hand (sequences won't auto-stop).

### 6. Test
```bash
curl -X POST https://your-app.vercel.app/api/enroll \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","name":"Test","org":"Acme"}'

# fire the scheduler manually instead of waiting for the day:
curl "https://your-app.vercel.app/api/cron/tick?key=YOUR_CRON_SECRET"
```
You should receive step 0. Reply to it → you get the forward and the sequence stops.

## Connecting the website + dashboard
- **Website forms** (`FahCel Landing.html`, `FahCel Book a Demo.html`) POST to
  `/api/capture-lead`; a `vercel.json` rewrite at the project root forwards
  `/api/*` to this backend.
- **Dashboard** (`FahCel Dashboard.html`): paste the backend URL in Email Settings.
  It then polls `GET /api/leads` for live reply/sequence state and can enroll /
  send through the backend.

## Safety notes
- **Sending domain:** everything goes out on your sending subdomain (e.g.
  `mail.fahcel.co`), so cold-outreach reputation never touches your root domain
  or your main inbox.
- **Compliance:** every email carries a working one-click unsubscribe. Keep volume
  sane and only email people with a plausible reason to hear from you.
- **Secrets:** the Resend key lives only in Vercel env vars, never in the browser.
