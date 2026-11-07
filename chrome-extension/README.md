# Browser MCP Bridge — Chrome extension

Chrome (Manifest V3) port of `../firefox-extension/`. Same bridge protocol
(`ws://127.0.0.1:9010`, JSON `{id, command, params}`), same commands, same
popup (enable toggle, bridge URL, reconnect). The `mcp-server` is unchanged and
works with either extension (newest connection wins).

## Install (unpacked)

1. Start the server: `uvx firefox-browser-mcp`
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select this `chrome-extension/` folder.
4. The toolbar badge shows `on` when connected.

Requires Chrome 116+ (WebSocket keeps the MV3 service worker alive).

## Differences from the Firefox version

| Area | Firefox (MV2) | Chrome (MV3) |
| --- | --- | --- |
| Background | persistent page | service worker + 20 s WS keepalive + `alarms` revive |
| Response bodies | `webRequest.filterResponseData` | `fetch`/`XMLHttpRequest` hooks in `injected.js` (MAIN world) → content script → background |
| Content injection | `tabs.executeScript` | `scripting.executeScript` |
| Messaging | Promise from `onMessage` | `sendResponse` + `return true` |
| Toolbar | `browserAction` | `action` |

Notes: bodies are only captured for fetch/XHR made after the page script hooks
load (not for requests issued before `document_start` injection); network log
is in-memory and lost if the service worker is terminated. `browser_eval` uses
the same injected `<script>` approach, so a strict page CSP may block it.
