// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 No Twitch Ads contributors. See LICENSE and NOTICE.md.
// Background service worker (Chrome) / event page (Firefox).
// Keeps default settings seeded and mirrors per-tab status onto the badge.

const DEFAULTS = {
  enabled: true,
  autoClaimPoints: true, // click the channel-points "Claim Bonus" button when it appears
  forcePopoutToken: true, // request the main stream with the "popout" player type (fewer ads); no UI
  showBanner: false, // on-player "skipping ad" banner; off, no UI
  whitelist: [], // channel logins to skip; no UI, power-users via storage
};

const api = typeof browser !== "undefined" ? browser : chrome;

api.runtime.onInstalled.addListener(async () => {
  const stored = await api.storage.sync.get(DEFAULTS);
  await api.storage.sync.set({ ...DEFAULTS, ...stored });
});

// ---------------------------------------------------------------
// Lifetime stats. This is the ONLY writer of storage.local "stats".
// Every Twitch tab/frame runs its own content script, so a script that kept its
// own copy and saved the whole object would overwrite the other tabs' counts.
// Scripts send deltas instead and one queue applies them one at a time.
// ---------------------------------------------------------------
const STATS_DEFAULTS = { adsSkipped: 0, pointsClaimed: 0, pointsEarned: 0, timeSavedMs: 0, blanked: 0, leaks: 0 };
// Claims counted before points were recorded had no value attached; they are
// credited at Twitch's standard 50-point bonus (popup/popup.js does the same).
const LEGACY_BONUS_POINTS = 50;
// Safety net behind Twitch's own "already claimed" reply: a channel hands out
// one bonus per ~15 min, so a second claim for the same channel within this
// window is another tab reporting the same bonus.
const CLAIM_DEDUPE_MS = 2 * 60 * 1000;
const CLAIM_LOG_KEEP_MS = 60 * 60 * 1000;
let statsQueue = Promise.resolve();

async function applyStatsDelta(delta, claimChannel) {
  const got = await api.storage.local.get({ stats: STATS_DEFAULTS, claimLog: {} });
  const stored = got.stats || {};
  const next = { ...STATS_DEFAULTS, ...stored };
  if (!("pointsEarned" in stored)) next.pointsEarned = (Number(stored.pointsClaimed) || 0) * LEGACY_BONUS_POINTS;
  const now = Date.now();
  let claimLog = got.claimLog || {};
  let claimLogChanged = false;
  let counted = true;
  let duplicateClaim = false;
  if (Number(delta && delta.pointsClaimed) > 0 && claimChannel) {
    const age = now - (claimLog[claimChannel] || 0);
    if (age >= 0 && age < CLAIM_DEDUPE_MS) {
      duplicateClaim = true;
      counted = false;
    } else {
      claimLog = Object.fromEntries(Object.entries(claimLog).filter(([, at]) => now - at < CLAIM_LOG_KEEP_MS));
      claimLog[claimChannel] = now;
      claimLogChanged = true;
    }
  }
  for (const key of Object.keys(STATS_DEFAULTS)) {
    const amount = Number(delta && delta[key]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (duplicateClaim && (key === "pointsClaimed" || key === "pointsEarned")) continue;
    next[key] += amount;
  }
  await api.storage.local.set(claimLogChanged ? { stats: next, claimLog } : { stats: next });
  return counted;
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "nta:stats") return;
  const answer = (reply) => {
    try {
      sendResponse(reply);
    } catch (_) {}
  };
  statsQueue = statsQueue
    .then(() => applyStatsDelta(message.delta, message.claimChannel))
    .then((counted) => answer({ ok: true, counted }), () => answer({ ok: false }));
  return true; // keep the channel open until the write is done
});

api.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== "nta:status" || !sender.tab) return;
  const tabId = sender.tab.id;
  const { hasAds, stripping } = message;
  const text = hasAds ? (stripping ? "AD!" : "AD") : "";
  const color = stripping ? "#d9534f" : "#9147ff";
  try {
    api.action.setBadgeText({ tabId, text });
    api.action.setBadgeBackgroundColor({ tabId, color });
  } catch (_) {
    // Tab may already be gone.
  }
});
