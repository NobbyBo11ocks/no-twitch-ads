// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 No Twitch Ads contributors. See LICENSE and NOTICE.md.
// Isolated-world content script.
// Bridges extension settings (chrome.storage) to the MAIN-world script in
// src/page.js, relays the page's ad status to the background badge, and
// answers the popup's status queries.
//
// Communication with page.js is done through DOM CustomEvents on `document`
// with JSON-string payloads, which both worlds can see in Chrome and Firefox.
// page.js never touches extension APIs.

(() => {
  const api = typeof browser !== "undefined" ? browser : chrome;
  const SETTINGS_KEYS = ["enabled", "showBanner", "backupMode", "forcePopoutToken", "whitelist"];
  let lastStatus = { hasAds: false, stripping: false, midroll: false, backup: null, channel: null };

  function pushSettings(settings) {
    document.dispatchEvent(new CustomEvent("nta:settings", { detail: JSON.stringify(settings) }));
  }

  async function loadAndPush() {
    try {
      const settings = await api.storage.sync.get(SETTINGS_KEYS);
      pushSettings(settings);
    } catch (_) {
      // storage may be unavailable while the extension is updating
    }
  }

  // page.js asks for settings as soon as it starts (it may run before we do),
  // and we also push proactively in case it already ran.
  document.addEventListener("nta:request-settings", loadAndPush);
  loadAndPush();

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    loadAndPush();
  });

  // Status from the page (ad detected / stripping / finished).
  let breaks = 0;
  document.addEventListener("nta:status", (event) => {
    let next;
    try {
      next = JSON.parse(event.detail || "{}");
    } catch (_) {
      return;
    }
    if (next.hasAds && !lastStatus.hasAds) breaks++;
    lastStatus = next;
    try {
      api.runtime.sendMessage({ type: "nta:status", ...lastStatus });
    } catch (_) {}
  });

  function channelFromLocation() {
    try {
      const url = new URL(location.href);
      if (url.hostname === "player.twitch.tv") return (url.searchParams.get("channel") || "").toLowerCase() || null;
      const parts = url.pathname.split("/").filter(Boolean);
      if (!parts.length) return null;
      let name = parts[0];
      if (["popout", "moderator", "embed"].includes(name) && parts[1]) name = parts[1];
      const nonChannels = ["directory", "videos", "downloads", "jobs", "p", "privacy", "search", "settings", "store", "turbo", "subscriptions", "inventory", "drops", "wallet", "friends", "prime", "bits", "u", "dashboard"];
      return nonChannels.includes(name) ? null : name.toLowerCase();
    } catch (_) {
      return null;
    }
  }

  // Popup asks for the current state of this tab.
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "nta:get-status") return;
    if (window !== window.top) return; // only the top frame answers
    sendResponse({ status: lastStatus, channel: channelFromLocation(), breaks });
    return true;
  });
})();
