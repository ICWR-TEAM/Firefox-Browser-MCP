"""Firefox Browser MCP server.

Exposes browser-automation tools to an MCP client (e.g. Claude Desktop) and
forwards them to the Firefox extension over a local WebSocket bridge.

Every tab is identified by a stable numeric `id` (plus title and url). Most
tools accept an optional `tab` argument to target a specific tab:
  * a number / numeric string  -> that tab's id
  * any other string           -> first tab whose url or title contains it
  * omitted                    -> the currently active tab
"""

from __future__ import annotations

import base64
import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Optional, Union

from mcp.server.fastmcp import FastMCP, Image

from .bridge import BrowserBridge

logging.basicConfig(level=os.environ.get("FBMCP_LOG_LEVEL", "INFO"))
logger = logging.getLogger("firefox_browser_mcp")

HOST = os.environ.get("FBMCP_HOST", "127.0.0.1")
PORT = int(os.environ.get("FBMCP_PORT", "9010"))

TabSelector = Union[int, str, None]

bridge = BrowserBridge(host=HOST, port=PORT)


@asynccontextmanager
async def lifespan(_server: FastMCP) -> AsyncIterator[dict]:
    await bridge.start()
    try:
        yield {}
    finally:
        await bridge.stop()


mcp = FastMCP(
    "firefox-browser-mcp",
    instructions=(
        "Control a real Firefox browser (every tab) through a companion "
        "WebExtension.\n"
        "Tabs: use `browser_list_tabs` to get each tab's stable `id`, title "
        "and url. Pass `tab` (an id, or a title/url substring) to target a "
        "specific tab; omit it to use the active tab.\n"
        "Elements: call `browser_snapshot` for an accessibility view with "
        "`ref` ids, or `browser_query` to fetch elements by CSS selector. "
        "Interaction tools accept either a `ref` or a CSS `selector`.\n"
        "Data: `browser_get_text/html/attribute` extract page content, "
        "`browser_eval` runs JS, and `browser_get_network` returns captured "
        "HTTP/API requests (with response bodies)."
    ),
    lifespan=lifespan,
)


async def _cmd(command: str, timeout: float = 30.0, **params: Any) -> Any:
    return await bridge.send_command(command, params, timeout=timeout)


def _fmt_tabs(tabs: list[dict]) -> str:
    if not tabs:
        return "(no tabs)"
    lines = []
    for t in tabs:
        marker = "*" if t.get("active") else " "
        lines.append(
            f"{marker} id={t.get('id')} [win {t.get('windowId')}] "
            f"{t.get('title', '')} — {t.get('url', '')}"
        )
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Connection / status
# --------------------------------------------------------------------------- #
@mcp.tool()
async def browser_status() -> str:
    """Report whether the Firefox extension is currently connected to the bridge."""
    if bridge.connected:
        return f"Connected. Bridge listening on ws://{HOST}:{PORT}."
    return (
        "Not connected. Install/enable the 'Firefox Browser MCP' extension in "
        f"Firefox and make sure it can reach ws://{HOST}:{PORT}."
    )


# --------------------------------------------------------------------------- #
# Tabs
# --------------------------------------------------------------------------- #
@mcp.tool()
async def browser_list_tabs(all_windows: bool = True) -> str:
    """List open tabs with their stable `id`, window, title, and URL.

    Set `all_windows=False` to only list tabs in the current window.
    """
    result = await _cmd("list_tabs", all_windows=all_windows)
    return _fmt_tabs(result.get("tabs", []))


@mcp.tool()
async def browser_select_tab(tab: TabSelector) -> str:
    """Focus/activate a tab (by id, or title/url substring)."""
    result = await _cmd("select_tab", tab=tab)
    return f"Activated tab id={result.get('id')} ({result.get('url', '')})."


@mcp.tool()
async def browser_new_tab(url: Optional[str] = None) -> str:
    """Open a new tab, optionally navigating to `url`. Returns the new tab id."""
    result = await _cmd("new_tab", url=url, timeout=60.0)
    return f"Opened tab id={result.get('id')} ({result.get('url', 'about:blank')})."


@mcp.tool()
async def browser_close_tab(tab: TabSelector = None) -> str:
    """Close a tab (by id, or title/url substring); defaults to the active tab."""
    await _cmd("close_tab", tab=tab)
    return "Closed tab."


# --------------------------------------------------------------------------- #
# Navigation
# --------------------------------------------------------------------------- #
@mcp.tool()
async def browser_navigate(url: str, tab: TabSelector = None) -> str:
    """Navigate a tab to a URL (waits for the page to load)."""
    result = await _cmd("navigate", url=url, tab=tab, timeout=60.0)
    return (
        f"Navigated tab id={result.get('id')} to {result.get('url', url)} "
        f"(title: {result.get('title', '')})."
    )


@mcp.tool()
async def browser_go_back(tab: TabSelector = None) -> str:
    """Go back one entry in a tab's history."""
    await _cmd("go_back", tab=tab)
    return "Went back."


@mcp.tool()
async def browser_go_forward(tab: TabSelector = None) -> str:
    """Go forward one entry in a tab's history."""
    await _cmd("go_forward", tab=tab)
    return "Went forward."


@mcp.tool()
async def browser_reload(tab: TabSelector = None) -> str:
    """Reload a tab."""
    await _cmd("reload", tab=tab, timeout=60.0)
    return "Reloaded."


# --------------------------------------------------------------------------- #
# Page inspection
# --------------------------------------------------------------------------- #
@mcp.tool()
async def browser_snapshot(tab: TabSelector = None) -> str:
    """Return an accessibility-style snapshot of a tab's page.

    Lists visible interactive/text elements with a stable `ref` id
    (e.g. `[ref=e12]`) usable by interaction tools. Refs are valid until the
    page changes; re-snapshot after navigation or DOM updates.
    """
    result = await _cmd("snapshot", tab=tab, timeout=45.0)
    return result.get("snapshot", "(empty snapshot)")


@mcp.tool()
async def browser_query(
    selector: str,
    all: bool = True,
    include_html: bool = False,
    limit: int = 50,
    tab: TabSelector = None,
) -> str:
    """Find elements by CSS selector and return their details.

    Returns each match's `ref`, tag, role, accessible name, text, value and
    attributes (and outer HTML if `include_html=True`). Set `all=False` to
    return only the first match. The returned `ref`s work with
    `browser_click`, `browser_type`, etc.
    """
    result = await _cmd(
        "query",
        selector=selector,
        all=all,
        include_html=include_html,
        limit=limit,
        tab=tab,
        timeout=45.0,
    )
    return json.dumps(result, ensure_ascii=False, indent=2)


@mcp.tool()
async def browser_get_text(
    ref: Optional[str] = None,
    selector: Optional[str] = None,
    tab: TabSelector = None,
) -> str:
    """Get visible text of the whole page, or of an element (by `ref`/`selector`)."""
    result = await _cmd("get_text", ref=ref, selector=selector, tab=tab)
    return result.get("text", "")


@mcp.tool()
async def browser_get_html(
    ref: Optional[str] = None,
    selector: Optional[str] = None,
    tab: TabSelector = None,
) -> str:
    """Get outer HTML of the whole page, or of an element (by `ref`/`selector`)."""
    result = await _cmd("get_html", ref=ref, selector=selector, tab=tab)
    return result.get("html", "")


@mcp.tool()
async def browser_get_attribute(
    name: Optional[str] = None,
    ref: Optional[str] = None,
    selector: Optional[str] = None,
    tab: TabSelector = None,
) -> str:
    """Get attribute(s) of an element (by `ref`/`selector`).

    Returns the value of `name`, or a JSON object of all attributes if `name`
    is omitted.
    """
    result = await _cmd("get_attribute", name=name, ref=ref, selector=selector, tab=tab)
    if "value" in result:
        return "" if result["value"] is None else str(result["value"])
    return json.dumps(result.get("attributes", {}), ensure_ascii=False, indent=2)


@mcp.tool()
async def browser_eval(script: str, tab: TabSelector = None) -> str:
    """Run JavaScript in a tab's page and return the JSON-serialized result.

    The script body may use `await` and should `return` a value, e.g.:
    `return document.querySelectorAll('a').length` or
    `return Array.from(document.querySelectorAll('h2')).map(e => e.textContent)`.
    """
    result = await _cmd("eval", script=script, tab=tab, timeout=45.0)
    return json.dumps(result.get("result"), ensure_ascii=False, indent=2)


@mcp.tool()
async def browser_get_url(tab: TabSelector = None) -> str:
    """Return the id, URL and title of a tab (defaults to the active tab)."""
    result = await _cmd("get_url", tab=tab)
    return f"id={result.get('id')}\n{result.get('url', '')}\n{result.get('title', '')}"


@mcp.tool()
async def browser_screenshot(tab: TabSelector = None) -> Image:
    """Take a PNG screenshot of a tab (activates it first if needed)."""
    result = await _cmd("screenshot", tab=tab, timeout=45.0)
    data_url: str = result.get("dataUrl", "")
    b64 = data_url.split(",", 1)[1] if "," in data_url else data_url
    return Image(data=base64.b64decode(b64), format="png")


@mcp.tool()
async def browser_get_console_logs(tab: TabSelector = None) -> str:
    """Return recent console log/error entries captured from a tab."""
    result = await _cmd("get_console_logs", tab=tab)
    logs = result.get("logs", [])
    if not logs:
        return "(no console logs captured)"
    return "\n".join(
        f"[{entry.get('level', 'log')}] {entry.get('text', '')}" for entry in logs
    )


# --------------------------------------------------------------------------- #
# Network capture
# --------------------------------------------------------------------------- #
@mcp.tool()
async def browser_get_network(
    tab: TabSelector = None,
    filter: Optional[str] = None,
    limit: int = 50,
    include_body: bool = True,
) -> str:
    """Return HTTP/API requests captured for a tab.

    Each entry includes method, url, resource type, status, content-type and
    (for XHR/fetch) the request and response bodies. Use `filter` to match a
    URL substring, an HTTP method, or a resource type (e.g. 'xmlhttprequest').
    Set `include_body=False` for a lighter summary.
    """
    result = await _cmd(
        "get_network",
        tab=tab,
        filter=filter,
        limit=limit,
        include_body=include_body,
    )
    requests = result.get("requests", [])
    if not requests:
        return "(no network requests captured for this tab)"
    return json.dumps(requests, ensure_ascii=False, indent=2)


@mcp.tool()
async def browser_clear_network(tab: TabSelector = None) -> str:
    """Clear the captured network log for a tab."""
    await _cmd("clear_network", tab=tab)
    return "Cleared network log."


# --------------------------------------------------------------------------- #
# Interaction
# --------------------------------------------------------------------------- #
@mcp.tool()
async def browser_click(
    ref: Optional[str] = None,
    selector: Optional[str] = None,
    double: bool = False,
    tab: TabSelector = None,
) -> str:
    """Click an element identified by `ref` or CSS `selector`."""
    await _cmd("click", ref=ref, selector=selector, double=double, tab=tab)
    return f"Clicked {ref or selector}."


@mcp.tool()
async def browser_type(
    text: str,
    ref: Optional[str] = None,
    selector: Optional[str] = None,
    submit: bool = False,
    clear: bool = True,
    tab: TabSelector = None,
) -> str:
    """Type `text` into an element identified by `ref` or CSS `selector`.

    `clear=True` clears existing value first; `submit=True` presses Enter after.
    """
    await _cmd(
        "type", ref=ref, selector=selector, text=text, submit=submit, clear=clear, tab=tab
    )
    return f"Typed into {ref or selector}."


@mcp.tool()
async def browser_hover(
    ref: Optional[str] = None,
    selector: Optional[str] = None,
    tab: TabSelector = None,
) -> str:
    """Hover the mouse over an element identified by `ref` or CSS `selector`."""
    await _cmd("hover", ref=ref, selector=selector, tab=tab)
    return f"Hovered {ref or selector}."


@mcp.tool()
async def browser_select_option(
    value: str,
    ref: Optional[str] = None,
    selector: Optional[str] = None,
    tab: TabSelector = None,
) -> str:
    """Select an option (by value or visible label) in a <select> element."""
    await _cmd("select_option", ref=ref, selector=selector, value=value, tab=tab)
    return f"Selected '{value}'."


@mcp.tool()
async def browser_press_key(key: str, tab: TabSelector = None) -> str:
    """Press a keyboard key on the page (e.g. 'Enter', 'Escape', 'ArrowDown')."""
    await _cmd("press_key", key=key, tab=tab)
    return f"Pressed {key}."


@mcp.tool()
async def browser_scroll(
    ref: Optional[str] = None,
    selector: Optional[str] = None,
    x: int = 0,
    y: int = 0,
    tab: TabSelector = None,
) -> str:
    """Scroll a tab by (x, y) pixels, or scroll an element into view if given."""
    await _cmd("scroll", ref=ref, selector=selector, x=x, y=y, tab=tab)
    return "Scrolled."


@mcp.tool()
async def browser_wait(seconds: float = 1.0) -> str:
    """Wait for a number of seconds (useful for animations / async loads)."""
    await _cmd("wait", seconds=seconds, timeout=seconds + 30.0)
    return f"Waited {seconds}s."


def main() -> None:
    """Console-script entry point (stdio transport)."""
    mcp.run()


if __name__ == "__main__":
    main()
