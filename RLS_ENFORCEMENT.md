# Making tenant row-level security actually apply

**Why:** the database has row-level-security policies on the tenant tables, but the app connects as `postgres`, which has
`BYPASSRLS`, so Postgres never applies them. Tenant isolation then rests only on the checks in the routes. With a
restricted role the database enforces it too.

**How the app supports it** (all off until you set the variables, so nothing changes by default):
- `DATABASE_URL_ADMIN` — the owner connection (today's `DATABASE_URL`). Used for schema changes, `initDb`, migrations
  and the session store. Any `CREATE/ALTER/DROP ... POLICY/TABLE/INDEX` statement is sent to it automatically.
- `DATABASE_URL` — switched to the restricted role `okwesiwa_app` (see `scripts/create-app-role.sql`). Everything else
  (all normal queries) runs as this role, so the policies apply.
- Pre-login routes (login, company login, forgot/reset password, logout) and the nightly backup run in the "system"
  context the policies allow, because no tenant exists yet.

**Rollout (Preview first):**
1. Run `scripts/create-app-role.sql` once as `postgres` (choose a long random password).
2. Run `npm run migrate` (applies 007, which fixes stock-count columns).
3. In Vercel, scope to **Preview** only: `DATABASE_URL_ADMIN` = the current owner URL; `DATABASE_URL` = the same URL with
   the `okwesiwa_app` user (Supabase pooler: `okwesiwa_app.<project-ref>`).
4. Redeploy a preview and click through every role. Errors containing `permission denied` or `row-level security`
   in the logs are the thing to look for.
5. Then set the same variables for Production. **Rollback:** point `DATABASE_URL` back at the owner URL.

**Known limits:** `super_admin`, `ceo` and `admin` roles are given the system context on purpose (so a CEO sees every
branch), so for them the database does not separate tenants and the route-level checks do. The `users` table has no
policy; the code filters it by tenant.
