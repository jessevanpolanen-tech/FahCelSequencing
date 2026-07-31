-- FahCel cold-outreach sequencing — Postgres schema
-- Run once against your database (Vercel Postgres / Neon / Supabase):
--   psql "$POSTGRES_URL" -f db/schema.sql
-- or paste into the provider's SQL console.

create extension if not exists "pgcrypto";  -- for gen_random_uuid()

-- A person we're reaching out to. One row per email.
create table if not exists leads (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,
  name        text not null default '',
  org         text not null default '',
  role        text not null default 'Cold outreach',
  phone       text not null default '',
  note        text not null default '',
  created_at  timestamptz not null default now()
);

-- A lead's run through one sequence. step_index = the NEXT step to send.
-- status: active | replied | completed | unsubscribed | bounced | complained | paused
create table if not exists enrollments (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid not null references leads(id) on delete cascade,
  email        text not null,                       -- denormalised for fast lookup
  sequence_id  text not null,
  step_index   int  not null default 0,
  status       text not null default 'active',
  enrolled_at  timestamptz not null default now(),
  next_due_at  timestamptz not null default now(),  -- when step_index should fire
  updated_at   timestamptz not null default now()
);

create index if not exists enrollments_due_idx
  on enrollments (status, next_due_at);
create index if not exists enrollments_email_idx
  on enrollments (email);

-- Append-only log of everything that happened (sends, opens, clicks, replies…).
create table if not exists events (
  id            bigserial primary key,
  lead_id       uuid references leads(id) on delete cascade,
  enrollment_id uuid references enrollments(id) on delete set null,
  email         text not null default '',
  type          text not null,        -- sent | delivered | opened | clicked | bounced | complained | replied | unsubscribed | enrolled
  meta          jsonb not null default '{}'::jsonb,
  resend_id     text,                 -- Resend message id, when applicable
  created_at    timestamptz not null default now()
);

create index if not exists events_lead_idx on events (lead_id, created_at desc);

-- Self-healing: guarantee the unique index the capture-lead / enroll upsert
-- targets, even on databases whose `leads` table predates the `unique` above
-- (create table if not exists would have skipped the inline constraint).
create unique index if not exists leads_email_key on leads (email);

-- Multi-tenant: FahCel and Dr. Fry share this database; every read, wipe and
-- capture is scoped by this tag. Added via ALTER so existing tables get it too.
alter table leads add column if not exists tenant text not null default 'fahcel';
create index if not exists leads_tenant_idx on leads (tenant, created_at desc);
