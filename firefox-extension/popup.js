const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const urlInput = document.getElementById("url");
const toggle = document.getElementById("toggle");
const toggleLabel = document.getElementById("toggleLabel");

let urlDirty = false;
urlInput.addEventListener("input", () => {
  urlDirty = true;
});

async function refresh() {
  try {
    const res = await browser.runtime.sendMessage({ __popup: true, type: "getStatus" });

    toggle.checked = !!res.enabled;
    toggleLabel.textContent = res.enabled ? "Enabled" : "Disabled";

    if (!res.enabled) {
      dot.classList.remove("on");
      statusText.textContent = "Disabled";
    } else if (res.connected) {
      dot.classList.add("on");
      statusText.textContent = "Connected";
    } else {
      dot.classList.remove("on");
      statusText.textContent = "Connecting…";
    }

    if (!urlDirty && !document.activeElement.isSameNode(urlInput)) {
      urlInput.value = res.wsUrl || "ws://127.0.0.1:9010";
    }
  } catch (e) {
    statusText.textContent = "Error";
  }
}

toggle.addEventListener("change", async () => {
  await browser.runtime.sendMessage({
    __popup: true,
    type: "setEnabled",
    enabled: toggle.checked,
  });
  setTimeout(refresh, 300);
});

document.getElementById("save").addEventListener("click", async () => {
  const url = urlInput.value.trim() || "ws://127.0.0.1:9010";
  await browser.runtime.sendMessage({ __popup: true, type: "setUrl", url });
  urlDirty = false;
  setTimeout(refresh, 500);
});

document.getElementById("reconnect").addEventListener("click", async () => {
  await browser.runtime.sendMessage({ __popup: true, type: "reconnect" });
  setTimeout(refresh, 500);
});

refresh();
setInterval(refresh, 1500);
