# Firefox Browser MCP

---

Project Start Date: 2026-07-30 (first working files; git history initialized 2026-07-30)
Last Update Project: 2026-08-01
Project Phase: Initial development — first release published
Project Status: mcp-server published to PyPI (v0.2.0, adds SSE/streamable-http always-on transports); not yet formally tested end-to-end against a live browser

---

## Project Summary

Firefox Browser MCP lets an LLM/MCP client (e.g. Claude Desktop) drive a **real
Firefox browser** — every tab, its DOM, arbitrary CSS selectors, JavaScript, and
its network/API traffic.

It consists of two independent, separately-versioned components:

- `mcp-server/` — a Python [MCP](https://modelcontextprotocol.io) server
  (version 0.2.0, **published on PyPI as `firefox-browser-mcp`**) that exposes
  browser tools over stdio (or an always-on SSE/streamable-http endpoint) and
  hosts a local WebSocket bridge. Runnable via `uvx firefox-browser-mcp`.
- `firefox-extension/` — a Firefox WebExtension (Manifest V2, version 0.2.6, add-on display name "Browser MCP Bridge")
  that connects to the bridge as a WebSocket client and performs real browser
  actions on any tab.

Repository: https://github.com/ICWR-TEAM/Firefox-Browser-MCP
PyPI: https://pypi.org/project/firefox-browser-mcp/

Scope: local browser automation for a single machine (server + Firefox on the
same host). Out of scope for now: multi-browser, remote/hosted control, signing
& AMO publishing of the extension.

## Mandatory Workflow

- First step for every task: always read NOTE.md before making changes.
- Check existing documentation before modifying architecture.
- Preserve existing project conventions.
- Last step for every task: always update NOTE.md and docs/changelog/[yyyy]/[mm]/[dd].md.

## Restrictions

- Do not modify core architecture without documentation.
- Do not remove existing features without confirmation.
- Do not introduce dependency without justification.
- Do not ignore existing project constraints.
- Keep the two folders (`mcp-server/`, `firefox-extension/`) independent; do not
  couple them beyond the JSON-over-WebSocket message contract.
- Server tool names, extension `command` names, and content-script `action`
  names must stay in sync (server sends `command` → background routes → content
  `action`).
- Never commit secrets (PyPI tokens, GitHub PATs, `.pypirc`). `.gitignore`
  excludes token files; the git remote PAT lives only in local `.git/config`.

## AI Operating Context

- AI acts as development assistant for this repository.
- AI must prioritize consistency over speed.
- AI must document important decisions (append to Architecture Decision Log).
- AI must not invent facts; use `TBD — confirm with maintainer` when unknown.
- Boundaries: prefer minimal, focused changes; do not run destructive git/file
  operations; keep all work inside the workspace; never write secrets to files.

## Technical Development Details

- **Programming language:** Python (server, `>=3.10`) and JavaScript (extension,
  browser WebExtension APIs, no build step).
- **Framework / libraries:**
  - Server: `mcp` SDK's `FastMCP` (stdio, plus optional `sse`/`streamable-http`
    HTTP transports via bundled `uvicorn`/`starlette`; pinned `mcp<2` since 2.0
    removed the bundled FastMCP), `websockets>=12.0` for the bridge. Build
    backend: `hatchling`. Deps declared in `mcp-server/pyproject.toml`.
  - Extension: vanilla WebExtension APIs (`browser.*`), Manifest V2, persistent
    background page. No frameworks/bundler.
- **Infrastructure:** none/local. A localhost WebSocket bridge on
  `ws://127.0.0.1:9010` (configurable) links the two components.
- **Database:** none. State is ephemeral in-memory (network log per tab, console
  log buffer, element `ref` map). Extension config persisted via
  `browser.storage.local` (bridge URL only).
- **API structure:**
  - MCP tools (server → client): see Core Flow. Namespaced `browser_*`.
  - Internal bridge protocol (server ⇄ extension): JSON messages
    `{ id, command, params }` request / `{ id, result }` or `{ id, error }`
    response over WebSocket, correlated by `id` (uuid).
- **Deployment model:** `uvx firefox-browser-mcp` (published) or
  `uvx --from ./mcp-server firefox-browser-mcp` (from source). Extension loaded
  as a temporary add-on via `about:debugging`. Release: `uv build` +
  `twine upload` (token supplied at publish time only, never stored in repo).
- **Coding convention:** Python — type hints, docstrings on every tool, PEP8-ish,
  4-space indent. JS — vanilla, defensive `try/catch`, feature-guarded APIs.
- **Security requirement:** bridge bound to localhost only; single active
  extension connection (newest wins). `browser_eval` executes arbitrary JS in the
  page context (powerful — noted as a risk/pending item). Response bodies capped
  at 512 KB. No auth on the bridge (relies on localhost isolation). Secrets are
  never committed.

## Core Flow Project

```
MCP client ──stdio (MCP)──► mcp-server ──ws://127.0.0.1:9010──► firefox-extension ──► all tabs
```

- **Input:** MCP tool calls from the client. Tabs are targeted by an optional
  `tab` argument: a numeric `id`, a title/url substring, or omitted (active tab).
  Elements are targeted by a `ref` (from `browser_snapshot`/`browser_query`) or a
  CSS `selector`.
- **Processing:** `server.py` wraps each tool, forwards `send_command()` through
  `bridge.py` (WebSocket server holding one extension connection). The
  extension's `background.js` routes commands: tab-level ops (navigate, tabs,
  screenshot, history, network) handled directly; DOM ops delegated to
  `content.js`.
- **Logic:**
  - Tab resolution (`resolveTab`) maps id/substring → a real tab.
  - `content.js` builds accessibility snapshots, resolves refs/selectors, and
    simulates click/type/hover/select/scroll/keypress; `eval` runs page JS.
  - `background.js` `webRequest` listeners capture per-tab network entries;
    `filterResponseData` captures XHR/fetch response bodies (Firefox-only).
  - `injected.js` (page context) hooks `console.*` and forwards to `content.js`.
- **Output:** tool results returned to the MCP client (text, JSON, or PNG image
  for screenshots).
- **External integration:** the Firefox browser itself (WebExtension APIs), the
  MCP client, and PyPI/GitHub for distribution. No third-party runtime services.

Tool groups: tabs (`browser_list_tabs/select_tab/new_tab/close_tab`), navigation
(`browser_navigate/go_back/go_forward/reload`), inspection & extraction
(`browser_snapshot`, `browser_query`, `browser_get_text/html/attribute`,
`browser_eval`, `browser_get_url`, `browser_screenshot`,
`browser_get_console_logs`), network (`browser_get_network`,
`browser_clear_network`), interaction (`browser_click`, `browser_type`,
`browser_hover`, `browser_select_option`, `browser_press_key`, `browser_scroll`,
`browser_wait`), and `browser_status`.

## Architecture Decision Log

Date: 2026-07-30
Decision: Communicate via a localhost WebSocket bridge (server hosts, extension
connects as client) using JSON `{id, command, params}` messages.
Reason: Simpler to set up than Native Messaging; matches the common "Browser MCP"
pattern; lets the persistent background page keep a stable connection.
Impact: No auth layer (localhost-only); one extension connection at a time
(newest wins); server and browser must share a host.

Date: 2026-07-30
Decision: Use Manifest V2 with a persistent background page for the extension.
Reason: Firefox MV3 background scripts are event-based and get terminated,
breaking the long-lived WebSocket and network capture. MV2 is still fully
supported in Firefox.
Impact: Stable WebSocket + `webRequest` capture. Not portable to Chrome MV3 as-is;
will need rework if MV3 is required later.

Date: 2026-07-30
Decision: Capture XHR/fetch response bodies via `browser.webRequest.filterResponseData`
(requires `webRequestBlocking`), capped at 512 KB.
Reason: Response bodies (JSON APIs) are the most valuable network data for an agent.
Impact: Firefox-specific; adds `webRequest`/`webRequestBlocking` permissions;
large/binary bodies are skipped.

Date: 2026-07-30
Decision: Identify tabs by their stable `browser.tabs` `id` (not index), exposed
alongside title/url, with substring matching as a convenience.
Reason: Tab index changes on reorder; id is stable for reliable targeting.
Impact: `browser_select_tab`/`close_tab`/etc. take a `tab` selector (id or
title/url substring).

Date: 2026-07-30
Decision: Provide `browser_eval` (arbitrary JS in the page's isolated content world).
Reason: Enables extraction of anything not covered by dedicated tools.
Impact: Powerful but a security consideration; enabled by default (see Pending).

Date: 2026-07-30
Decision: Publish the server to PyPI as `firefox-browser-mcp` (v0.1.0) via
`uv build` + `twine`, and host the repo at github.com/ICWR-TEAM/Firefox-Browser-MCP.
Reason: Enable one-line `uvx firefox-browser-mcp` usage for end users.
Impact: `pyproject.toml` gained project URLs + classifiers; releases now follow a
build/upload flow; tokens must be supplied at publish time and never committed.

Date: 2026-07-30
Decision: Add `web-ext` tooling (package.json scripts + web-ext-config.cjs) and
declare `data_collection_permissions: { required: ["none"] }` in the manifest for
AMO submission.
Reason: `web-ext lint/build/sign` is the official path to package and sign the
extension; the data-collection key is now required by AMO for new extensions.
Impact: `npx web-ext build` produces an AMO-ready .zip; lint passes with 0 errors
(a DANGEROUS_EVAL warning remains due to `browser_eval`'s Function constructor,
which may need justification for a *listed* review).

Date: 2026-07-30
Decision: For AMO submission, raise the extension `strict_min_version` to `142.0`
and reimplement `browser_eval` to inject a page-context `<script>` (result via
postMessage) instead of using the `Function` constructor. Bumped extension to
v0.2.1.
Reason: `data_collection_permissions` is only supported on Firefox 140+/Android
142+ (mismatch with min 109 caused warnings); the `Function` constructor tripped
the `DANGEROUS_EVAL` linter warning.
Impact: `web-ext lint` now reports 0 errors / 0 warnings. `browser_eval` now runs
in the page's main world (can read page globals) but may be blocked by a strict
page CSP (`script-src` without `'unsafe-inline'`). Minimum Firefox is now 142.

Date: 2026-07-30
Decision: Rename the extension's manifest `name` (and toolbar title) from
"Firefox Browser MCP" to "Browser MCP Bridge" (v0.2.2); remove the word from the
manifest description too. Keep the project/repo name and PyPI package name
(`firefox-browser-mcp`) unchanged.
Reason: AMO rejects add-on names containing the "Firefox"/"Mozilla" trademarks.
Impact: The AMO-submitted package is `browser_mcp_bridge-0.2.6.zip`; the add-on
id (`firefox-browser-mcp@incrustwerush.org`) is unchanged. Repo, docs, and PyPI naming
are unaffected.

Date: 2026-07-30
Decision: Add CLI args to the server (`--host`, `--port`, `--log-level`,
`--version`) overriding the `FBMCP_*` env vars; add an Enable/Disable toggle to
the extension popup (persisted). Pin `mcp<2.0.0`. Server -> v0.1.1, extension ->
v0.2.4.
Reason: Let users adjust the bridge via args and turn the browser connection on/
off from the browser. `mcp` 2.0.0 removed `mcp.server.fastmcp`, which broke the
runtime import — capping at `<2` restores it (mcp 1.29.0).
Impact: `uvx firefox-browser-mcp --port ... ` works; popup toggle controls
connect/disconnect (no reconnect while disabled). Published PyPI 0.1.1 fixes the
0.1.0 runtime import break.

Date: 2026-07-31
Decision: Add an always-on HTTP transport option to the server: `--transport`
`stdio` (default) | `sse` | `streamable-http`, plus `--http-host`/`--http-port`.
For the HTTP transports, bind the WebSocket bridge to the HTTP app\'s lifespan
(not the per-session MCP lifespan) and make `bridge.start()/stop()`
reference-counted/idempotent. Server -> v0.2.0.
Reason: With stdio the client spawns the server per session, so the bridge (and
the extension connection) only lives during a session — the user wanted the
browser connection to stay available. Running once over SSE/streamable-http and
tying the bridge to the HTTP server keeps it up across sessions; the extension
connects immediately and stays connected.
Impact: `uvx firefox-browser-mcp --transport sse` exposes `http://host:port/sse`
(`/mcp` for streamable-http) while the bridge stays on `ws://host:9010`. Clients
configure a URL instead of a command (stdio-only clients can use an `mcp-remote`
shim). Verified: bridge listens at startup before any client connects, a WS
client connects immediately, and streamable-http `initialize` returns a valid
MCP response. Published PyPI 0.2.0.

## Current State

- Feature-complete MVP for both components; builds and syntax-checks pass
  (`uv build` succeeds; `twine check` PASSED; `py_compile` and `node --check`
  pass; manifest is valid).
- Server v0.2.0 **published on PyPI** (`uvx firefox-browser-mcp` works; CLI
  args `--transport/--host/--port/--http-host/--http-port/--log-level/--version`;
  `mcp<2` pin). stdio + always-on `sse`/`streamable-http` transports (bridge tied
  to the HTTP app lifespan; reference-counted start/stop). 24 `browser_*` tools
  in `server.py`, bridge in `bridge.py`.
- Extension (v0.2.6): full command router, tab resolution across all windows,
  DOM interaction, CSS-selector queries, JS eval, per-tab network capture with
  response bodies, console capture, and a popup showing connection status +
  configurable bridge URL.
- Git history initialized and pushed to GitHub (ICWR-TEAM/Firefox-Browser-MCP).
- Extension packaging ready for AMO: `web-ext lint` passes (0 errors, 3 warnings),
  `web-ext lint` passes with 0 errors / 0 warnings; `web-ext build` produces
  `firefox-extension/web-ext-artifacts/browser_mcp_bridge-0.2.6.zip`. Not yet
  submitted/signed on AMO.
- Not yet: automated tests/CI, AMO submission/signing, extension icons,
  end-to-end runtime test against a live browser.

## Pending Issue

Issue: No end-to-end runtime test performed (server ⇄ live Firefox extension).
Priority: High
Status: Open
Possible Solution: Load the temp add-on, run the server, exercise each tool group
manually or add an integration harness. (Note: SSE/streamable-http paths were
smoke-tested — bridge-at-startup, WS connect, and streamable-http `initialize` —
but not yet against the live extension.)

Issue: `browser_eval` runs arbitrary JS in the page with no gating (now executed
in the page's main world via injected <script>; may be blocked by strict CSP).
Priority: Medium
Status: Open
Possible Solution: Add an env flag (e.g. `FBMCP_ALLOW_EVAL`) to disable it, or a
per-session confirmation.

Issue: No automated tests / CI (including no automated PyPI release workflow).
Priority: Medium
Status: Open
Possible Solution: Add pytest for the bridge protocol and a GitHub Actions
workflow for lint/build and (tag-triggered) PyPI publish via trusted publishing.

Issue: Extension is unsigned and has no toolbar icons; temporary add-ons are
removed on Firefox restart.
Priority: Low
Status: Open
Possible Solution: Add icons and sign/publish via AMO for a permanent install.

## Changelog Reference

Daily history lives under `docs/changelog/[yyyy]/[mm]/[dd].md`.
Latest: `docs/changelog/2026/08/01.md` (extension version bump to 0.2.6; web-ext lint 0/0; pushed to GitHub).
