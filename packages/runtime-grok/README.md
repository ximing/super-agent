# Grok local runtimes

`GrokRuntime` retains the direct xAI Responses API loop and requires a locally configured API key. `GrokCliRuntime` uses the official **Grok Build native CLI**, currently verified with version **1.0.89**. It does not extract a CLI login into an API key. Other native versions fail with `grok_cli_version_incompatible` until their tool policy is verified.

Node configuration for an existing native login:

```json
{
  "assistant_engine": "grok",
  "grok": {
    "enabled": true,
    "mode": "cli",
    "command": "/absolute/path/to/.grok/bin/grok",
    "model": "",
    "key_env": "XAI_API_KEY",
    "base_url": "https://api.x.ai/v1"
  },
  "browser": { "enabled": false }
}
```

An empty CLI model uses its configured/catalog default, advertised as `configured-default`. `key_env`/`base_url` belong to the retained API mode and are not read for CLI authentication. `assistant_engine` selects the local coordinating assistant; task engine/device choices remain explicit product settings. Browser tools require the separately installed CSI daemon and connected Chrome extension; disabling them does not prevent files, questions, artifacts or cloud memory work.

Each CLI execution creates an owner-only temporary `GROK_HOME` and workspace, keeps `HOME` unchanged, and sets official `GROK_AUTH_PATH` to the existing local owner-only authentication file. Node uses filesystem metadata to locate that file; it never reads, copies or transmits its contents. Native CLI authentication and refresh continue to use the original path and its native lock/atomic write mechanism. The adapter does not write the user's Grok/MCP configuration.

The managed agent has an exact two-tool native configuration (`GrokBuild:search_tool`, `GrokBuild:use_tool`) for MCP discovery/dispatch; only a private `super_agent` server is installed in the temporary home. Both tool listing and actual dispatch are limited to `RuntimeContext.tools`; all calls pass through `RuntimeContext.executeTool` and the ordinary Broker lifecycle. Native filesystem, shell, browser, web search, subagents, background workflows, native memory, relay and vendor compatibility discovery are disabled. Path-specific `Read(**)` denies all actual native file paths (including `use_tool` file-input indirection) while permitting `search_tool`, which native Grok classifies as pathless `Read(None)`. A bare `Read` deny would also block MCP discovery. The private configuration explicitly allows only `MCPTool(super_agent__*)`; unsolicited ACP permission, filesystem and terminal client requests remain denied. Before a prompt, the effective MCP catalog must contain only `super_agent`; unexpected servers fail closed. Existing `/etc/grok` policy requires explicit review rather than silently bypassing it.

Readiness performs a headless `authenticate(cached_token)` after initialization; an invalid/unavailable local cache returns a fixed reason and is not advertised as ready. It never starts a login browser or a model prompt.

ACP uses `initialize` → `authenticate(cached_token)` → `session/new` → `_x.ai/mcp/list` → `session/prompt`. Vendor extension responses have an additional `result` envelope; the adapter unwraps it. `session/cancel` and `_x.ai/interject` implement stop and active input. The runtime drains private stderr without logging it, exposes only safe RPC error codes, and records prompt token counters when supplied. Currency cost remains unknown when the CLI does not supply an authoritative cost. Each written prompt has one stable attempt UUID for its usage record. If it fails or is cancelled before counters arrive, that attempt is retained with null counters/cost; initialization and authentication failures do not create model-attempt usage. Known counters on a cancelled response use the same key and are not followed by a duplicate unknown record.

Verification on the user's remote Mac (2026-11-19): official signed arm64 CLI 1.0.89, Node 24.14.1; initialization, existing-login authentication, session creation and effective catalog `['super_agent']` passed without any model prompt. During that initial read-only probe, existing Recall authentication independently returned HTTP 200 at `https://recall.aimo.plus` and no PAT was transferred. Later, the user explicitly authorized exporting the Recall binding from that Mac and importing it through the native product importer into their own production account; the binding connected successfully and the temporary import file was deleted. The PAT was not printed or added to the repository. Unit tests use a dedicated ACP subprocess and private HTTP bridge to cover allowlist enforcement, redacted errors, thoughts exclusion, steering, cancellation and deadline. These checks alone do not claim a paid model execution passed; the separate limited inference probe result is recorded by the coordinator.

Official references: [Headless scripting](https://docs.x.ai/build/cli/headless-scripting), [agent-mode guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md), [auth storage implementation](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-login/src/storage.rs), [compatibility resolution](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-config/src/compat.rs), [tool allowlist behavior](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-agent/src/tool_list.rs).

Real inference evidence (independent spikes, not product task acceptance): the first unproxied turn stopped at its 115-second deadline with zero Broker calls. The second turn inherited the existing system HTTP proxy and reached model/tool notifications in 11.6 seconds, but ended cancelled before a Broker call (input 2814, cached 1152, output 72, reasoning 39). Both failures are retained separately; the overbroad `Read` deny was found and corrected from the official permission classifier/policy source. Neither failure is reported as a successful execution.

After the pathless-read policy correction, the third limited turn passed on the actual remote Mac in 13.323 seconds: exactly one real `ToolBroker.execute(files_read)` invocation, a stable running/succeeded step, and an exact random fixture marker match. Native canonical tools were `search_tool` then `use_tool`; no permission/filesystem/terminal client request occurred. Usage: input 2899, cached 2688, output 126, reasoning 103 tokens. It inherited the existing system HTTP proxy through test-process environment variables; no system/provider configuration was changed. This is an independent runtime spike, not a completed product-task acceptance. The two earlier failed results remain separate.
