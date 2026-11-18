-- Creates the restricted role the application should use so that the tenant row-level-security policies
-- really apply to its queries. Run ONCE as the database owner (Supabase: SQL editor, as `postgres`).
-- Replace CHANGE_ME with a long random password. See RLS_ENFORCEMENT.md for the full rollout.

CREATE ROLE okwesiwa_app LOGIN PASSWORD 'CHANGE_ME' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

GRANT USAGE ON SCHEMA public TO okwesiwa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO okwesiwa_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO okwesiwa_app;

-- tables and sequences created later by the owner (the app's "create if missing" helpers run on the owner connection)
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO okwesiwa_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO okwesiwa_app;

-- check: this should return  okwesiwa_app | f | f
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'okwesiwa_app';
