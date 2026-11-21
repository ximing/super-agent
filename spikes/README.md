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
- `OIDC_ISSUER`: HTTPS Keycloak issuer for the exact realm `aimo-plus-test`.
- `OIDC_ADMIN_USERNAME`, `OIDC_ADMIN_PASSWORD`: test Keycloak administrator credentials able to create and delete users in that realm.

The fixture expects the configured native client `super-agent-native`, audience `super-agent-api`, redirect URI `superagent://oauth/callback`, required S256 PKCE and standard `openid profile email` scopes (including the `sub` claim). The administrator token uses the Keycloak `admin-cli` client in `master`. Configure these in the cloud test deployment before running.

With the variables already exported, run from the repository root:

```sh
node --import tsx spikes/oidc-cloud-smoke.ts
```

Alternatively, use Node's explicit `--env-file` option with a private ignored environment file. The script does not automatically load `.env.test` or any secret file. Missing configuration fails before making requests. Non-test databases, loopback hosts and production realms are rejected. It prints only fixed status messages, never tokens, passwords or database connection strings. It runs separately from default tests and CI because it changes the real test realm. Interrupted processes may require removing a leftover `smoke-*` user in that test realm.

# Explicit live Codex dynamic-tool acceptance

**Real dynamic-tool acceptance passed using the existing macOS system proxy.** `codex-live-tool-probe.ts` is an opt-in real inference probe, separate from default tests and CI. It creates a temporary read-only fixture, gives the real `CodexRuntime` only the `files_read` dynamic tool through the real `ToolBroker`, requires exactly one fixture read and a fixed marker response, then removes the fixture. Shell, browser, computer, plugins, apps, hooks and configured MCP servers are disabled with process arguments; global Codex configuration is not changed. It reads only the public model/MCP names from `config.toml`, never authentication files. An explicit `SUPER_AGENT_CODEX_MODEL` may select an already available local model.

```sh
node --import tsx spikes/codex-live-tool-probe.ts --output spikes/codex-live-tool-result.json
```

The default total budget is 55 seconds, capped there even if `SUPER_AGENT_PROBE_TIMEOUT_MS` is larger, with four seconds reserved for shutdown. The separately authorized `--default-model` mode selects the model-list default and allows a 90-second total budget. The wire request explicitly sets `turn/start.effort` to `low`. Fatal errors fail immediately; retryable errors remain subject to the total deadline. Only protocol method names, whitelisted error codes/status/retry flags, aggregate usage, receipt booleans and duration are reported; fixture contents and model reply text are not printed. Usage can be unavailable even when a provider request was attempted.

Observed on 2026-11-18: **live dynamic-tool acceptance did not pass**. Initial bounded turns reached initialize → thread/start → turn/start → turn/started, but produced zero dynamic-tool calls and no usage events. Read-only inspection identified the configured model as `gpt-6.1-sol` with `high` reasoning effort and the model-list default as `gpt-6.2-sol`.

A final, separately authorized test used the list default and explicit low effort:

```sh
node --import tsx spikes/codex-live-tool-probe.ts --default-model --output spikes/codex-live-tool-result.json
```

It stopped after 86.10 seconds within the 90-second total budget. The trace contained three structured errors with `code=responseStreamDisconnected`, `http_status=null`, `will_retry=true`. There were zero tool calls and zero usage samples; the temporary fixture was removed. The latest sanitized result is in `codex-live-tool-result.json`. This identifies repeated upstream response-stream interruption before a client tool request. This failed direct-path evidence is retained in `codex-live-tool-result.json`; it predates the successful proxy validation below. Transport-only success and mock subprocess tests alone must not be presented as live execution success.

This investigation added immediate failure for non-retryable Codex `error` notifications, retaining bounded waits for retryable errors. Fatal errors, retry recovery/deadline and explicit effort forwarding have mock subprocess regression coverage. Error shape and dynamic-tool response format were checked against the installed 0.170.0 generated JSON schema and [official app-server documentation](https://learn.chatgpt.com/docs/app-server). Further live retries require a diagnosed local account/provider connectivity or model configuration change.


A subsequent targeted run inherited the already enabled macOS HTTP/HTTPS system proxy through environment variables applied only to the test process. The configured TCP endpoint was checked before the test. With the same model-list default and explicit low effort, the real `CodexRuntime`/`ToolBroker` round trip passed in **28.476 seconds**: one `files_read` call, successful tool receipt, fixed marker matched, no errors, fixture removed. Token usage was input 15,217 (cached 14,976), output 9, reasoning 0. No authentication files or credentials were uploaded or printed. See `codex-live-tool-proxy-result.json`; the prior failed result remains separate.

To reproduce, provide the trusted HTTP(S) proxy already configured on that Mac as process-only `HTTP_PROXY` and `HTTPS_PROXY`, then run:

```sh
node --import tsx spikes/codex-live-tool-probe.ts --default-model --existing-system-proxy --output /tmp/codex-live-tool-proxy-result.json
```

The flag labels the network path in the report; it does not change proxy settings. The production node applies a model-client proxy only to new Grok and Codex processes: the cloud device `model_proxy_url` when set, otherwise explicit environment, then local `proxy_url`, then macOS system HTTP/HTTPS. Control-plane traffic stays direct. This acceptance covers a real read-only tool round trip; it does not validate arbitrary website workflows or Grok billing.
