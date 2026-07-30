# Firefox Browser MCP

Control a **real Firefox browser** — every tab, its DOM, arbitrary CSS
selectors, JavaScript, and its network/API traffic — from any MCP client
(Claude Desktop, etc.). Two independent components:

```
mcp-server/         Python MCP server, published on PyPI as `firefox-browser-mcp`
firefox-extension/  Firefox WebExtension (companion)
```

[![PyPI](https://img.shields.io/pypi/v/firefox-browser-mcp.svg)](https://pypi.org/project/firefox-browser-mcp/)

## Architecture

```
 MCP client ──stdio──►  mcp-server  ──ws://127.0.0.1:9010──►  firefox-extension ──► all tabs
```

- **`mcp-server/`** exposes browser tools over MCP (stdio) and hosts a local
  WebSocket bridge.
- **`firefox-extension/`** connects to that bridge and performs the real
  browser actions on any tab.

## Quick start

1. **Run the server** (opens the bridge on `ws://127.0.0.1:9010`):
   ```bash
   uvx firefox-browser-mcp
   ```
   Or run straight from source without installing:
   ```bash
   uvx --from ./mcp-server firefox-browser-mcp
   ```
2. **Load the extension** via `about:debugging#/runtime/this-firefox` →
   *Load Temporary Add-on…* → pick `firefox-extension/manifest.json`. Use the
   popup's **Enable/Disable** toggle; it should show **Connected**.
3. **Point your MCP client** at the server:
   ```json
   {
     "mcpServers": {
       "firefox-browser": {
         "command": "uvx",
         "args": ["firefox-browser-mcp"]
       }
     }
   }
   ```

See `mcp-server/README.md` and `firefox-extension/README.md` for details.

## What it can do

- **All tabs.** Each tab has a stable numeric `id` (plus title & url). Target any
  tab by `id` or by a title/url substring, across all windows.
- **Any element.** `browser_snapshot` (accessibility refs) or `browser_query`
  (any CSS selector) → text, attributes, HTML. `browser_eval` runs arbitrary JS.
- **Network / API.** `browser_get_network` returns captured HTTP requests with
  method, url, status, content-type, and request/response bodies (JSON APIs).
- **Full remote control.** Click, type, hover, select, press keys, scroll,
  navigate, screenshot, read console logs — by `ref` or CSS `selector`.

### Tool groups

Tabs (`browser_list_tabs`, `browser_select_tab`, `browser_new_tab`,
`browser_close_tab`), navigation (`browser_navigate`, `browser_go_back/forward`,
`browser_reload`), inspection/extraction (`browser_snapshot`, `browser_query`,
`browser_get_text/html/attribute`, `browser_eval`, `browser_get_url`,
`browser_screenshot`, `browser_get_console_logs`), network
(`browser_get_network`, `browser_clear_network`), interaction (`browser_click`,
`browser_type`, `browser_hover`, `browser_select_option`, `browser_press_key`,
`browser_scroll`, `browser_wait`), and `browser_status`.

## Assumptions

- Firefox 109+ (MV2 with a persistent background page for a stable WebSocket and
  network capture; `filterResponseData` for response bodies is Firefox-specific).
- The server and Firefox run on the same machine (bridge bound to localhost).
- One Firefox instance connects to one server at a time (newest connection wins).

## Links

- PyPI: https://pypi.org/project/firefox-browser-mcp/
- Repository: https://github.com/ICWR-TEAM/Firefox-Browser-MCP

## License

MIT
