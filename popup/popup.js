// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 No Twitch Ads contributors. See LICENSE and NOTICE.md.

(() => {
  const api = typeof browser !== "undefined" ? browser : chrome;
  const DEFAULTS = { enabled: true, autoClaimPoints: true };

  const $ = (id) => document.getElementById(id);
  let settings = { ...DEFAULTS };

  function render(tabInfo) {
    $("enabled").checked = !!settings.enabled;
    $("autoClaimPoints").checked = !!settings.autoClaimPoints;
    $("breaks").textContent = String((tabInfo && tabInfo.breaks) || 0);
    $("points").textContent = String((tabInfo && tabInfo.pointsClaimed) || 0);
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
    render(await queryTab());
  }

  async function init() {
    try {
      $("version").textContent = "v" + api.runtime.getManifest().version;
    } catch (_) {}
    try {
      settings = { ...DEFAULTS, ...(await api.storage.sync.get(DEFAULTS)) };
    } catch (_) {}

    $("enabled").addEventListener("change", (e) => save({ enabled: e.target.checked }));
    $("autoClaimPoints").addEventListener("change", (e) => save({ autoClaimPoints: e.target.checked }));

    await refresh();
    setInterval(refresh, 1500);
  }

  init();
})();
