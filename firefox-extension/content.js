/* Firefox Browser MCP — content script.
 * Runs in every page; handles DOM inspection, querying and interaction
 * requests coming from the background script. Elements can be targeted by a
 * stable `ref` (from snapshot/query) or by any CSS `selector`.
 */

(function () {
  if (window.__fbmcpContentLoaded) return;
  window.__fbmcpContentLoaded = true;

  const REF_ATTR = "data-fbmcp-ref";
  let refCounter = 0;
  const refMap = new Map(); // ref -> element

  /* ------------------------- console capture ------------------------- */
  const consoleLogs = [];
  const MAX_LOGS = 500;

  function pushLog(level, text) {
    consoleLogs.push({ level, text, ts: Date.now() });
    if (consoleLogs.length > MAX_LOGS) consoleLogs.shift();
  }

  window.addEventListener("error", (e) => {
    pushLog("error", e.message + (e.filename ? ` (${e.filename}:${e.lineno})` : ""));
  });
  window.addEventListener("unhandledrejection", (e) => {
    pushLog("error", "Unhandled promise rejection: " + String(e.reason));
  });
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (d && d.__fbmcp === "console") pushLog(d.level, d.text);
  });

  try {
    const s = document.createElement("script");
    s.src = browser.runtime.getURL("injected.js");
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {
    /* ignore */
  }

  /* ----------------------------- helpers ----------------------------- */

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function assignRef(el) {
    let ref = el.getAttribute(REF_ATTR);
    if (ref && refMap.get(ref) === el) return ref;
    ref = "e" + ++refCounter;
    el.setAttribute(REF_ATTR, ref);
    refMap.set(ref, el);
    return ref;
  }

  function resolveRef(ref) {
    if (!ref) return null;
    let el = refMap.get(ref);
    if (el && document.contains(el)) return el;
    el = document.querySelector(`[${REF_ATTR}="${CSS.escape(ref)}"]`);
    if (el) {
      refMap.set(ref, el);
      return el;
    }
    return null;
  }

  function resolveTarget(p) {
    if (p.ref) {
      const el = resolveRef(p.ref);
      if (!el) throw new Error(`Element ref '${p.ref}' not found. Re-run browser_snapshot/browser_query.`);
      return el;
    }
    if (p.selector) {
      const el = document.querySelector(p.selector);
      if (!el) throw new Error(`No element matches selector '${p.selector}'.`);
      return el;
    }
    throw new Error("Provide a 'ref' or a 'selector'.");
  }

  function attrsOf(el) {
    const out = {};
    for (const a of el.attributes) {
      if (a.name === REF_ATTR) continue;
      out[a.name] = a.value;
    }
    return out;
  }

  function accessibleName(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    if (el.getAttribute("placeholder")) return el.getAttribute("placeholder").trim();
    if (el.getAttribute("alt")) return el.getAttribute("alt").trim();
    if (el.getAttribute("title")) return el.getAttribute("title").trim();
    if (el.tagName === "INPUT" && el.getAttribute("value")) {
      return el.getAttribute("value").trim();
    }
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const parts = labelledby
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((n) => n.textContent.trim());
      if (parts.length) return parts.join(" ");
    }
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return lbl.textContent.trim();
    }
    return (el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    const map = {
      a: "link", button: "button", select: "combobox", textarea: "textbox",
      img: "image", h1: "heading", h2: "heading", h3: "heading",
      h4: "heading", h5: "heading", h6: "heading", nav: "navigation", form: "form",
    };
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset"].includes(t)) return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      return "textbox";
    }
    return map[tag] || tag;
  }

  const INTERACTIVE = new Set(["a", "button", "input", "select", "textarea", "summary", "option"]);

  function isInteresting(el) {
    const tag = el.tagName.toLowerCase();
    if (INTERACTIVE.has(tag)) return true;
    if (el.hasAttribute("role")) return true;
    if (el.hasAttribute("onclick")) return true;
    if (el.getAttribute("tabindex") && el.getAttribute("tabindex") !== "-1") return true;
    if (/^h[1-6]$/.test(tag)) return true;
    return false;
  }

  function snapshot() {
    const lines = [];
    const all = document.body ? document.body.querySelectorAll("*") : [];
    let count = 0;
    for (const el of all) {
      if (count > 1500) break;
      if (!isInteresting(el) || !isVisible(el)) continue;
      const role = roleOf(el);
      let name = accessibleName(el);
      if (name.length > 120) name = name.slice(0, 117) + "...";
      const ref = assignRef(el);
      const extra = [];
      if (el.disabled) extra.push("disabled");
      if (el.getAttribute("aria-expanded")) extra.push(`expanded=${el.getAttribute("aria-expanded")}`);
      if (el.value && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
        extra.push(`value="${String(el.value).slice(0, 40)}"`);
      }
      const suffix = extra.length ? ` (${extra.join(", ")})` : "";
      const label = name ? ` "${name}"` : "";
      lines.push(`- ${role}${label} [ref=${ref}]${suffix}`);
      count++;
    }
    const header = `# ${document.title}\n${location.href}\n`;
    return header + (lines.length ? lines.join("\n") : "(no interactive elements found)");
  }

  function elementSummary(el, includeHtml) {
    return {
      ref: assignRef(el),
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      name: accessibleName(el).slice(0, 120),
      text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300),
      value: el.value !== undefined ? String(el.value).slice(0, 200) : undefined,
      visible: isVisible(el),
      attributes: attrsOf(el),
      html: includeHtml ? el.outerHTML.slice(0, 6000) : undefined,
    };
  }

  /* ----------------------- interaction actions ----------------------- */

  function simulateClick(el, double) {
    el.scrollIntoView({ block: "center", inline: "center" });
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent("mouseover", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    if (double) el.dispatchEvent(new MouseEvent("dblclick", opts));
    if (typeof el.focus === "function") el.focus();
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, value);
    else el.value = value;
  }

  function typeInto(el, text, clear, submit) {
    el.scrollIntoView({ block: "center" });
    if (typeof el.focus === "function") el.focus();
    if (el.isContentEditable) {
      if (clear) el.textContent = "";
      el.textContent += text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } else {
      const newVal = clear ? text : (el.value || "") + text;
      setNativeValue(el, newVal);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (submit) {
      const kopts = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 };
      el.dispatchEvent(new KeyboardEvent("keydown", kopts));
      el.dispatchEvent(new KeyboardEvent("keyup", kopts));
      if (el.form && typeof el.form.requestSubmit === "function") el.form.requestSubmit();
      else if (el.form) el.form.submit();
    }
  }

  function selectOption(el, value) {
    if (el.tagName !== "SELECT") throw new Error("Element is not a <select>.");
    let matched = false;
    for (const opt of el.options) {
      if (opt.value === value || opt.textContent.trim() === value) {
        el.value = opt.value;
        matched = true;
        break;
      }
    }
    if (!matched) throw new Error(`No option matching '${value}'.`);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function pressKey(key) {
    const target = document.activeElement || document.body;
    const opts = { bubbles: true, cancelable: true, key, code: key };
    target.dispatchEvent(new KeyboardEvent("keydown", opts));
    target.dispatchEvent(new KeyboardEvent("keypress", opts));
    target.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  // Execute arbitrary JS in the PAGE's own context (main world) by injecting a
  // <script> element and reading the JSON-serialized result back via
  // postMessage. This intentionally avoids eval()/Function(), so the extension
  // ships no dynamic-code-evaluation primitives. Note: pages with a strict CSP
  // (script-src without 'unsafe-inline') may block the injected script.
  function runInPage(userScript) {
    return new Promise((resolve) => {
      const marker =
        "fbmcp_eval_" + Date.now() + "_" + Math.random().toString(36).slice(2);
      const idJson = JSON.stringify(marker);
      const wrapper =
        "(async () => {\n" +
        "  try {\n" +
        "    const __r = await (async () => {\n" + userScript + "\n})();\n" +
        "    let __s; try { __s = JSON.stringify(__r === undefined ? null : __r); }\n" +
        "    catch (e) { __s = JSON.stringify(String(__r)); }\n" +
        "    window.postMessage({ __fbmcp: 'evalResult', id: " + idJson + ", ok: true, value: __s }, '*');\n" +
        "  } catch (e) {\n" +
        "    window.postMessage({ __fbmcp: 'evalResult', id: " + idJson + ", ok: false, error: String((e && e.message) || e) }, '*');\n" +
        "  }\n" +
        "})();";

      let timer;
      const handler = (event) => {
        if (event.source !== window) return;
        const d = event.data;
        if (!d || d.__fbmcp !== "evalResult" || d.id !== marker) return;
        window.removeEventListener("message", handler);
        clearTimeout(timer);
        if (d.ok) {
          let val;
          try {
            val = JSON.parse(d.value);
          } catch (e) {
            val = d.value;
          }
          resolve({ result: val });
        } else {
          resolve({ error: "eval error: " + d.error });
        }
      };
      window.addEventListener("message", handler);

      try {
        const s = document.createElement("script");
        s.textContent = wrapper;
        (document.head || document.documentElement).appendChild(s);
        s.remove();
      } catch (e) {
        window.removeEventListener("message", handler);
        resolve({ error: "eval injection failed: " + String((e && e.message) || e) });
        return;
      }

      timer = setTimeout(() => {
        window.removeEventListener("message", handler);
        resolve({
          error:
            "eval produced no result (the page may block inline scripts via CSP, " +
            "or the script never resolved).",
        });
      }, 15000);
    });
  }

  /* --------------------------- dispatcher ---------------------------- */

  browser.runtime.onMessage.addListener((msg) => {
    const { action, params } = msg || {};
    const p = params || {};
    try {
      switch (action) {
        case "ping":
          return Promise.resolve({ ok: true });

        case "snapshot":
          return Promise.resolve({ snapshot: snapshot() });

        case "get_text": {
          const el = p.ref || p.selector ? resolveTarget(p) : document.body;
          return Promise.resolve({ text: (el.innerText || el.textContent || "").trim() });
        }
        case "get_html": {
          const el = p.ref || p.selector ? resolveTarget(p) : document.documentElement;
          return Promise.resolve({ html: el.outerHTML });
        }
        case "get_attribute": {
          const el = resolveTarget(p);
          if (p.name) return Promise.resolve({ value: el.getAttribute(p.name) });
          return Promise.resolve({ attributes: attrsOf(el) });
        }
        case "query": {
          if (!p.selector) throw new Error("query requires a 'selector'.");
          const nodes =
            p.all === false
              ? [document.querySelector(p.selector)].filter(Boolean)
              : Array.from(document.querySelectorAll(p.selector));
          const limit = Number(p.limit) || 50;
          const items = nodes.slice(0, limit).map((el) => elementSummary(el, !!p.include_html));
          return Promise.resolve({ count: nodes.length, elements: items });
        }
        case "get_console_logs":
          return Promise.resolve({ logs: consoleLogs.slice(-200) });

        case "eval":
          return runInPage(String(p.script || ""));

        case "click":
          simulateClick(resolveTarget(p), !!p.double);
          return Promise.resolve({ ok: true });
        case "type":
          typeInto(resolveTarget(p), p.text || "", p.clear !== false, !!p.submit);
          return Promise.resolve({ ok: true });
        case "hover": {
          const el = resolveTarget(p);
          el.scrollIntoView({ block: "center" });
          el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, view: window }));
          el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, view: window }));
          return Promise.resolve({ ok: true });
        }
        case "select_option":
          selectOption(resolveTarget(p), p.value);
          return Promise.resolve({ ok: true });
        case "press_key":
          pressKey(p.key);
          return Promise.resolve({ ok: true });
        case "scroll": {
          if (p.ref || p.selector) {
            resolveTarget(p).scrollIntoView({ block: "center", behavior: "instant" });
          } else {
            window.scrollBy(Number(p.x) || 0, Number(p.y) || 0);
          }
          return Promise.resolve({ ok: true });
        }

        default:
          return Promise.resolve({ error: `Unknown action: ${action}` });
      }
    } catch (err) {
      return Promise.resolve({ error: String((err && err.message) || err) });
    }
  });
})();
