// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 No Twitch Ads contributors. See LICENSE and NOTICE.md.

(() => {
  const api = typeof browser !== "undefined" ? browser : chrome;
  const DEFAULTS = { enabled: true, autoClaimPoints: true };
  const STATS_DEFAULTS = { adsSkipped: 0, pointsClaimed: 0, timeSavedMs: 0, blanked: 0, leaks: 0 };

  const $ = (id) => document.getElementById(id);
  let settings = { ...DEFAULTS };

  function fmtDuration(ms) {
    const mins = Math.round(ms / 60000);
    if (mins < 60) return mins + "m";
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? h + "h " + m + "m" : h + "h";
  }

  function renderToggles() {
    $("enabled").checked = !!settings.enabled;
    $("autoClaimPoints").checked = !!settings.autoClaimPoints;
  }

  function renderStats(stats) {
    const s = { ...STATS_DEFAULTS, ...(stats || {}) };
    $("adsSkipped").textContent = s.adsSkipped.toLocaleString();
    $("pointsClaimed").textContent = s.pointsClaimed.toLocaleString();
    $("timeSaved").textContent = fmtDuration(s.timeSavedMs);
  }

  async function save(patch) {
    settings = { ...settings, ...patch };
    renderToggles();
    try {
      await api.storage.sync.set(patch);
    } catch (_) {}
  }

  async function refreshStats() {
    try {
      const got = await api.storage.local.get({ stats: STATS_DEFAULTS });
      renderStats(got.stats);
    } catch (_) {}
  }

  async function init() {
    try {
      $("version").textContent = "v" + api.runtime.getManifest().version;
    } catch (_) {}
    try {
      settings = { ...DEFAULTS, ...(await api.storage.sync.get(DEFAULTS)) };
    } catch (_) {}
    renderToggles();

    $("enabled").addEventListener("change", (e) => save({ enabled: e.target.checked }));
    $("autoClaimPoints").addEventListener("change", (e) => save({ autoClaimPoints: e.target.checked }));

    // Live-update the stats while the popup is open.
    try {
      api.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes.stats) renderStats(changes.stats.newValue);
      });
    } catch (_) {}

    await refreshStats();
    setInterval(refreshStats, 1500);
  }

  init();
})();
