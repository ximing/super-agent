# Project instructions

## Execution and infrastructure

- Implement the accepted product and technical design in `docs/`; update the design when verified implementation constraints require it.
- All server infrastructure is cloud-hosted and deployed by the user: PostgreSQL, object storage, OIDC, CI and container images. Do not start or pull local Docker resources, run local database services, or build local server images.
- Models, credentials, browser control and execution remain on each user's Mac. Node SQLite is a local durable execution journal, not shared server storage.
- Never upload or log Codex authentication files, Grok keys, cookies, device private keys or full database connection strings.
- Integration tests require an explicitly configured cloud `TEST_DATABASE_URL`; never use production. Clearly skip cloud-dependent tests when unavailable, and never replace production PostgreSQL with an in-memory store.
- Use independent agents for independent components, with explicit file ownership. Coordinate shared protocol/root lockfile changes; avoid competing installs.

## Repository

- `apps/control-server`: Fastify/PostgreSQL control service and migrations.
- `apps/node`, `packages/runtime-*`, `packages/tool-broker`: local Mac execution.
- `apps/macos`: Swift native client; `apps/android`: React Native native client.
- `packages/protocol`: shared types/invariants; `docs/implementation-contract.md`: cross-component API contract.
- Do not edit `apps/server` or `db` without ownership reassignment: an earlier external Orca launch has an unverifiable outcome. Preserve unknown editors' work.

## CodeGraph

When `.codegraph/` exists at the repository root, use `codegraph_explore` before grep/find or reading code to understand or locate symbols. Name a file or symbol to read current source. Without `.codegraph/`, skip CodeGraph; do not create an index.
