/* Runs in the page's own JS context to capture console output and forward it
 * to the content script via window.postMessage. */
(function () {
  if (window.__fbmcpConsoleHooked) return;
  window.__fbmcpConsoleHooked = true;

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
})();
