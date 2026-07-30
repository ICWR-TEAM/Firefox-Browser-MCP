"""WebSocket bridge between the MCP server and the Firefox extension.

The MCP server hosts a WebSocket server on localhost. The Firefox extension
connects to it as a client. Commands are sent as JSON messages with a unique
id, and the extension replies with a message carrying the same id.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any, Dict, Optional

import websockets
from websockets.server import WebSocketServerProtocol

logger = logging.getLogger("firefox_browser_mcp.bridge")


class BrowserBridge:
    """Holds a single active connection to the Firefox extension."""

    def __init__(self, host: str = "127.0.0.1", port: int = 9010) -> None:
        self.host = host
        self.port = port
        self._ws: Optional[WebSocketServerProtocol] = None
        self._pending: Dict[str, asyncio.Future] = {}
        self._server: Optional[websockets.server.Serve] = None

    async def start(self) -> None:
        self._server = await websockets.serve(
            self._handler,
            self.host,
            self.port,
            ping_interval=20,
            ping_timeout=20,
            max_size=32 * 1024 * 1024,  # allow large payloads (screenshots)
        )
        logger.info("Bridge listening on ws://%s:%s", self.host, self.port)

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None

    @property
    def connected(self) -> bool:
        return self._ws is not None

    async def _handler(self, ws: WebSocketServerProtocol) -> None:
        # Only one extension connection is supported; the newest wins.
        if self._ws is not None:
            try:
                await self._ws.close(code=1000, reason="Replaced by new connection")
            except Exception:  # noqa: BLE001
                pass
        self._ws = ws
        logger.info("Firefox extension connected from %s", ws.remote_address)
        try:
            async for message in ws:
                self._on_message(message)
        except websockets.ConnectionClosed:
            pass
        finally:
            if self._ws is ws:
                self._ws = None
            logger.info("Firefox extension disconnected")

    def _on_message(self, message: str) -> None:
        try:
            data = json.loads(message)
        except json.JSONDecodeError:
            logger.warning("Received non-JSON message: %r", message[:200])
            return
        mid = data.get("id")
        if mid is None:
            return
        fut = self._pending.pop(mid, None)
        if fut is not None and not fut.done():
            fut.set_result(data)

    async def send_command(
        self,
        command: str,
        params: Optional[Dict[str, Any]] = None,
        timeout: float = 30.0,
    ) -> Any:
        if not self.connected or self._ws is None:
            raise RuntimeError(
                "Firefox extension is not connected. Install/enable the "
                "'Firefox Browser MCP' extension and make sure it shows "
                "'Connected'."
            )
        mid = uuid.uuid4().hex
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        self._pending[mid] = fut
        payload = {"id": mid, "command": command, "params": params or {}}
        try:
            await self._ws.send(json.dumps(payload))
        except Exception as exc:  # noqa: BLE001
            self._pending.pop(mid, None)
            raise RuntimeError(f"Failed to send command to extension: {exc}") from exc

        try:
            resp = await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError as exc:
            self._pending.pop(mid, None)
            raise RuntimeError(
                f"Timed out after {timeout}s waiting for '{command}'."
            ) from exc

        if resp.get("error"):
            raise RuntimeError(str(resp["error"]))
        return resp.get("result")
