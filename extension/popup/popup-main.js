(() => {
  const $ = (id) => document.getElementById(id);

  const el = {
    scanPage: $("scanPage-Id"),
    clickMode: $("clickMode-Id"),
    status: $("status-Id"),
    lang: $("language-Id"),
    serverUrl: $("serverUrl-Id"),
    saveServer: $("saveServerUrl-Id")
  };

  const DEFAULT_SERVER_URL = "http://localhost:3000";

  const storage = {
    get(k, fallback) {
      const v = localStorage.getItem(k);
      return v == null ? fallback : v;
    },
    set(k, v) {
      localStorage.setItem(k, v);
    }
  };

  function setStatus(t) {
    if (el.status) el.status.textContent = t;
  }

  function busy(b) {
    if (el.scanPage) el.scanPage.disabled = b;
    if (el.clickMode) el.clickMode.disabled = b;
  }

  function getServerUrl() {
    return storage.get("ocrServerUrl", DEFAULT_SERVER_URL);
  }

  function getLang() {
    const v = el.lang?.value || "en";
    return String(v).trim() || "en";
  }

  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(resp);
      });
    });
  }

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab found.");
    if (tab.url && /^(chrome|edge|about|view-source|chrome-extension):/.test(tab.url)) {
      throw new Error("Cannot run on this page. Open a normal web page.");
    }
    return tab;
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (el.serverUrl) el.serverUrl.value = getServerUrl();
    if (el.lang) el.lang.value = storage.get("targetLang", "en");
    el.lang?.addEventListener("change", () => storage.set("targetLang", el.lang.value));

    el.saveServer?.addEventListener("click", () => {
      const v = el.serverUrl?.value?.trim();
      if (!v) return alert("Please enter a valid server URL");
      storage.set("ocrServerUrl", v);
      setStatus("Server URL saved.");
    });

    el.scanPage?.addEventListener("click", async () => {
      busy(true);
      setStatus("Scanning all images on page…");
      try {
        const tab = await getActiveTab();
        const resp = await sendMessage({
          type: "inject-scanner",
          tabId: tab.id,
          serverUrl: getServerUrl(),
          target_lang: getLang()
        });
        if (!resp?.ok) throw new Error(resp?.error || "Scanner injection failed");
        setStatus("Scanner running. Check the page for overlays.");
      } catch (e) {
        setStatus(e?.message || String(e));
      } finally {
        busy(false);
      }
    });

    el.clickMode?.addEventListener("click", async () => {
      busy(true);
      setStatus("Activating click-to-translate…");
      try {
        const tab = await getActiveTab();
        const resp = await sendMessage({
          type: "inject-clicker",
          tabId: tab.id,
          serverUrl: getServerUrl(),
          target_lang: getLang()
        });
        if (!resp?.ok) throw new Error(resp?.error || "Clicker injection failed");
        setStatus("Click mode active. Click any highlighted image on the page.");
      } catch (e) {
        setStatus(e?.message || String(e));
      } finally {
        busy(false);
      }
    });

    setStatus("Ready.");
  });
})();
