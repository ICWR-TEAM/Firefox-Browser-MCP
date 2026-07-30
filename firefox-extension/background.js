/* Firefox Browser MCP — background script (MV2, persistent).
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
    const cfg = await browser.storage.local.get(["wsUrl", "enabled"]);
    if (cfg.wsUrl) wsUrl = cfg.wsUrl;
    enabled = cfg.enabled !== false; // default: enabled
  } catch (e) {
    /* ignore */
  }
}

function setConnected(state) {
  connected = state;
  browser.storage.local.set({ connected: state }).catch(() => {});
  const color = state ? "#2e7d32" : "#9e9e9e";
  const text = state ? "on" : "";
  try {
    browser.browserAction.setBadgeBackgroundColor({ color });
    browser.browserAction.setBadgeText({ text });
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
  await browser.storage.local.set({ enabled }).catch(() => {});
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
  try {
    socket = new WebSocket(wsUrl);
  } catch (e) {
    scheduleReconnect();
    return;
  }

  socket.onopen = () => setConnected(true);
  socket.onclose = () => {
    setConnected(false);
    socket = null;
    if (enabled) scheduleReconnect();
  };
  socket.onerror = () => {
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
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
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
      return await browser.tabs.get(asNum);
    } catch (e) {
      throw new Error(`No tab with id ${asNum}.`);
    }
  }
  const all = await browser.tabs.query({});
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
    await browser.tabs.sendMessage(tabId, { action: "ping" });
  } catch (e) {
    await browser.tabs.executeScript(tabId, { file: "content.js" });
  }
}

async function toContent(action, params) {
  const tab = await resolveTab(params);
  await ensureContentScript(tab.id);
  const resp = await browser.tabs.sendMessage(tab.id, { action, params });
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
      browser.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === "complete") finish();
    };
    browser.tabs.onUpdated.addListener(listener);
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

if (browser.webRequest) {
  browser.webRequest.onBeforeRequest.addListener(
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

      // Capture response bodies for API-like requests (Firefox only).
      if (details.type === "xmlhttprequest" && browser.webRequest.filterResponseData) {
        try {
          const filter = browser.webRequest.filterResponseData(details.requestId);
          const chunks = [];
          let size = 0;
          filter.ondata = (e) => {
            chunks.push(e.data);
            size += e.data.byteLength;
            filter.write(e.data);
          };
          filter.onstop = () => {
            try {
              filter.disconnect();
            } catch (e) {
              /* ignore */
            }
            try {
              if (size <= MAX_BODY) {
                const dec = new TextDecoder("utf-8");
                let t = "";
                for (const c of chunks) t += dec.decode(c, { stream: true });
                t += dec.decode();
                entry.responseBody = t;
              } else {
                entry.responseBody = `[response body ${size} bytes, not captured]`;
              }
            } catch (err) {
              entry.responseBody = "[binary or undecodable body]";
            }
          };
          filter.onerror = () => {};
        } catch (e) {
          /* filterResponseData unavailable */
        }
      }
      return {};
    },
    { urls: ["<all_urls>"] },
    ["requestBody"]
  );

  browser.webRequest.onHeadersReceived.addListener(
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

  browser.webRequest.onCompleted.addListener(
    (d) => {
      const e = entryByRequest.get(d.requestId);
      if (e) {
        e.status = d.statusCode;
        e.endTime = d.timeStamp;
      }
    },
    { urls: ["<all_urls>"] }
  );

  browser.webRequest.onErrorOccurred.addListener(
    (d) => {
      const e = entryByRequest.get(d.requestId);
      if (e) e.error = d.error;
    },
    { urls: ["<all_urls>"] }
  );
}

browser.tabs.onRemoved.addListener((tabId) => networkByTab.delete(tabId));

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
      await browser.tabs.update(tab.id, { url: params.url });
      await waitForLoad(tab.id);
      return tabInfo(await browser.tabs.get(tab.id));
    }
    case "go_back": {
      const tab = await resolveTab(params);
      await browser.tabs.goBack(tab.id);
      return {};
    }
    case "go_forward": {
      const tab = await resolveTab(params);
      await browser.tabs.goForward(tab.id);
      return {};
    }
    case "reload": {
      const tab = await resolveTab(params);
      await browser.tabs.reload(tab.id);
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
        await browser.tabs.update(tab.id, { active: true });
        await browser.windows.update(tab.windowId, { focused: true });
        await new Promise((r) => setTimeout(r, 250));
      }
      const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, {
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
      const tabs = await browser.tabs.query(query);
      return { tabs: tabs.map(tabInfo) };
    }
    case "select_tab": {
      const tab = await resolveTab(params);
      await browser.tabs.update(tab.id, { active: true });
      await browser.windows.update(tab.windowId, { focused: true });
      return tabInfo(await browser.tabs.get(tab.id));
    }
    case "new_tab": {
      const tab = await browser.tabs.create({ url: params.url || undefined });
      if (params.url) await waitForLoad(tab.id);
      return tabInfo(await browser.tabs.get(tab.id));
    }
    case "close_tab": {
      const tab = await resolveTab(params);
      await browser.tabs.remove(tab.id);
      return {};
    }

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

/* ======================= popup <-> background ========================= */

browser.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.__popup) return undefined;
  if (msg.type === "getStatus") {
    return Promise.resolve({ connected, wsUrl, enabled });
  }
  if (msg.type === "setEnabled") {
    return setEnabled(msg.enabled).then(() => ({ ok: true, enabled }));
  }
  if (msg.type === "setUrl") {
    wsUrl = msg.url || DEFAULT_WS_URL;
    return browser.storage.local.set({ wsUrl }).then(() => {
      disconnect();
      if (enabled) connect();
      return { ok: true };
    });
  }
  if (msg.type === "reconnect") {
    disconnect();
    if (enabled) connect();
    return Promise.resolve({ ok: true });
  }
  return undefined;
});

/* boot */
loadConfig().then(() => {
  if (enabled) connect();
  else setConnected(false);
});
