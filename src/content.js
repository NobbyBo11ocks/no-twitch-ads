// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 No Twitch Ads contributors. See LICENSE and NOTICE.md.
// Isolated-world content script.
//
//  * Bridges extension settings (chrome.storage) to the MAIN-world script in
//    src/page.js and relays the page's ad status to the background badge.
//  * Auto-claims channel-point bonuses ("Claim Bonus" button under chat).
//  * Answers the popup's status queries for this tab.
//
// Communication with page.js is done through DOM CustomEvents on `document`
// with JSON-string payloads, which both worlds can see in Chrome and Firefox.
// page.js never touches extension APIs.

(() => {
  "use strict";
  const api = typeof browser !== "undefined" ? browser : chrome;
  const SETTINGS_KEYS = ["enabled", "showBanner", "forcePopoutToken", "whitelist", "autoClaimPoints"];
  const settings = { autoClaimPoints: true };
  let lastStatus = { hasAds: false, stripping: false, midroll: false, backup: null, channel: null };
  let breaks = 0;
  let pointsClaimed = 0;

  // ---------------------------------------------------------------
  // Settings bridge
  // ---------------------------------------------------------------
  function pushSettings(stored) {
    document.dispatchEvent(new CustomEvent("nta:settings", { detail: JSON.stringify(stored) }));
  }

  async function loadAndPush() {
    try {
      const stored = await api.storage.sync.get(SETTINGS_KEYS);
      if (typeof stored.autoClaimPoints === "boolean") settings.autoClaimPoints = stored.autoClaimPoints;
      pushSettings(stored);
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

  // ---------------------------------------------------------------
  // Ad status from the page (ad detected / stripping / finished)
  // ---------------------------------------------------------------
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

  // ---------------------------------------------------------------
  // Channel points auto-claim
  // ---------------------------------------------------------------
  // Twitch renders the bonus as a button inside the community-points summary
  // (next to the chat input) containing an element with the class
  // "claimable-bonus__icon"; its aria-label is "Claim Bonus" in English and a
  // translation elsewhere. We key on the class first (language independent)
  // and fall back to the English label.
  const CLAIM_SELECTORS = ['.claimable-bonus__icon', 'button[aria-label="Claim Bonus"]', '[data-test-selector="community-points-summary"] button[aria-label*="onus"]'];
  const clicked = new WeakSet();
  let claimPending = false;

  function findClaimButton() {
    for (const selector of CLAIM_SELECTORS) {
      const hit = document.querySelector(selector);
      if (!hit) continue;
      const button = hit.closest("button") || hit;
      if (!clicked.has(button) && button.isConnected) return button;
    }
    return null;
  }

  // A bonus appears roughly every 15 minutes and lingers for minutes before it
  // expires, so a light 3 s poll is plenty and avoids observing Twitch's very
  // busy chat subtree. When one is found we click after a short, randomised
  // delay (keeps the rhythm human and lets the button finish rendering).
  function pollClaim() {
    if (!settings.autoClaimPoints || claimPending) return;
    const button = findClaimButton();
    if (!button) return;
    claimPending = true;
    setTimeout(() => {
      claimPending = false;
      if (!settings.autoClaimPoints || !button.isConnected || clicked.has(button)) return;
      clicked.add(button);
      try {
        button.click();
        pointsClaimed++;
        console.log("[No Twitch Ads] claimed channel points bonus (" + pointsClaimed + " this tab)");
      } catch (_) {}
    }, 600 + Math.floor(Math.random() * 1200));
  }
  setInterval(pollClaim, 3000);

  // ---------------------------------------------------------------
  // Popup queries
  // ---------------------------------------------------------------
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

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "nta:get-status") return;
    if (window !== window.top) return; // only the top frame answers
    sendResponse({ status: lastStatus, channel: channelFromLocation(), breaks, pointsClaimed });
    return true;
  });
})();
