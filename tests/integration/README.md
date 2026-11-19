# Cloud cross-component checks

Run from the repository root:

```sh
pnpm test:integration
```

Set both `TEST_DATABASE_URL` and `TEST_MIGRATION_DATABASE_URL`, or provide root `.env.test` (ignored by git). Both must point to the same cloud PostgreSQL database named `super_agent_test` or ending `_test`. Production names and localhost are rejected. Missing configuration explicitly skips these tests. Connection strings are not printed.

These tests run migrations in the dedicated test database and create unique tenant fixtures. They use the real control service, device Ed25519 authentication, NodeAgent, ToolBroker and local SQLite. HTTP uses Fastify inject with a fetch adapter; no local port, database service, Docker or server image is started.

Covered flows:

- Pairing/signing → dispatch/accept → explicitly labelled FakeRuntime → memory/checkpoint/status/cost → restart/replay without duplicate work or cost; cross-tenant task and cost isolation.
- Execution success becomes `awaiting_review`; an explicit client review accepts the fixed delivery before the Task becomes `succeeded`.
- Worker completion → durable Coordinator event → fresh scripted read-only verifier → independently fetched text artifact → accepted delivery, separate review usage and one user report → restart without model replay. The object-transfer transport in this case is an explicit fixture, not a live S3 acceptance.
- Selected main assistant and second execution computer, chat proposal without execution, user goal confirmation, restart while waiting for confirmation, pinned Grok/device routing, idempotent confirm, cancellation without new work.
- Active browser task pause before human takeover, screenshot subscription, natural pixel to CSS input mapping, stale frame rejection, cross-tenant frame denial, control release.
- Scripted runtime clarification before planning, recent conversation preserved across separate model turns, no work before goal confirmation.

CSI, Agent Recall upstream and model inference are explicit fixtures. These checks exercise real cloud PostgreSQL and cross-component contracts; they do not establish live Chrome, real Grok billing or public API deployment readiness. `pnpm exec tsx spikes/codex-probe.ts` separately verifies the installed Codex app-server handshake and dynamic tool registration without inference.
