# Codex read-only app-server probe

After building the runtime packages, run `pnpm exec tsx spikes/codex-probe.ts`. Optional `--output /path/report.json` writes a sanitized JSON report. No model inference turn is created and no authentication files are read or uploaded.

Observed on the installed Codex 0.170.0 on macOS at 2026-11-18T14:47:53Z:

- stdio initialize succeeded; platform family `unix`.
- `model/list` returned 10 model entries (availability can change).
- A read-only thread accepted a dynamic tool definition and was archived.
- `turn/start` was never sent.

This verifies transport/schema compatibility. Model inference, actual dynamic tool invocation and account billing require separate live-provider validation; unit tests use explicit mock subprocesses.

# Explicit cloud OIDC smoke

`oidc-cloud-smoke.ts` exercises the real Keycloak test realm and the control service with Fastify inject. It creates one random temporary OIDC user, performs the S256 authorization form and callback/state flow, exchanges the token for a product session, checks `/me`, tampered-token rejection, disabled development login, and logout revocation, then deletes that OIDC user in `finally`. It does not listen on a local port or start infrastructure.

Supply these environment variables explicitly:

- `TEST_DATABASE_URL`: already migrated cloud PostgreSQL database ending `_test`, using its application role.
- `JWT_SECRET`: at least 32 characters for the test product session.
- `OIDC_ISSUER`: HTTPS Keycloak issuer with a realm ending `super-agent-test`.
- `OIDC_ADMIN_USERNAME`, `OIDC_ADMIN_PASSWORD`: test Keycloak administrator credentials able to create and delete users in that realm.

The fixture expects the configured native client `super-agent-native`, audience `super-agent-api`, redirect URI `superagent://oauth/callback`, required S256 PKCE and standard `openid profile email` scopes (including the `sub` claim). The administrator token uses the Keycloak `admin-cli` client in `master`. Configure these in the cloud test deployment before running.

With the variables already exported, run from the repository root:

```sh
node --import tsx spikes/oidc-cloud-smoke.ts
```

Alternatively, use Node's explicit `--env-file` option with a private ignored environment file. The script does not automatically load `.env.test` or any secret file. Missing configuration fails before making requests. Non-test databases, loopback hosts and production realms are rejected. It prints only fixed status messages, never tokens, passwords or database connection strings. It runs separately from default tests and CI because it changes the real test realm. Interrupted processes may require removing a leftover `smoke-*` user in that test realm.
