# Firefox Browser MCP — Extension

A Firefox WebExtension (Manifest V2) that connects to the `firefox-browser-mcp`
server and executes browser actions on **any tab** on its behalf: DOM
inspection, CSS-selector queries, JS evaluation, typing/clicking, screenshots,
and **network/API capture**.

## Load it in Firefox (temporary / development)

1. Start the MCP server first (opens `ws://127.0.0.1:9010`):
   ```bash
   uvx firefox-browser-mcp
   ```
2. Go to `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and select `firefox-extension/manifest.json`.
4. Click the toolbar icon — the popup should show **Connected** (green dot, "on"
   badge).

> Temporary add-ons are removed on restart. For a permanent install, publish/sign
> via AMO (see below).

## Publish / sign on AMO (addons.mozilla.org)

Tooling is set up via Mozilla's [`web-ext`](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/)
(no global install needed — `npx` works; or `npm install` first to use the
scripts).

1. **Lint & build a .zip:**
   ```bash
   cd firefox-extension
   npx web-ext lint      # 0 errors expected (a DANGEROUS_EVAL warning remains)
   npx web-ext build     # -> web-ext-artifacts/firefox_browser_mcp-<version>.zip
   ```
2. **Create an AMO developer account** at https://addons.mozilla.org/developers/
3. **Submit** — either:
   - **Dashboard:** Developer Hub → *Submit a New Add-on* → choose **listed**
     (public) or **unlisted** (private) → upload the `.zip` → fill in the form.
   - **CLI:** generate API credentials at
     https://addons.mozilla.org/developers/addon/api/key/ then:
     ```bash
     npx web-ext sign --channel=unlisted \
       --api-key="AMO_JWT_ISSUER" --api-secret="AMO_JWT_SECRET"
     ```
     `--channel=listed` publishes publicly; `--channel=unlisted` returns a
     signed `.xpi` you can install yourself. **Never commit these keys.**

Notes for review:
- The manifest already declares a stable add-on id and
  `data_collection_permissions: { required: ["none"] }` (the add-on sends data to
  a *local* server you run, not to the developer).
- `browser_eval` uses the `Function` constructor, which triggers a
  `DANGEROUS_EVAL` warning. Automated signing (unlisted) still succeeds; for a
  **listed** submission a human reviewer may ask you to justify or remove it.
- Broad host access (`<all_urls>`) plus `webRequest`/`webRequestBlocking` will
  require a clear privacy/justification note in the listing.

## How it works

```
background.js  ── WebSocket client ─►  MCP bridge (ws://127.0.0.1:9010)
      │
      ├─ tab-level: navigate, tabs, screenshot, history
      ├─ webRequest listeners ─► per-tab network log (headers, status,
      │                          request body, response body via
      │                          filterResponseData)
      └─ content.js ── DOM: snapshot, query(selector), get_text/html/attribute,
             │              eval(JS), click, type, hover, scroll, press_key
             └─ injected.js ── page-context console capture
```

### Tabs

Every tab is reported with a stable numeric `id`, plus `index`, `windowId`,
`title`, `url`, and `active`. Commands target a tab by id or by a title/url
substring; if none is given, the active tab is used.

### Network capture

The `webRequest` API records requests per tab. For `xmlhttprequest` (fetch/XHR)
it also captures **response bodies** using Firefox's `filterResponseData`
(requires the `webRequestBlocking` permission). Bodies over 512 KB are skipped.

## Configuration

Use the popup to change the **Bridge WebSocket URL** (must match `FBMCP_HOST` /
`FBMCP_PORT` on the server). Stored in `browser.storage.local`.

## Permissions

- `tabs`, `activeTab`, `<all_urls>` — read/act on pages and tabs.
- `webNavigation` — detect page loads.
- `webRequest`, `webRequestBlocking` — capture network traffic + response bodies.
- `storage` — remember the bridge URL.

## Files

| File                 | Purpose                                                   |
| -------------------- | --------------------------------------------------------- |
| `manifest.json`      | Extension manifest (MV2, persistent background).          |
| `background.js`      | WebSocket client, command router, tabs & network capture. |
| `content.js`         | DOM snapshot, selector queries, JS eval, interaction.     |
| `injected.js`        | Page-context console hook.                                |
| `popup.html/js`      | Connection status + bridge URL settings.                  |
| `package.json`       | `web-ext` scripts (lint/build/run/sign).                  |
| `web-ext-config.cjs` | Packaging config (files excluded from the .zip/.xpi).     |
