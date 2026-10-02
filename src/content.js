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
  let claims = 0; // this tab only, for the console log
  let pointsEarned = 0; // this tab only, for the console log

  // ---------------------------------------------------------------
  // Lifetime stats (persisted in storage.local; read by the popup).
  //   adsSkipped   - ad breaks skipped
  //   pointsClaimed- channel-point bonuses auto-claimed (number of claims)
  //   pointsEarned - channel points those claims were worth, as reported by Twitch
  //   timeSavedMs  - summed break durations (ad time you did not watch)
  //   blanked      - breaks where every backup had the ad, so segments blanked
  //   leaks        - breaks where a real ad segment reached the player
  // Only background.js writes them. We report increments and never hold a
  // copy, so several tabs (and tabs that stay open for days) cannot overwrite
  // each other's counts.
  // ---------------------------------------------------------------
  let breakStart = 0;
  let breakWasBlanked = false;
  let breakWasLeaked = false;

  function bump(delta, claimChannel) {
    try {
      const sent = api.runtime.sendMessage({ type: "nta:stats", delta, claimChannel });
      if (sent && sent.catch) sent.catch(() => {});
    } catch (_) {
      // extension was reloaded under this tab; nothing can be recorded
    }
  }

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
    const rising = next.hasAds && !lastStatus.hasAds;
    const falling = !next.hasAds && lastStatus.hasAds;
    if (rising) {
      breaks++;
      breakStart = Date.now();
      breakWasBlanked = false;
      breakWasLeaked = false;
      bump({ adsSkipped: 1 });
    }
    if (next.hasAds) {
      if (next.stripping) breakWasBlanked = true;
      if (next.leaked) breakWasLeaked = true;
    }
    if (falling) {
      const delta = { blanked: breakWasBlanked ? 1 : 0, leaks: breakWasLeaked ? 1 : 0 };
      if (breakStart) {
        // Cap a single break's contribution so a stuck timer can't inflate it.
        delta.timeSavedMs = Math.min(Date.now() - breakStart, 5 * 60 * 1000);
        breakStart = 0;
      }
      bump(delta);
    }
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
  const CLAIM_CONFIRM_MS = 6000; // how long Twitch gets to answer after our click
  const CLAIM_GRACE_MS = 1500; // button gone but no reply seen: wait this long, then count it with unknown value
  const CLAIM_MAX_ATTEMPTS = 3; // clicks per button before we give up on it
  const claimAttempts = new WeakMap();
  let claimPending = false;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Twitch's reply to the claim request, relayed by page.js: { points, error, ... }.
  let claimResult = null;
  document.addEventListener("nta:claim-result", (event) => {
    try {
      claimResult = JSON.parse(event.detail || "{}");
    } catch (_) {}
  });

  // True while this element is still an unclaimed bonus. Twitch takes the
  // button away (or swaps its content for the balance) once a claim is accepted.
  function isClaimable(button) {
    return button.isConnected && CLAIM_SELECTORS.some((selector) => button.matches(selector) || button.querySelector(selector));
  }

  function findClaimButton() {
    for (const selector of CLAIM_SELECTORS) {
      const hit = document.querySelector(selector);
      if (!hit) continue;
      const button = hit.closest("button") || hit;
      if ((claimAttempts.get(button) || 0) < CLAIM_MAX_ATTEMPTS && button.isConnected) return button;
    }
    return null;
  }

  function recordClaim(points) {
    claims++;
    pointsEarned += points;
    bump({ pointsClaimed: 1, pointsEarned: points }, channelFromLocation());
    console.log("[No Twitch Ads] claimed channel points bonus" + (points ? " (+" + points + ")" : " (value unknown)") + ", " + claims + " claim(s) / " + pointsEarned + " points this tab");
  }

  // Clicks the bonus, then counts it only once Twitch has answered the claim
  // request: accepted means we count it and the points it was worth; refused
  // (already claimed in another tab/device, expired) means it is not ours. A
  // click that changes nothing is not a claim and is retried on a later poll,
  // up to CLAIM_MAX_ATTEMPTS.
  async function claimBonus(button) {
    try {
      // A short, randomised delay keeps the rhythm human and lets the button
      // finish rendering. Another tab or device may take the bonus meanwhile.
      await sleep(600 + Math.floor(Math.random() * 1200));
      if (!settings.autoClaimPoints || !isClaimable(button)) return;
      claimAttempts.set(button, (claimAttempts.get(button) || 0) + 1);
      claimResult = null;
      button.click();
      let goneAt = 0;
      for (const deadline = Date.now() + CLAIM_CONFIRM_MS; Date.now() < deadline; ) {
        await sleep(200);
        if (claimResult) {
          if (!claimResult.error) recordClaim(Number(claimResult.points) > 0 ? Math.floor(claimResult.points) : 0);
          return;
        }
        if (isClaimable(button)) continue;
        // The button went away but we saw no reply (Twitch changed how it
        // talks to its API?). It was almost certainly claimed; count the claim.
        goneAt = goneAt || Date.now();
        if (Date.now() - goneAt >= CLAIM_GRACE_MS) {
          recordClaim(0);
          return;
        }
      }
    } catch (_) {
      // button went away mid-way; the next poll starts over if a bonus is left
    } finally {
      claimPending = false;
    }
  }

  // A bonus appears roughly every 15 minutes and lingers for minutes before it
  // expires, so a light 3 s poll is plenty and avoids observing Twitch's very
  // busy chat subtree.
  function pollClaim() {
    if (!settings.autoClaimPoints || claimPending) return;
    const button = findClaimButton();
    if (!button) return;
    claimPending = true;
    claimBonus(button);
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
    sendResponse({ status: lastStatus, channel: channelFromLocation(), breaks, claims, pointsEarned });
    return true;
  });
})();
