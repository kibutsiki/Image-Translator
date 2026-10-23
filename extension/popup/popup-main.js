(() => {
  const $ = (id) => document.getElementById(id);
  const el = {
    scanPage: $("scanPage-Id"),
    clickMode: $("clickMode-Id"),
    status: $("status-Id"),
    lang: $("language-Id"),
    serverUrl: $("serverUrl-Id"),
    apiToken: $("apiToken-Id"),
    save: $("saveServer-Id"),
    test: $("testServer-Id"),
    serverStatus: $("serverStatus-Id")
  };

  const DEFAULT_SERVER_URL = "http://localhost:3000";
  const setStatus = (t) => { el.status.textContent = t; };
  const setServerStatus = (t) => { el.serverStatus.textContent = t; };

  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(resp);
      });
    });
  }

  function normalizeUrl(raw) {
    const value = String(raw || "").trim().replace(/\/+$/, "");
    if (!value) return DEFAULT_SERVER_URL;
    try {
      const u = new URL(value);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
      return value;
    } catch {
      return null;
    }
  }

  async function saveServerSettings() {
    const serverUrl = normalizeUrl(el.serverUrl.value);
    if (!serverUrl) {
      setServerStatus("That doesn't look like a valid URL. Example: http://localhost:3000");
      return false;
    }
    await chrome.storage.local.set({ serverUrl, apiToken: el.apiToken.value.trim() });
    el.serverUrl.value = serverUrl;
    if (el.apiToken.value.trim() && el.status.textContent.startsWith("Add your")) setStatus("Ready.");
    return true;
  }

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab found.");
    if (tab.url && /^(chrome|edge|about|view-source|chrome-extension|https:\/\/chromewebstore\.google\.com):/.test(tab.url)) {
      throw new Error("Can't run on this page. Open a normal web page first.");
    }
    return tab;
  }

  function setBusy(busy) {
    el.scanPage.disabled = busy;
    el.clickMode.disabled = busy;
  }

  async function run(mode, startMsg, doneMsg) {
    setBusy(true);
    setStatus(startMsg);
    try {
      const { apiToken } = await chrome.storage.local.get("apiToken");
      if (!apiToken) throw new Error("Add your API token under Server first, then press Save.");
      const tab = await getActiveTab();
      const resp = await sendMessage({ type: "inject", mode, tabId: tab.id });
      if (!resp?.ok) throw new Error(resp?.error || "Could not start on this page.");
      setStatus(doneMsg);
    } catch (e) {
      setStatus(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const stored = await chrome.storage.local.get(["serverUrl", "apiToken", "targetLang"]);
    el.serverUrl.value = stored.serverUrl || DEFAULT_SERVER_URL;
    el.apiToken.value = stored.apiToken || "";
    el.lang.value = stored.targetLang || "en";
    if (!stored.apiToken) setStatus("Add your server URL and API token below to get started.");

    el.lang.addEventListener("change", () => chrome.storage.local.set({ targetLang: el.lang.value }));

    el.save.addEventListener("click", async () => {
      if (await saveServerSettings()) setServerStatus("Saved.");
    });

    el.test.addEventListener("click", async () => {
      if (!(await saveServerSettings())) return;
      el.test.disabled = true;
      setServerStatus("Testing…");
      try {
        const resp = await sendMessage({ type: "test-connection" });
        setServerStatus(resp?.ok ? resp.message : resp?.error || "Test failed.");
      } catch (e) {
        setServerStatus(e?.message || String(e));
      } finally {
        el.test.disabled = false;
      }
    });

    el.scanPage.addEventListener("click", () =>
      run("scan", "Scanning images on the page…", "Scan started. Progress shows on the page.")
    );
    el.clickMode.addEventListener("click", () =>
      run("click", "Turning on click mode…", "Click mode on. Click an outlined image on the page.")
    );
  });
})();
