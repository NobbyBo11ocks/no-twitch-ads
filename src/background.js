// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 No Twitch Ads contributors. See LICENSE and NOTICE.md.
// Background service worker (Chrome) / event page (Firefox).
// Keeps default settings seeded and mirrors per-tab status onto the badge.

const DEFAULTS = {
  enabled: true,
  showBanner: true,
  backupMode: "360p", // "360p" = allow the 360p fallback stream, "source" = never drop quality
  forcePopoutToken: true, // request the main stream with the "popout" player type (fewer ads)
  whitelist: [], // channel logins where ad blocking is turned off
};

const api = typeof browser !== "undefined" ? browser : chrome;

api.runtime.onInstalled.addListener(async () => {
  const stored = await api.storage.sync.get(DEFAULTS);
  await api.storage.sync.set({ ...DEFAULTS, ...stored });
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
