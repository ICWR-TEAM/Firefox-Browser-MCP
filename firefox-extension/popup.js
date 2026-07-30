const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const urlInput = document.getElementById("url");

async function refresh() {
  try {
    const res = await browser.runtime.sendMessage({ __popup: true, type: "getStatus" });
    if (res.connected) {
      dot.classList.add("on");
      statusText.textContent = "Connected";
    } else {
      dot.classList.remove("on");
      statusText.textContent = "Disconnected";
    }
    if (!urlInput.value) urlInput.value = res.wsUrl || "ws://127.0.0.1:9010";
  } catch (e) {
    statusText.textContent = "Error";
  }
}

document.getElementById("save").addEventListener("click", async () => {
  const url = urlInput.value.trim() || "ws://127.0.0.1:9010";
  await browser.runtime.sendMessage({ __popup: true, type: "setUrl", url });
  setTimeout(refresh, 500);
});

document.getElementById("reconnect").addEventListener("click", async () => {
  await browser.runtime.sendMessage({ __popup: true, type: "reconnect" });
  setTimeout(refresh, 500);
});

refresh();
setInterval(refresh, 1500);
