-- ─────────────────────────────────────────────────────────────────────
-- FIX: leads.email must be UNIQUE for the capture-lead / enroll upsert.
--
-- Symptom: POST /api/capture-lead returns HTTP 500
--   { "error": "there is no unique or exclusion constraint matching the
--     ON CONFLICT specification" }
--
-- Cause: the live `leads` table was created before schema.sql declared
--   `email ... unique`, so `create table if not exists` never added it.
--   `INSERT ... ON CONFLICT (email)` then has no constraint to target.
--
-- Run this ONCE against the live database (Supabase → SQL editor, or
--   psql "$POSTGRES_URL" -f db/fix-leads-unique.sql). Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

-- 1) If duplicate emails already exist, collapse them first (keep the
--    oldest row per email). Comment out if you know there are no dupes.
delete from leads a
using leads b
where a.email = b.email
  and a.created_at > b.created_at;

-- 2) Add the unique index ON CONFLICT (email) needs. Idempotent.
create unique index if not exists leads_email_key on leads (email);
