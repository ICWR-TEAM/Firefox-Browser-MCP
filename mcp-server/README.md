# Firefox Browser MCP — Server

An [MCP](https://modelcontextprotocol.io) server that lets an LLM client drive a
**real Firefox browser** — every tab, its DOM, arbitrary CSS selectors, and its
network/API traffic. It talks to the companion `firefox-extension/`
WebExtension over a local WebSocket bridge.

```
MCP client (Claude Desktop, etc.)
        │  stdio (MCP)
        ▼
firefox-browser-mcp  ──ws://127.0.0.1:9010──►  Firefox extension  ──►  All tabs
```

## Run with uvx

```bash
uvx --from ./mcp-server firefox-browser-mcp
```

Once published to PyPI: `uvx firefox-browser-mcp`.

## Configure your MCP client

```json
{
  "mcpServers": {
    "firefox-browser": {
      "command": "uvx",
      "args": ["--from", "/absolute/path/to/mcp-server", "firefox-browser-mcp"]
    }
  }
}
```

## Targeting tabs

Every tab has a stable numeric **`id`** (plus title and url). Get them with
`browser_list_tabs`. Most tools accept an optional `tab` argument:

| `tab` value            | Meaning                                   |
| ---------------------- | ----------------------------------------- |
| omitted                | the currently active tab                  |
| `123` / `"123"`        | the tab whose id is 123                   |
| `"github.com"`         | first tab whose **url** contains it       |
| `"Inbox"`              | first tab whose **title** contains it     |

## Environment variables

| Variable          | Default     | Description               |
| ----------------- | ----------- | ------------------------- |
| `FBMCP_HOST`      | `127.0.0.1` | WebSocket bridge host     |
| `FBMCP_PORT`      | `9010`      | WebSocket bridge port     |
| `FBMCP_LOG_LEVEL` | `INFO`      | Python logging level      |

> If you change the port, update the bridge URL in the extension popup.

## Tools

**Tabs** — `browser_list_tabs` (id/title/url of every tab, all windows),
`browser_select_tab`, `browser_new_tab`, `browser_close_tab`.

**Navigation** — `browser_navigate`, `browser_go_back`, `browser_go_forward`,
`browser_reload`.

**Inspection & extraction** —
`browser_snapshot` (accessibility tree with `ref` ids),
`browser_query` (any CSS selector → refs, text, attributes, html),
`browser_get_text`, `browser_get_html`, `browser_get_attribute`,
`browser_eval` (run JS and return the result),
`browser_get_url`, `browser_screenshot`, `browser_get_console_logs`.

**Network / API** — `browser_get_network` (captured requests with method, url,
status, content-type, request & response bodies), `browser_clear_network`.

**Interaction** — `browser_click`, `browser_type`, `browser_hover`,
`browser_select_option`, `browser_press_key`, `browser_scroll`, `browser_wait`.
Interaction tools accept either a `ref` (from snapshot/query) or a CSS
`selector`.

**Status** — `browser_status`.

## Examples (what an agent can do)

- "List my tabs, then read the article in the tab with 'wikipedia' in its url":
  `browser_list_tabs` → `browser_get_text(tab="wikipedia")`.
- "Grab all product prices": `browser_query(selector=".price")` or
  `browser_eval(script="return Array.from(document.querySelectorAll('.price')).map(e=>e.textContent)")`.
- "Show the API calls this page made":
  `browser_get_network(filter="xmlhttprequest")` (includes JSON response bodies).
- "Log into the form": `browser_type(selector="#email", text=...)`,
  `browser_type(selector="#password", text=..., submit=True)`.

## Development

```bash
cd mcp-server
uv venv && source .venv/bin/activate
uv pip install -e .
python -m firefox_browser_mcp.server
```
