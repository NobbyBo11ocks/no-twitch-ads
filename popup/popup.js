// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 No Twitch Ads contributors. See LICENSE and NOTICE.md.

(() => {
  const api = typeof browser !== "undefined" ? browser : typeof chrome !== "undefined" ? chrome : null;
  const DEFAULTS = { enabled: true, autoClaimPoints: true };
  const STATS_DEFAULTS = { adsSkipped: 0, pointsClaimed: 0, pointsEarned: 0, timeSavedMs: 0, blanked: 0, leaks: 0 };
  // Claims counted before points were recorded had no value; they are credited at
  // Twitch's standard 50-point bonus (src/background.js does the same on write).
  const LEGACY_BONUS_POINTS = 50;

  const $ = (id) => document.getElementById(id);
  let settings = { ...DEFAULTS };
  let firstRender = true;

  const count = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

  // 42s, 5m 12s, 1h 05m: exact enough that one short break still shows up.
  function fmtDuration(ms) {
    const total = Math.floor(count(ms) / 1000);
    if (total < 60) return total + "s";
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    if (h) return h + "h " + String(m).padStart(2, "0") + "m";
    return m + "m " + String(total % 60).padStart(2, "0") + "s";
  }

  // Sets the text and, after the first paint, nudges the number when it changes.
  function setText(id, text) {
    const el = $(id);
    if (el.textContent === text) return;
    el.textContent = text;
    if (firstRender) return;
    el.classList.remove("bump");
    void el.offsetWidth; // restart the animation
    el.classList.add("bump");
  }

  function renderToggles() {
    $("enabled").checked = !!settings.enabled;
    $("autoClaimPoints").checked = !!settings.autoClaimPoints;
    document.body.classList.toggle("is-off", !settings.enabled);
  }

  function renderStats(stats) {
    const s = { ...STATS_DEFAULTS, ...(stats || {}) };
    const points = stats && "pointsEarned" in stats ? count(s.pointsEarned) : count(s.pointsClaimed) * LEGACY_BONUS_POINTS;
    setText("adsSkipped", count(s.adsSkipped).toLocaleString());
    setText("pointsClaimed", points.toLocaleString());
    setText("timeSaved", fmtDuration(s.timeSavedMs));
    firstRender = false;
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
      return true;
    } catch (_) {
      return false;
    }
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

    if (!(await refreshStats())) renderStats(null); // storage unreachable: show zeros
    setInterval(refreshStats, 1500);
  }

  init();
})();
