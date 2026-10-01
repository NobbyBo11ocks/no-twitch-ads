// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 No Twitch Ads contributors. See LICENSE and NOTICE.md.

(() => {
  const api = typeof browser !== "undefined" ? browser : chrome;
  const DEFAULTS = { enabled: true, showBanner: true, backupMode: "360p", forcePopoutToken: true, whitelist: [], autoClaimPoints: true };

  const $ = (id) => document.getElementById(id);
  let settings = { ...DEFAULTS };
  let channel = null;
  let tabInfo = null;

  function setStatus(state, title, detail) {
    $("status").dataset.state = state;
    $("status-title").textContent = title;
    $("status-detail").textContent = detail || "";
  }

  function render() {
    $("enabled").checked = !!settings.enabled;
    $("forcePopoutToken").checked = !!settings.forcePopoutToken;
    $("showBanner").checked = !!settings.showBanner;
    $("autoClaimPoints").checked = !!settings.autoClaimPoints;
    for (const btn of $("backupMode").querySelectorAll("button")) {
      btn.setAttribute("aria-checked", String(btn.dataset.value === (settings.backupMode || "360p")));
    }
    const wl = settings.whitelist || [];
    const btn = $("whitelist-toggle");
    $("channel").textContent = channel || "not on a stream";
    $("breaks").textContent = String((tabInfo && tabInfo.breaks) || 0);
    $("points").textContent = String((tabInfo && tabInfo.pointsClaimed) || 0);
    btn.disabled = !channel;
    btn.textContent = channel && wl.includes(channel) ? "Skip ads here again" : "Allow ads here";
  }

  async function save(patch) {
    settings = { ...settings, ...patch };
    render();
    try {
      await api.storage.sync.set(patch);
    } catch (_) {}
  }

  async function queryTab() {
    let tabs = [];
    try {
      tabs = await api.tabs.query({ active: true, currentWindow: true });
    } catch (_) {}
    const tab = tabs[0];
    if (!tab) return null;
    try {
      return await api.tabs.sendMessage(tab.id, { type: "nta:get-status" });
    } catch (_) {
      return null; // not a Twitch tab (no content script there)
    }
  }

  async function refresh() {
    tabInfo = await queryTab();
    channel = tabInfo && tabInfo.channel ? tabInfo.channel : null;
    render();
    const wl = settings.whitelist || [];
    const s = (tabInfo && tabInfo.status) || {};
    if (!settings.enabled) {
      setStatus("off", "Ad skipping is off", "Flip the switch to start skipping breaks.");
    } else if (!tabInfo) {
      setStatus("na", "Not a Twitch tab", "Open a live stream to see what is happening.");
    } else if (channel && wl.includes(channel)) {
      setStatus("off", "Ads allowed on this channel", "You chose to let " + channel + " run ads for you.");
    } else if (s.hasAds && s.stripping) {
      setStatus("strip", "Ad break: blanking segments", "Every backup session had the ad. Video pauses until the break ends.");
    } else if (s.hasAds) {
      setStatus("ad", "Ad break: skipping" + (s.midroll ? " midroll" : ""), "Playing the " + (s.backup || "backup") + " session instead of the ad.");
    } else if (channel) {
      setStatus("idle", "Watching for ad breaks", "Active on " + channel + ". Nothing to skip right now.");
    } else {
      setStatus("na", "No live stream here", "Status appears once a stream is playing.");
    }
  }

  async function init() {
    try {
      $("version").textContent = "v" + api.runtime.getManifest().version;
    } catch (_) {}
    try {
      settings = { ...DEFAULTS, ...(await api.storage.sync.get(DEFAULTS)) };
    } catch (_) {}

    $("enabled").addEventListener("change", (e) => save({ enabled: e.target.checked }).then(refresh));
    $("forcePopoutToken").addEventListener("change", (e) => save({ forcePopoutToken: e.target.checked }));
    $("showBanner").addEventListener("change", (e) => save({ showBanner: e.target.checked }));
    $("autoClaimPoints").addEventListener("change", (e) => save({ autoClaimPoints: e.target.checked }));
    $("backupMode").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-value]");
      if (btn) save({ backupMode: btn.dataset.value });
    });
    $("whitelist-toggle").addEventListener("click", async () => {
      if (!channel) return;
      const wl = new Set(settings.whitelist || []);
      if (wl.has(channel)) wl.delete(channel);
      else wl.add(channel);
      await save({ whitelist: [...wl] });
      refresh();
    });

    await refresh();
    setInterval(refresh, 1500);
  }

  init();
})();
