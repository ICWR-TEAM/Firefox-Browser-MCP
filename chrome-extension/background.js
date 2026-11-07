/* Chrome Browser MCP — background service worker (MV3), port of the Firefox
 * background script with the same command router and bridge protocol.
 *
 * Maintains a WebSocket connection to the firefox-browser-mcp bridge and
 * executes browser commands against ANY tab (identified by a stable numeric
 * id, or matched by title/url). DOM work is delegated to the content script;
 * network traffic is captured with the webRequest API.
 */

const DEFAULT_WS_URL = "ws://127.0.0.1:9010";

let socket = null;
let reconnectTimer = null;
let connected = false;
let wsUrl = DEFAULT_WS_URL;
let enabled = true;

/* ============================== connection ============================= */

async function loadConfig() {
  try {
    const cfg = await chrome.storage.local.get(["wsUrl", "enabled"]);
    if (cfg.wsUrl) wsUrl = cfg.wsUrl;
    enabled = cfg.enabled !== false; // default: enabled
  } catch (e) {
    /* ignore */
  }
}

function setConnected(state) {
  connected = state;
  chrome.storage.local.set({ connected: state }).catch(() => {});
  const color = state ? "#2e7d32" : "#9e9e9e";
  const text = state ? "on" : "";
  try {
    chrome.action.setBadgeBackgroundColor({ color });
    chrome.action.setBadgeText({ text });
  } catch (e) {
    /* ignore */
  }
}

function scheduleReconnect() {
  if (!enabled || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    try {
      socket.onclose = null;
      socket.close();
    } catch (e) {
      /* ignore */
    }
    socket = null;
  }
  setConnected(false);
}

async function setEnabled(state) {
  enabled = !!state;
  await chrome.storage.local.set({ enabled }).catch(() => {});
  if (enabled) connect();
  else disconnect();
}

function connect() {
  if (!enabled) return;
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }
  console.log("[MCP Bridge] connecting to", wsUrl);
  try {
    socket = new WebSocket(wsUrl);
  } catch (e) {
    console.warn("[MCP Bridge] failed to create WebSocket:", e);
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    console.log("[MCP Bridge] connected to", wsUrl);
    setConnected(true);
  };
  socket.onclose = (ev) => {
    console.warn(
      "[MCP Bridge] disconnected (code " + ev.code + ")." +
        (enabled ? " Retrying in 2s…" : "")
    );
    setConnected(false);
    socket = null;
    if (enabled) scheduleReconnect();
  };
  socket.onerror = () => {
    console.warn(
      "[MCP Bridge] connection error to " + wsUrl +
        " — is the server running? (uvx firefox-browser-mcp)"
    );
    try {
      socket.close();
    } catch (e) {
      /* ignore */
    }
  };
  socket.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    const { id, command, params } = msg;
    try {
      const result = await handleCommand(command, params || {});
      send({ id, result });
    } catch (err) {
      send({ id, error: String((err && err.message) || err) });
    }
  };
}

function send(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(obj));
  }
}

/* ============================ tab resolution ========================== */

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) throw new Error("No active tab.");
  return tabs[0];
}

/**
 * Resolve a target tab from params.tab which may be:
 *  - undefined/null/"" -> the active tab
 *  - a number / numeric string -> that tab's stable id
 *  - any other string -> first tab whose url or title contains it
 */
async function resolveTab(params) {
  const sel = params && (params.tab !== undefined ? params.tab : params.tabId);
  if (sel === undefined || sel === null || sel === "") {
    return await getActiveTab();
  }
  const asNum = Number(sel);
  if (!Number.isNaN(asNum) && String(asNum) === String(sel).trim()) {
    try {
      return await chrome.tabs.get(asNum);
    } catch (e) {
      throw new Error(`No tab with id ${asNum}.`);
    }
  }
  const all = await chrome.tabs.query({});
  const q = String(sel).toLowerCase();
  const match = all.find(
    (t) =>
      (t.url && t.url.toLowerCase().includes(q)) ||
      (t.title && t.title.toLowerCase().includes(q))
  );
  if (!match) throw new Error(`No tab matching '${sel}'.`);
  return match;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: "ping" });
  } catch (e) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  }
}

async function toContent(action, params) {
  const tab = await resolveTab(params);
  await ensureContentScript(tab.id);
  const resp = await chrome.tabs.sendMessage(tab.id, { action, params });
  if (resp && resp.error) throw new Error(resp.error);
  return resp || {};
}

function waitForLoad(tabId, timeoutMs = 45000) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => finish(), timeoutMs);
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/* ========================== network capture =========================== */

const MAX_NET_ENTRIES = 400;
const MAX_BODY = 512 * 1024;
const networkByTab = new Map(); // tabId -> entry[]
const entryByRequest = new Map(); // requestId -> entry

function netAdd(entry) {
  if (entry.tabId < 0) return;
  let arr = networkByTab.get(entry.tabId);
  if (!arr) {
    arr = [];
    networkByTab.set(entry.tabId, arr);
  }
  arr.push(entry);
  if (arr.length > MAX_NET_ENTRIES) {
    const removed = arr.shift();
    if (removed) entryByRequest.delete(removed.requestId);
  }
}

function extractRequestBody(rb) {
  if (!rb) return null;
  if (rb.formData) {
    try {
      return JSON.stringify(rb.formData);
    } catch (e) {
      return null;
    }
  }
  if (rb.raw && rb.raw.length) {
    try {
      const dec = new TextDecoder("utf-8");
      let t = "";
      for (const r of rb.raw) {
        if (r.bytes) t += dec.decode(new Uint8Array(r.bytes), { stream: true });
      }
      return t.slice(0, 10000);
    } catch (e) {
      return null;
    }
  }
  return null;
}

if (chrome.webRequest) {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      const entry = {
        requestId: details.requestId,
        tabId: details.tabId,
        url: details.url,
        method: details.method,
        type: details.type,
        startTime: details.timeStamp,
        status: null,
        contentType: null,
        requestBody: extractRequestBody(details.requestBody),
        responseBody: null,
        error: null,
      };
      entryByRequest.set(details.requestId, entry);
      netAdd(entry);

      // Response bodies: Chrome has no filterResponseData; bodies arrive from
      // injected.js (fetch/XHR hooks) via the "__netbody" message below.
    },
    { urls: ["<all_urls>"] },
    ["requestBody"]
  );

  chrome.webRequest.onHeadersReceived.addListener(
    (d) => {
      const e = entryByRequest.get(d.requestId);
      if (e) {
        e.status = d.statusCode;
        const ct = (d.responseHeaders || []).find(
          (h) => h.name.toLowerCase() === "content-type"
        );
        if (ct) e.contentType = ct.value;
      }
    },
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
  );

  chrome.webRequest.onCompleted.addListener(
    (d) => {
      const e = entryByRequest.get(d.requestId);
      if (e) {
        e.status = d.statusCode;
        e.endTime = d.timeStamp;
      }
    },
    { urls: ["<all_urls>"] }
  );

  chrome.webRequest.onErrorOccurred.addListener(
    (d) => {
      const e = entryByRequest.get(d.requestId);
      if (e) e.error = d.error;
    },
    { urls: ["<all_urls>"] }
  );
}

chrome.tabs.onRemoved.addListener((tabId) => networkByTab.delete(tabId));

/* =========================== command router =========================== */

function tabInfo(t) {
  return {
    id: t.id,
    index: t.index,
    windowId: t.windowId,
    title: t.title,
    url: t.url,
    active: t.active,
  };
}

async function handleCommand(command, params) {
  switch (command) {
    /* -------------------------- navigation -------------------------- */
    case "navigate": {
      const tab = await resolveTab(params);
      await chrome.tabs.update(tab.id, { url: params.url });
      await waitForLoad(tab.id);
      return tabInfo(await chrome.tabs.get(tab.id));
    }
    case "go_back": {
      const tab = await resolveTab(params);
      await chrome.tabs.goBack(tab.id);
      return {};
    }
    case "go_forward": {
      const tab = await resolveTab(params);
      await chrome.tabs.goForward(tab.id);
      return {};
    }
    case "reload": {
      const tab = await resolveTab(params);
      await chrome.tabs.reload(tab.id);
      await waitForLoad(tab.id);
      return {};
    }

    /* -------------------------- inspection -------------------------- */
    case "get_url": {
      const tab = await resolveTab(params);
      return tabInfo(tab);
    }
    case "screenshot": {
      const tab = await resolveTab(params);
      if (!tab.active) {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        await new Promise((r) => setTimeout(r, 250));
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "png",
      });
      return { dataUrl };
    }

    case "snapshot":
    case "get_text":
    case "get_html":
    case "get_console_logs":
    case "query":
    case "get_attribute":
    case "eval":
    case "click":
    case "type":
    case "hover":
    case "select_option":
    case "press_key":
    case "scroll":
      return await toContent(command, params);

    case "wait": {
      const ms = Math.max(0, Number(params.seconds || 0) * 1000);
      await new Promise((r) => setTimeout(r, ms));
      return {};
    }

    /* ---------------------------- network --------------------------- */
    case "get_network": {
      const tab = await resolveTab(params);
      let arr = (networkByTab.get(tab.id) || []).slice();
      if (params.filter) {
        const q = String(params.filter).toLowerCase();
        arr = arr.filter(
          (e) =>
            e.url.toLowerCase().includes(q) ||
            (e.method || "").toLowerCase() === q ||
            (e.type || "").toLowerCase() === q
        );
      }
      const limit = Number(params.limit) || 50;
      arr = arr.slice(-limit);
      const includeBody = params.include_body !== false;
      return {
        requests: arr.map((e) => ({
          method: e.method,
          url: e.url,
          type: e.type,
          status: e.status,
          contentType: e.contentType,
          error: e.error,
          requestBody: includeBody ? e.requestBody : undefined,
          responseBody: includeBody
            ? e.responseBody
              ? String(e.responseBody).slice(0, 50000)
              : null
            : undefined,
        })),
      };
    }
    case "clear_network": {
      const tab = await resolveTab(params);
      networkByTab.set(tab.id, []);
      return { ok: true };
    }

    /* ----------------------------- tabs ----------------------------- */
    case "list_tabs": {
      const query = params.all_windows === false ? { currentWindow: true } : {};
      const tabs = await chrome.tabs.query(query);
      return { tabs: tabs.map(tabInfo) };
    }
    case "select_tab": {
      const tab = await resolveTab(params);
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return tabInfo(await chrome.tabs.get(tab.id));
    }
    case "new_tab": {
      const tab = await chrome.tabs.create({ url: params.url || undefined });
      if (params.url) await waitForLoad(tab.id);
      return tabInfo(await chrome.tabs.get(tab.id));
    }
    case "close_tab": {
      const tab = await resolveTab(params);
      await chrome.tabs.remove(tab.id);
      return {};
    }

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

/* ======================= popup <-> background ========================= */

// Chrome: reply via sendResponse and `return true` (no Promise return).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.__netbody) {
    // Attach a response body (from injected.js) to the newest matching entry.
    const tabId = sender && sender.tab ? sender.tab.id : -1;
    const arr = networkByTab.get(tabId) || [];
    for (let i = arr.length - 1; i >= 0; i--) {
      const e = arr[i];
      if (
        e.responseBody == null &&
        e.method === msg.method &&
        e.url === msg.url
      ) {
        e.responseBody = msg.body;
        if (e.status == null) e.status = msg.status;
        break;
      }
    }
    return false;
  }
  if (!msg || !msg.__popup) return false;
  let p;
  if (msg.type === "getStatus") {
    p = ready.then(() => ({ connected, wsUrl, enabled }));
  } else if (msg.type === "setEnabled") {
    p = ready.then(() => setEnabled(msg.enabled)).then(() => ({ ok: true, enabled }));
  } else if (msg.type === "setUrl") {
    wsUrl = msg.url || DEFAULT_WS_URL;
    p = chrome.storage.local.set({ wsUrl }).then(() => {
      disconnect();
      if (enabled) connect();
      return { ok: true };
    });
  } else if (msg.type === "reconnect") {
    disconnect();
    if (enabled) connect();
    p = Promise.resolve({ ok: true });
  } else {
    return false;
  }
  p.then(sendResponse);
  return true;
});

/* ============ service-worker keepalive (MV3) ============ */
// An MV3 service worker is suspended when idle. WebSocket traffic keeps it
// alive on Chrome 116+, so send a tiny keepalive frame (the bridge ignores
// messages without an `id`); an alarm revives the worker + reconnects if it
// was still killed.
setInterval(() => send({ keepalive: Date.now() }), 20000);
chrome.alarms.create("fbmcp-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "fbmcp-keepalive") ready.then(() => enabled && connect());
});

/* boot */
const ready = loadConfig().then(() => {
  if (enabled) connect();
  else setConnected(false);
});
