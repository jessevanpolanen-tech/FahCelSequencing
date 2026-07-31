-- ─────────────────────────────────────────────────────────────────────
-- Multi-tenant migration: FahCel + Dr. Fry share one database.
--
-- Run ONCE against the live database (Supabase → SQL editor).
-- Safe to re-run. Fixes leads being saved as tenant 'drfry'.
-- ─────────────────────────────────────────────────────────────────────

-- 1) Ensure the column exists (no-op if the Dr Fry side already added it).
alter table leads add column if not exists tenant text not null default 'fahcel';

-- 2) The column was created with default 'drfry', so FahCel captures that
--    didn't pass a tenant landed under Dr Fry. Flip the default to 'fahcel'
--    for THIS deployment's database.
alter table leads alter column tenant set default 'fahcel';

-- 3) Re-tag the rows that came from FahCel forms but were saved as 'drfry'.
--    Matched by the source recorded on their capture/enroll event.
update leads l
set tenant = 'fahcel'
where l.tenant <> 'fahcel'
  and exists (
    select 1 from events e
    where e.lead_id = l.id
      and (e.meta->>'source') in (
        'fahcel-playbook-download',
        'fahcel-demo-request',
        'fahcel-website'
      )
  );

-- 4) Index for the tenant-scoped dashboard query.
create index if not exists leads_tenant_idx on leads (tenant, created_at desc);
