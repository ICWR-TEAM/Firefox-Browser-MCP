/* Runs in the page's own JS context (MAIN world content script) to:
 *  1. capture console output, and
 *  2. capture XHR/fetch response bodies (Chrome has no filterResponseData),
 * forwarding both to the isolated content script via window.postMessage. */
(function () {
  if (window.__fbmcpConsoleHooked) return;
  window.__fbmcpConsoleHooked = true;

  const MAX_BODY = 512 * 1024;
  const levels = ["log", "info", "warn", "error", "debug"];
  const original = {};

  function serialize(args) {
    return Array.prototype.map
      .call(args, (a) => {
        try {
          if (typeof a === "string") return a;
          return JSON.stringify(a);
        } catch (e) {
          return String(a);
        }
      })
      .join(" ");
  }

  levels.forEach((level) => {
    original[level] = console[level];
    console[level] = function () {
      try {
        window.postMessage(
          { __fbmcp: "console", level, text: serialize(arguments) },
          "*"
        );
      } catch (e) {
        /* ignore */
      }
      return original[level].apply(console, arguments);
    };
  });

  function postBody(url, method, status, body) {
    try {
      if (typeof body !== "string") return;
      if (body.length > MAX_BODY) {
        body = `[response body ${body.length} chars, not captured]`;
      }
      window.postMessage(
        { __fbmcp: "netbody", url: String(url), method, status, body },
        "*"
      );
    } catch (e) {
      /* ignore */
    }
  }

  /* ---- fetch ---- */
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      const method = String(
        (init && init.method) || (input && input.method) || "GET"
      ).toUpperCase();
      const p = origFetch.apply(this, arguments);
      p.then((res) => {
        try {
          res
            .clone()
            .text()
            .then((t) => postBody(res.url || (input && input.url) || input, method, res.status, t))
            .catch(() => {});
        } catch (e) {
          /* ignore */
        }
      }).catch(() => {});
      return p;
    };
  }

  /* ---- XMLHttpRequest ---- */
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    XHR.prototype.open = function (method, url) {
      this.__fbmcpMethod = String(method || "GET").toUpperCase();
      this.__fbmcpUrl = url;
      this.addEventListener("loadend", () => {
        try {
          if (this.responseType === "" || this.responseType === "text") {
            postBody(this.responseURL || this.__fbmcpUrl, this.__fbmcpMethod, this.status, this.responseText);
          } else if (this.responseType === "json" && this.response != null) {
            postBody(this.responseURL || this.__fbmcpUrl, this.__fbmcpMethod, this.status, JSON.stringify(this.response));
          }
        } catch (e) {
          /* ignore */
        }
      });
      return origOpen.apply(this, arguments);
    };
  }
})();
