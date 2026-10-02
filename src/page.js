// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 No Twitch Ads contributors. See LICENSE and NOTICE.md.
// No Twitch Ads — page script. Runs in the page's MAIN world at document_start
// so it can wrap `Worker` and `fetch` before Twitch's player boots.
//
// How it works (verified live against twitch.tv on 2026-10-01):
//  1. Twitch's player (Amazon IVS SDK) runs inside a Web Worker created from a
//     blob: URL on the twitch.tv origin. We wrap window.Worker so that worker
//     starts with our code prepended, which wraps the worker's own `fetch`.
//  2. Every HLS media playlist (.m3u8) the player fetches is inspected. Twitch
//     stitches ads server-side ("SureStream"); an ad break is marked with
//     #EXT-X-DATERANGE ... CLASS="twitch-stitched-ad" tags and the ad segments
//     lack the ",live" suffix that real stream segments carry (#EXTINF:2.000,live).
//  3. During an ad break we open a *separate* playback session for the same
//     channel using a different player type ("embed", "popout", then the 360p
//     "autoplay" session) and hand the player that session's playlist instead.
//     Those sessions are usually not inside an ad break at that moment.
//  4. If every backup session also carries the ad, the ad segments are
//     stripped and replaced with a tiny blank MP4 so nothing is displayed.
//
// The technique and large parts of the logic are adapted from
// pixeltris/TwitchAdSolutions ("vaft", MIT) and the maintained fork
// 0rpi/twitch-adblock-userscript (MIT). See NOTICE.md.

(() => {
  "use strict";
  const NTA_VERSION = "1.0.0";
  const LOG = "[No Twitch Ads]";

  if (window.__noTwitchAds) return;
  if (typeof window.twitchAdSolutionsVersion !== "undefined") {
    console.log(LOG, "a vaft-based ad blocker is already active (version " + window.twitchAdSolutionsVersion + "); staying idle.");
    return;
  }
  // vaft (and forks) check this and stand down when it is >= their own version.
  window.twitchAdSolutionsVersion = 24;

  // ------------------------------------------------------------------
  // Settings (pushed by src/content.js through DOM events)
  // ------------------------------------------------------------------
  const settings = {
    enabled: true,
    showBanner: false, // on-player banner; off, no UI control
    forcePopoutToken: true,
    whitelist: [], // kept for power users via storage; no UI
  };

  function workerSettings() {
    return {
      enabled: !!settings.enabled,
      whitelist: settings.whitelist,
      // "Source" behaviour: never drop to the 360p session. If both Source
      // backups carry the ad, ad segments are blanked instead.
      backupPlayerTypes: ["embed", "popout"],
      forcePopoutToken: !!settings.forcePopoutToken,
    };
  }

  function applySettings(incoming) {
    if (!incoming || typeof incoming !== "object") return;
    for (const key of Object.keys(settings)) {
      if (key in incoming && incoming[key] !== undefined) settings[key] = incoming[key];
    }
    if (!Array.isArray(settings.whitelist)) settings.whitelist = [];
    settings.whitelist = settings.whitelist.map((x) => String(x).toLowerCase());
    postTwitchWorkerMessage("UpdateSettings", workerSettings());
    if (!settings.showBanner) updateAdblockBanner({ hasAds: false });
  }

  document.addEventListener("nta:settings", (event) => {
    try {
      applySettings(JSON.parse(event.detail));
    } catch (err) {
      console.warn(LOG, "bad settings payload", err);
    }
  });

  function getChannelFromUrl() {
    try {
      const url = new URL(location.href);
      if (url.hostname === "player.twitch.tv") {
        return (url.searchParams.get("channel") || "").toLowerCase() || null;
      }
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length === 0) return null;
      let name = parts[0];
      if (["popout", "moderator", "embed"].includes(name) && parts[1]) name = parts[1];
      const nonChannels = ["directory", "videos", "downloads", "jobs", "p", "privacy", "search", "settings", "store", "turbo", "subscriptions", "inventory", "drops", "wallet", "friends", "prime", "bits", "u", "dashboard"];
      if (nonChannels.includes(name)) return null;
      return name.toLowerCase();
    } catch (_) {
      return null;
    }
  }

  function isCurrentChannelWhitelisted() {
    const channel = getChannelFromUrl();
    return !!channel && settings.whitelist.includes(channel);
  }

  function isActive() {
    return settings.enabled && !isCurrentChannelWhitelisted();
  }

  // ------------------------------------------------------------------
  // Worker-side code. Everything between the WORKER-CODE markers is
  // stringified (Function.prototype.toString) and evaluated inside Twitch's
  // player worker. These functions must only reference each other and the
  // globals set up by declareOptions(self).
  // ------------------------------------------------------------------

  // ---- WORKER-CODE BEGIN ----
  function declareOptions(scope) {
    scope.AdSignifier = "stitched";
    scope.ClientID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
    // Persisted-query hash used by Twitch's own web player for PlaybackAccessToken.
    scope.PlaybackAccessTokenHash = "ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9";
    // Full query used as a fallback if Twitch rotates the persisted hash.
    scope.PlaybackAccessTokenQuery =
      'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!, $platform: String!) {  streamPlaybackAccessToken(channelName: $login, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {    value    signature   authorization { isForbidden forbiddenReasonCode }   __typename  }  videoPlaybackAccessToken(id: $vodID, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {    value    signature   __typename  }}';
    scope.BackupPlayerTypes = ["embed", "popout", "autoplay"];
    scope.FallbackPlayerType = "embed";
    scope.ForceAccessTokenPlayerType = "popout";
    scope.SkipPlayerReloadOnHevc = false;
    scope.AlwaysReloadPlayerOnAd = false;
    scope.ReloadPlayerAfterAd = false;
    scope.PlayerReloadMinimalRequestsTime = 1500;
    scope.PlayerReloadMinimalRequestsPlayerIndex = 0;
    scope.HasTriggeredPlayerReload = false;
    scope.StreamInfos = {};
    scope.StreamInfosByUrl = {};
    scope.GQLDeviceID = null;
    scope.ClientVersion = null;
    scope.ClientSession = null;
    scope.ClientIntegrityHeader = null;
    scope.AuthorizationHeader = undefined;
    scope.SimulatedAdsDepth = 0;
    scope.V2API = false;
    scope.IsAdStrippingEnabled = true;
    scope.AdSegmentCache = new Map();
    scope.AllSegmentsAreAdSegments = false;
    scope.Enabled = true;
    scope.Whitelist = [];
    // A tiny valid fragmented MP4 (init segment only). Served in place of ad
    // segments when stripping, so the player decodes nothing instead of an ad.
    scope.BlankSegmentUrl = "data:video/mp4;base64,AAAAKGZ0eXBtcDQyAAAAAWlzb21tcDQyZGFzaGF2YzFpc282aGxzZgAABEltb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAYagAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAABqHRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAURtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAALuAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAADvbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAACzc3RibAAAAGdzdHNkAAAAAAAAAAEAAABXbXA0YQAAAAAAAAABAAAAAAAAAAAAAgAQAAAAALuAAAAAAAAzZXNkcwAAAAADgICAIgABAASAgIAUQBUAAAAAAAAAAAAAAAWAgIACEZAGgICAAQIAAAAQc3R0cwAAAAAAAAAAAAAAEHN0c2MAAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAAeV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAoAAAAFoAAAAAAGBbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAA9CQAAAAABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABLG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAOxzdGJsAAAAoHN0c2QAAAAAAAAAAQAAAJBhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAoABaABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAOmF2Y0MBTUAe/+EAI2dNQB6WUoFAX/LgLUBAQFAAAD6AAA6mDgAAHoQAA9CW7y4KAQAEaOuPIAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAASG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAC4AAAAAAoAAAAAAACB0cmV4AAAAAAAAAAIAAAABAACCNQAAAAACQAAA";
  }

  function shouldBlockChannel(channelName) {
    if (!Enabled) return false;
    if (channelName && Whitelist.includes(String(channelName).toLowerCase())) return false;
    return true;
  }

  function getWasmWorkerJs(twitchBlobUrl) {
    const req = new XMLHttpRequest();
    req.open("GET", twitchBlobUrl, false);
    req.overrideMimeType("text/javascript");
    req.send();
    return req.responseText;
  }

  function parseAttributes(str) {
    return Object.fromEntries(
      str
        .split(/(?:^|,)((?:[^=]*)=(?:"[^"]*"|[^,]*))/)
        .filter(Boolean)
        .map((x) => {
          const idx = x.indexOf("=");
          const key = x.substring(0, idx);
          const value = x.substring(idx + 1);
          const num = Number(value);
          return [key, Number.isNaN(num) ? (value.startsWith('"') ? JSON.parse(value) : value) : num];
        })
    );
  }

  function getServerTimeFromM3u8(encodingsM3u8) {
    if (V2API) {
      const matches = encodingsM3u8.match(/#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="([^"]+)"/);
      return matches ? matches[1] : null;
    }
    const matches = encodingsM3u8.match(/SERVER-TIME="([0-9.]+)"/);
    return matches ? matches[1] : null;
  }

  function replaceServerTimeInM3u8(encodingsM3u8, newServerTime) {
    if (!newServerTime) return encodingsM3u8;
    if (V2API) {
      return encodingsM3u8.replace(/(#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE=")[^"]+(")/, `$1${newServerTime}$2`);
    }
    return encodingsM3u8.replace(/(SERVER-TIME=")[0-9.]+"/, `$1${newServerTime}"`);
  }

  // Marks ad segments so the segment fetch hook serves a blank MP4 instead,
  // and neuters ad tracking URLs. Real stream segments carry ",live" in EXTINF.
  function stripAdSegments(textStr, stripAllSegments, streamInfo) {
    let hasStrippedAdSegments = false;
    const lines = textStr.replaceAll("\r", "").split("\n");
    const newAdUrl = "https://twitch.tv";
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      line = line
        .replaceAll(/(X-TV-TWITCH-AD-URL=")(?:[^"]*)(")/g, `$1${newAdUrl}$2`)
        .replaceAll(/(X-TV-TWITCH-AD-CLICK-TRACKING-URL=")(?:[^"]*)(")/g, `$1${newAdUrl}$2`);
      lines[i] = line;
      if (i < lines.length - 1 && line.startsWith("#EXTINF") && (!line.includes(",live") || stripAllSegments || AllSegmentsAreAdSegments)) {
        const segmentUrl = lines[i + 1];
        if (!AdSegmentCache.has(segmentUrl)) {
          streamInfo.NumStrippedAdSegments++;
        }
        AdSegmentCache.set(segmentUrl, Date.now());
        hasStrippedAdSegments = true;
      }
      if (line.includes(AdSignifier)) {
        hasStrippedAdSegments = true;
      }
    }
    if (hasStrippedAdSegments) {
      for (let i = 0; i < lines.length; i++) {
        // No low-latency prefetch during ads, otherwise the player may fetch
        // and display ad segments before we see them in a playlist.
        if (lines[i].startsWith("#EXT-X-TWITCH-PREFETCH:")) {
          lines[i] = "";
        }
      }
    } else {
      streamInfo.NumStrippedAdSegments = 0;
    }
    streamInfo.IsStrippingAdSegments = hasStrippedAdSegments;
    AdSegmentCache.forEach((value, key, map) => {
      if (value < Date.now() - 120000) {
        map.delete(key);
      }
    });
    return lines.join("\n");
  }

  function getStreamUrlForResolution(encodingsM3u8, resolutionInfo) {
    const encodingsLines = encodingsM3u8.replaceAll("\r", "").split("\n");
    const [targetWidth, targetHeight] = resolutionInfo.Resolution.split("x").map(Number);
    let matchedResolutionUrl = null;
    let matchedFrameRate = false;
    let closestResolutionUrl = null;
    let closestResolutionDifference = Infinity;
    for (let i = 0; i < encodingsLines.length - 1; i++) {
      if (encodingsLines[i].startsWith("#EXT-X-STREAM-INF") && encodingsLines[i + 1].includes(".m3u8")) {
        const attributes = parseAttributes(encodingsLines[i]);
        const resolution = attributes["RESOLUTION"];
        const frameRate = attributes["FRAME-RATE"];
        if (resolution) {
          if (resolution == resolutionInfo.Resolution && (!matchedResolutionUrl || (!matchedFrameRate && frameRate == resolutionInfo.FrameRate))) {
            matchedResolutionUrl = encodingsLines[i + 1];
            matchedFrameRate = frameRate == resolutionInfo.FrameRate;
            if (matchedFrameRate) {
              return matchedResolutionUrl;
            }
          }
          const [width, height] = resolution.split("x").map(Number);
          const difference = Math.abs(width * height - targetWidth * targetHeight);
          if (difference < closestResolutionDifference) {
            closestResolutionUrl = encodingsLines[i + 1];
            closestResolutionDifference = difference;
          }
        }
      }
    }
    return matchedResolutionUrl || closestResolutionUrl;
  }

  // Relays a GQL request to the page (which has the real headers Twitch uses).
  function gqlRequest(body) {
    if (!GQLDeviceID) {
      GQLDeviceID = "";
      const dcharacters = "abcdefghijklmnopqrstuvwxyz0123456789";
      for (let i = 0; i < 32; i++) {
        GQLDeviceID += dcharacters.charAt(Math.floor(Math.random() * dcharacters.length));
      }
    }
    const headers = {
      "Client-ID": ClientID,
      "X-Device-Id": GQLDeviceID,
      Authorization: AuthorizationHeader,
      ...(ClientIntegrityHeader && { "Client-Integrity": ClientIntegrityHeader }),
      ...(ClientVersion && { "Client-Version": ClientVersion }),
      ...(ClientSession && { "Client-Session-Id": ClientSession }),
    };
    return new Promise((resolve, reject) => {
      const requestId = Math.random().toString(36).substring(2, 15);
      pendingFetchRequests.set(requestId, { resolve, reject });
      postMessage({
        key: "FetchRequest",
        value: {
          id: requestId,
          url: "https://gql.twitch.tv/gql",
          options: { method: "POST", body: JSON.stringify(body), headers },
        },
      });
      setTimeout(() => {
        if (pendingFetchRequests.has(requestId)) {
          pendingFetchRequests.delete(requestId);
          reject(new Error("GQL relay timed out"));
        }
      }, 10000);
    });
  }

  // Returns { value, signature } or null.
  async function getAccessToken(channelName, playerType) {
    const variables = {
      isLive: true,
      login: channelName,
      isVod: false,
      vodID: "",
      playerType: playerType,
      platform: playerType == "autoplay" ? "android" : "web",
    };
    const extract = async (response) => {
      if (!response || response.status !== 200) return null;
      try {
        const json = await response.json();
        const token = json && json.data && json.data.streamPlaybackAccessToken;
        return token && token.value && token.signature ? token : null;
      } catch (_) {
        return null;
      }
    };
    let token = await extract(
      await gqlRequest({
        operationName: "PlaybackAccessToken",
        variables,
        extensions: { persistedQuery: { version: 1, sha256Hash: PlaybackAccessTokenHash } },
      })
    );
    if (!token) {
      // Persisted hash may have rotated; send the full query instead.
      token = await extract(
        await gqlRequest({
          operationName: "PlaybackAccessToken_Template",
          query: PlaybackAccessTokenQuery,
          variables,
        })
      );
    }
    return token;
  }

  async function processM3U8(url, textStr, realFetch) {
    const streamInfo = StreamInfosByUrl[url];
    if (!streamInfo || !shouldBlockChannel(streamInfo.ChannelName)) {
      return textStr;
    }
    if (HasTriggeredPlayerReload) {
      HasTriggeredPlayerReload = false;
      streamInfo.LastPlayerReload = Date.now();
    }
    const haveAdTags = textStr.includes(AdSignifier) || SimulatedAdsDepth > 0;
    let adLeaked = false;
    if (haveAdTags) {
      streamInfo.IsMidroll = textStr.includes('"MIDROLL"') || textStr.includes('"midroll"');
      if (!streamInfo.IsShowingAd) {
        streamInfo.IsShowingAd = true;
        postMessage({
          key: "UpdateAdBlockBanner",
          isMidroll: streamInfo.IsMidroll,
          hasAds: true,
          isStrippingAdSegments: false,
        });
      }
      if (!streamInfo.IsMidroll) {
        // Twitch expects the client to actually download preroll ad segments
        // before it will let the session move on. Fetch one per playlist.
        const lines = textStr.replaceAll("\r", "").split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.startsWith("#EXTINF") && lines.length > i + 1) {
            if (!line.includes(",live") && !streamInfo.RequestedAds.has(lines[i + 1])) {
              streamInfo.RequestedAds.add(lines[i + 1]);
              realFetch(lines[i + 1]).then((response) => response.blob()).catch(() => {});
              break;
            }
          }
        }
      }
      const currentResolution = streamInfo.Urls[url];
      if (!currentResolution) {
        console.log("[No Twitch Ads] ads will leak: no resolution info for " + url);
        return textStr;
      }
      const isHevc = currentResolution.Codecs.startsWith("hev") || currentResolution.Codecs.startsWith("hvc");
      if (((isHevc && !SkipPlayerReloadOnHevc) || AlwaysReloadPlayerOnAd) && streamInfo.ModifiedM3U8 && !streamInfo.IsUsingModifiedM3U8) {
        streamInfo.IsUsingModifiedM3U8 = true;
        streamInfo.LastPlayerReload = Date.now();
        postMessage({ key: "ReloadPlayer" });
      }
      let backupPlayerType = null;
      let backupM3u8 = null;
      let fallbackM3u8 = null;
      let startIndex = 0;
      let isDoingMinimalRequests = false;
      if (streamInfo.LastPlayerReload > Date.now() - PlayerReloadMinimalRequestsTime) {
        // Right after a player reload there are many requests; keep it cheap.
        startIndex = PlayerReloadMinimalRequestsPlayerIndex;
        isDoingMinimalRequests = true;
      }
      for (let playerTypeIndex = startIndex; !backupM3u8 && playerTypeIndex < BackupPlayerTypes.length; playerTypeIndex++) {
        const playerType = BackupPlayerTypes[playerTypeIndex];
        const realPlayerType = playerType.replace("-CACHED", "");
        const isFullyCachedPlayerType = playerType != realPlayerType;
        for (let i = 0; i < 2; i++) {
          // First pass uses a cached backup master playlist; if that session is
          // inside an ad too, the second pass fetches a fresh session.
          let isFreshM3u8 = false;
          let encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType];
          if (!encodingsM3u8) {
            isFreshM3u8 = true;
            try {
              const accessToken = await getAccessToken(streamInfo.ChannelName, realPlayerType);
              if (accessToken) {
                const urlInfo = new URL("https://usher.ttvnw.net/api/" + (V2API ? "v2/" : "") + "channel/hls/" + streamInfo.ChannelName + ".m3u8" + streamInfo.UsherParams);
                urlInfo.searchParams.set("sig", accessToken.signature);
                urlInfo.searchParams.set("token", accessToken.value);
                const encodingsM3u8Response = await realFetch(urlInfo.href);
                if (encodingsM3u8Response.status === 200) {
                  encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType] = await encodingsM3u8Response.text();
                }
              }
            } catch (err) {
              console.log("[No Twitch Ads] backup session (" + realPlayerType + ") failed: " + err);
            }
          }
          if (encodingsM3u8) {
            try {
              const streamM3u8Url = getStreamUrlForResolution(encodingsM3u8, currentResolution);
              const streamM3u8Response = await realFetch(streamM3u8Url);
              if (streamM3u8Response.status == 200) {
                const m3u8Text = await streamM3u8Response.text();
                if (m3u8Text) {
                  if (playerType == FallbackPlayerType) {
                    fallbackM3u8 = m3u8Text;
                  }
                  if ((!m3u8Text.includes(AdSignifier) && (SimulatedAdsDepth == 0 || playerTypeIndex >= SimulatedAdsDepth - 1)) || (!fallbackM3u8 && playerTypeIndex >= BackupPlayerTypes.length - 1)) {
                    backupPlayerType = playerType;
                    backupM3u8 = m3u8Text;
                    break;
                  }
                  if (isFullyCachedPlayerType) {
                    break;
                  }
                  if (isDoingMinimalRequests) {
                    backupPlayerType = playerType;
                    backupM3u8 = m3u8Text;
                    break;
                  }
                }
              }
            } catch (err) {}
          }
          streamInfo.BackupEncodingsM3U8Cache[playerType] = null;
          if (isFreshM3u8) {
            break;
          }
        }
      }
      if (!backupM3u8 && fallbackM3u8) {
        backupPlayerType = FallbackPlayerType;
        backupM3u8 = fallbackM3u8;
      }
      if (backupM3u8) {
        textStr = backupM3u8;
        if (streamInfo.ActiveBackupPlayerType != backupPlayerType) {
          streamInfo.ActiveBackupPlayerType = backupPlayerType;
          console.log("[No Twitch Ads] blocking " + (streamInfo.IsMidroll ? "midroll " : "") + "ads using backup session: " + backupPlayerType);
        }
      }
      const stripHevc = isHevc && streamInfo.ModifiedM3U8;
      if (IsAdStrippingEnabled || stripHevc) {
        textStr = stripAdSegments(textStr, stripHevc, streamInfo);
      }
      // Leak check: is a real ad segment about to reach the player? A leaked
      // segment is a non-",live" #EXTINF whose URL was NOT blanked (not in the
      // ad-segment cache). With a clean backup there are none; when blanking,
      // all are cached. Anything left means an ad would actually play.
      adLeaked = hasUnblankedAdSegment(textStr);
      if (adLeaked && !streamInfo.LeakReported) {
        streamInfo.LeakReported = true;
        console.warn("[No Twitch Ads] ad segment leaked to the player on " + streamInfo.ChannelName + " — backups and stripping did not cover this break");
      }
    } else if (streamInfo.IsShowingAd) {
      console.log("[No Twitch Ads] ad break over");
      const wasStrippingAdSegments = streamInfo.IsStrippingAdSegments;
      streamInfo.IsShowingAd = false;
      streamInfo.IsStrippingAdSegments = false;
      streamInfo.NumStrippedAdSegments = 0;
      streamInfo.ActiveBackupPlayerType = null;
      streamInfo.LeakReported = false;
      if (streamInfo.IsUsingModifiedM3U8 || ReloadPlayerAfterAd || wasStrippingAdSegments) {
        streamInfo.IsUsingModifiedM3U8 = false;
        streamInfo.LastPlayerReload = Date.now();
        postMessage({ key: "ReloadPlayer" });
      } else {
        postMessage({ key: "PauseResumePlayer" });
      }
    }
    postMessage({
      key: "UpdateAdBlockBanner",
      isMidroll: streamInfo.IsMidroll,
      hasAds: streamInfo.IsShowingAd,
      isStrippingAdSegments: streamInfo.IsStrippingAdSegments,
      numStrippedAdSegments: streamInfo.NumStrippedAdSegments,
      backupPlayerType: streamInfo.ActiveBackupPlayerType,
      leaked: adLeaked,
    });
    return textStr;
  }

  // True if the playlist still contains an ad segment that would actually play:
  // a non-",live" #EXTINF whose segment URL is not in the blanked-segment cache.
  function hasUnblankedAdSegment(textStr) {
    const lines = textStr.replaceAll("\r", "").split("\n");
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i].startsWith("#EXTINF") && !lines[i].includes(",live")) {
        const seg = lines[i + 1];
        if (seg && !seg.startsWith("#") && !AdSegmentCache.has(seg)) return true;
      }
    }
    return false;
  }

  function hookWorkerFetch() {
    console.log("[No Twitch Ads] worker fetch hooked");
    // Bind to the worker global, so passing realFetch around (e.g. into
    // processM3U8) can never detach it and trigger "Illegal invocation".
    const realFetch = self.fetch.bind(self);
    self.fetch = async function (url, options) {
      if (url instanceof URL) url = url.href;
      if (typeof url === "string") {
        url = url.trimEnd();
        if (AdSegmentCache.has(url)) {
          return realFetch(BlankSegmentUrl, options);
        }
        if (url.includes("/channel/hls/") && !url.includes("picture-by-picture")) {
          V2API = url.includes("/api/v2/");
          const match = new URL(url).pathname.match(/([^\/]+)(?=\.\w+$)/);
          const channelName = match ? decodeURIComponent(match[0]).toLowerCase() : null;
          if (!channelName || !shouldBlockChannel(channelName)) {
            return realFetch.apply(this, arguments);
          }
          if (ForceAccessTokenPlayerType) {
            // parent_domains marks the player as embedded; dropping it avoids
            // Twitch serving "embed" ad experiences.
            const tempUrl = new URL(url);
            tempUrl.searchParams.delete("parent_domains");
            url = tempUrl.toString();
          }
          const response = await realFetch(url, options);
          if (response.status !== 200) return response;
          const encodingsM3u8 = await response.text();
          const serverTime = getServerTimeFromM3u8(encodingsM3u8);
          let streamInfo = StreamInfos[channelName];
          if (streamInfo && streamInfo.EncodingsM3U8) {
            // Reuse the existing session (keeps us out of a new preroll on
            // player reload) unless it has died (stream restarted).
            let dead = true;
            try {
              const firstVariant = streamInfo.EncodingsM3U8.match(/^https:.*\.m3u8$/m);
              dead = !firstVariant || (await realFetch(firstVariant[0])).status !== 200;
            } catch (_) {
              dead = true;
            }
            if (dead) streamInfo = null;
          }
          if (!streamInfo) {
            StreamInfos[channelName] = streamInfo = {
              ChannelName: channelName,
              IsShowingAd: false,
              LastPlayerReload: 0,
              EncodingsM3U8: encodingsM3u8,
              ModifiedM3U8: null,
              IsUsingModifiedM3U8: false,
              UsherParams: new URL(url).search,
              RequestedAds: new Set(),
              Urls: {}, // variant url -> { Resolution, FrameRate, Codecs, Url }
              ResolutionList: [],
              BackupEncodingsM3U8Cache: {},
              ActiveBackupPlayerType: null,
              IsMidroll: false,
              IsStrippingAdSegments: false,
              NumStrippedAdSegments: 0,
            };
            const lines = encodingsM3u8.replaceAll("\r", "").split("\n");
            for (let i = 0; i < lines.length - 1; i++) {
              if (lines[i].startsWith("#EXT-X-STREAM-INF") && lines[i + 1].includes(".m3u8")) {
                const attributes = parseAttributes(lines[i]);
                const resolution = attributes["RESOLUTION"];
                if (resolution) {
                  const resolutionInfo = {
                    Resolution: resolution,
                    FrameRate: attributes["FRAME-RATE"],
                    Codecs: attributes["CODECS"] || "",
                    Url: lines[i + 1],
                  };
                  streamInfo.Urls[lines[i + 1]] = resolutionInfo;
                  streamInfo.ResolutionList.push(resolutionInfo);
                }
                StreamInfosByUrl[lines[i + 1]] = streamInfo;
              }
            }
            // Backup sessions may not offer HEVC (2K/4K) renditions. Prepare an
            // AVC-only master playlist that we switch to during ads.
            const nonHevcResolutionList = streamInfo.ResolutionList.filter((element) => element.Codecs.startsWith("avc") || element.Codecs.startsWith("av0"));
            const hasHevc = streamInfo.ResolutionList.some((element) => element.Codecs.startsWith("hev") || element.Codecs.startsWith("hvc"));
            if (AlwaysReloadPlayerOnAd || (nonHevcResolutionList.length > 0 && hasHevc && !SkipPlayerReloadOnHevc)) {
              if (nonHevcResolutionList.length > 0) {
                for (let i = 0; i < lines.length - 1; i++) {
                  if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
                    const resSettings = parseAttributes(lines[i].substring(lines[i].indexOf(":") + 1));
                    const codecs = resSettings["CODECS"] || "";
                    if (codecs.startsWith("hev") || codecs.startsWith("hvc")) {
                      const oldResolution = resSettings["RESOLUTION"];
                      const [targetWidth, targetHeight] = String(oldResolution).split("x").map(Number);
                      const newResolutionInfo = nonHevcResolutionList
                        .slice()
                        .sort((a, b) => {
                          const [wa, ha] = a.Resolution.split("x").map(Number);
                          const [wb, hb] = b.Resolution.split("x").map(Number);
                          return Math.abs(wa * ha - targetWidth * targetHeight) - Math.abs(wb * hb - targetWidth * targetHeight);
                        })[0];
                      console.log("[No Twitch Ads] HEVC rendition " + oldResolution + " will fall back to " + newResolutionInfo.Resolution + " (" + newResolutionInfo.Codecs + ") during ads");
                      lines[i] = lines[i].replace(/CODECS="[^"]+"/, `CODECS="${newResolutionInfo.Codecs}"`);
                      // Each URL line must be unique or the player refuses the playlist.
                      lines[i + 1] = newResolutionInfo.Url + " ".repeat(i + 1);
                    }
                  }
                }
              }
              if (nonHevcResolutionList.length > 0 || AlwaysReloadPlayerOnAd) {
                streamInfo.ModifiedM3U8 = lines.join("\n");
              }
            }
          }
          streamInfo.LastPlayerReload = Date.now();
          return new Response(replaceServerTimeInM3u8(streamInfo.IsUsingModifiedM3U8 ? streamInfo.ModifiedM3U8 : streamInfo.EncodingsM3U8, serverTime));
        }
        // Media playlists of a live session we registered above. VOD/clip
        // playlists are never ours and pass straight through.
        if (url.endsWith(".m3u8") && StreamInfosByUrl[url]) {
          const response = await realFetch(url, options);
          if (response.status !== 200) return response;
          const text = await response.text();
          try {
            return new Response(await processM3U8(url, text, realFetch));
          } catch (err) {
            // Never let a processing bug break playback: fall back to the
            // original playlist (ads may show, but the stream keeps running).
            console.log("[No Twitch Ads] playlist processing failed, serving original: " + err);
            return new Response(text);
          }
        }
      }
      return realFetch.apply(this, arguments);
    };
  }

  function workerMain(initialState) {
    declareOptions(self);
    Object.assign(self, initialState);
    self.addEventListener("message", function (e) {
      const data = e.data;
      if (!data || typeof data.key !== "string") return;
      if (data.key == "UpdateClientVersion") {
        ClientVersion = data.value;
      } else if (data.key == "UpdateClientSession") {
        ClientSession = data.value;
      } else if (data.key == "UpdateClientId") {
        ClientID = data.value;
      } else if (data.key == "UpdateDeviceId") {
        GQLDeviceID = data.value;
      } else if (data.key == "UpdateClientIntegrityHeader") {
        ClientIntegrityHeader = data.value;
      } else if (data.key == "UpdateAuthorizationHeader") {
        AuthorizationHeader = data.value;
      } else if (data.key == "UpdateSettings") {
        const s = data.value || {};
        Enabled = !!s.enabled;
        Whitelist = Array.isArray(s.whitelist) ? s.whitelist : [];
        if (Array.isArray(s.backupPlayerTypes) && s.backupPlayerTypes.length) BackupPlayerTypes = s.backupPlayerTypes;
        ForceAccessTokenPlayerType = s.forcePopoutToken ? "popout" : null;
      } else if (data.key == "FetchResponse") {
        const responseData = data.value;
        if (pendingFetchRequests.has(responseData.id)) {
          const { resolve, reject } = pendingFetchRequests.get(responseData.id);
          pendingFetchRequests.delete(responseData.id);
          if (responseData.error) {
            reject(new Error(responseData.error));
          } else {
            resolve(
              new Response(responseData.body, {
                status: responseData.status,
                statusText: responseData.statusText,
                headers: responseData.headers,
              })
            );
          }
        }
      } else if (data.key == "TriggeredPlayerReload") {
        HasTriggeredPlayerReload = true;
      } else if (data.key == "SimulateAds") {
        SimulatedAdsDepth = data.value;
        console.log("[No Twitch Ads] SimulatedAdsDepth: " + SimulatedAdsDepth);
      } else if (data.key == "AllSegmentsAreAdSegments") {
        AllSegmentsAreAdSegments = !AllSegmentsAreAdSegments;
        console.log("[No Twitch Ads] AllSegmentsAreAdSegments: " + AllSegmentsAreAdSegments);
      }
    });
    hookWorkerFetch();
  }
  // ---- WORKER-CODE END ----

  const WORKER_FUNCTIONS = [
    declareOptions,
    shouldBlockChannel,
    parseAttributes,
    getServerTimeFromM3u8,
    replaceServerTimeInM3u8,
    stripAdSegments,
    getStreamUrlForResolution,
    hasUnblankedAdSegment,
    gqlRequest,
    getAccessToken,
    processM3U8,
    hookWorkerFetch,
    workerMain,
  ];

  function buildWorkerPrelude(initialState) {
    return [
      "(function(){",
      "const pendingFetchRequests = new Map();",
      ...WORKER_FUNCTIONS.map((fn) => fn.toString()),
      "workerMain(" + JSON.stringify(initialState) + ");",
      "})();\n",
    ].join("\n");
  }

  // ------------------------------------------------------------------
  // Page-side state
  // ------------------------------------------------------------------
  const twitchWorkers = [];
  let GQLDeviceID = null;
  let ClientVersion = null;
  let ClientSession = null;
  let ClientIntegrityHeader = null;
  let AuthorizationHeader = undefined;
  let isActivelyStrippingAds = false;
  let localStorageHookFailed = false;
  let lastStatus = { hasAds: false, stripping: false, midroll: false, backup: null };

  const PlayerBufferingFix = true;
  const PlayerBufferingDelay = 600;
  const PlayerBufferingSameStateCount = 3;
  const PlayerBufferingDangerZone = 1;
  const PlayerBufferingDoPlayerReload = false;
  const PlayerBufferingMinRepeatDelay = 8000;
  const PlayerBufferingPrerollCheckEnabled = false;
  const PlayerBufferingPrerollCheckOffset = 5;
  // Auto-quality (anti-downgrade): remember the quality you are actually
  // watching and, if a break-end reload drops it, restore it via the player
  // API. Respects Auto mode and never forces a quality you did not choose.
  const AutoQualityRestore = true;
  let preferredQualityGroup = null;
  let restoreQualityUntil = 0;

  function postTwitchWorkerMessage(key, value) {
    twitchWorkers.forEach((worker) => {
      try {
        worker.postMessage({ key: key, value: value });
      } catch (_) {}
    });
  }

  function currentWorkerState() {
    const ws = workerSettings();
    return {
      GQLDeviceID,
      ClientVersion,
      ClientSession,
      ClientIntegrityHeader,
      AuthorizationHeader,
      Enabled: ws.enabled,
      Whitelist: ws.whitelist,
      BackupPlayerTypes: ws.backupPlayerTypes,
      ForceAccessTokenPlayerType: ws.forcePopoutToken ? "popout" : null,
    };
  }

  function isKnownAdBlockerWorker(worker) {
    let proto = worker;
    while (proto) {
      let source = "";
      try {
        source = proto.toString();
      } catch (_) {}
      if (source.includes("twitch") && (source.includes("getAdBlockDiv") || source.includes("getAdDiv") || source.includes("hookWorkerFetch") || source.includes("No Twitch Ads"))) {
        return true;
      }
      proto = Object.getPrototypeOf(proto);
    }
    return false;
  }

  // ------------------------------------------------------------------
  // Worker hook
  // ------------------------------------------------------------------
  function hookWindowWorker() {
    const RealWorker = window.Worker;
    if (isKnownAdBlockerWorker(RealWorker)) {
      console.log(LOG, "another Twitch ad blocker already wraps Worker; staying idle.");
      return false;
    }
    class Worker extends RealWorker {
      constructor(scriptUrl, options) {
        // "getAdDiv": marker so TTV LOL PRO and similar tools detect us and back off. twitch
        let isTwitchWorker = false;
        try {
          isTwitchWorker = new URL(String(scriptUrl), location.href).origin.endsWith(".twitch.tv");
        } catch (_) {}
        if (!isTwitchWorker) {
          super(scriptUrl, options);
          return;
        }
        let original = "";
        try {
          original = getWasmWorkerJs(String(scriptUrl));
        } catch (err) {
          console.warn("[No Twitch Ads] could not read Twitch worker source, falling back to importScripts", err);
          original = "importScripts(" + JSON.stringify(String(scriptUrl)) + ");";
        }
        const blob = new Blob([buildWorkerPrelude(currentWorkerState()), original], { type: "text/javascript" });
        super(URL.createObjectURL(blob), options);
        twitchWorkers.push(this);
        this.addEventListener("message", (e) => {
          const data = e.data;
          if (!data || typeof data.key !== "string") return;
          if (data.key == "UpdateAdBlockBanner") {
            updateAdblockBanner(data);
          } else if (data.key == "PauseResumePlayer") {
            doTwitchPlayerTask(true, false);
          } else if (data.key == "ReloadPlayer") {
            doTwitchPlayerTask(false, true);
          } else if (data.key == "FetchRequest") {
            handleWorkerFetchRequest(data.value).then((responseData) => {
              this.postMessage({ key: "FetchResponse", value: responseData });
            });
          }
        });
      }
    }
    window.Worker = Worker;
    return true;
  }

  async function handleWorkerFetchRequest(fetchRequest) {
    try {
      const response = await window.__noTwitchAds.realFetch(fetchRequest.url, fetchRequest.options);
      const responseBody = await response.text();
      return {
        id: fetchRequest.id,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody,
      };
    } catch (error) {
      return { id: fetchRequest.id, error: error.message };
    }
  }

  // ------------------------------------------------------------------
  // Page fetch hook: learn Twitch's GQL headers, steer the main token request
  // ------------------------------------------------------------------
  function headerGet(headers, name) {
    if (!headers) return undefined;
    if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.get(name) || undefined;
    if (name in headers) return headers[name];
    const lower = name.toLowerCase();
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === lower) return headers[key];
    }
    return undefined;
  }

  // Reports Twitch's own answer to a "Claim Bonus" click to the content script
  // (src/content.js). That reply is the authoritative record of a claim: it says
  // whether Twitch accepted it and exactly how many points it was worth.
  function relayClaimResult(response) {
    Promise.resolve(response)
      .then((res) => res.clone().json())
      .then((json) => {
        for (const entry of Array.isArray(json) ? json : [json]) {
          const payload = entry && entry.data && entry.data.claimCommunityPoints;
          if (!payload) continue;
          const claim = payload.claim || {};
          const detail = {
            claimId: claim.id || null,
            points: Number(claim.pointsEarnedTotal) || 0,
            balance: Number(payload.currentPoints) || 0,
            error: payload.error ? payload.error.code || "ERROR" : null,
          };
          document.dispatchEvent(new CustomEvent("nta:claim-result", { detail: JSON.stringify(detail) }));
        }
      })
      .catch(() => {});
  }

  function hookFetch() {
    // Bound to window: this reference is called as a property of other objects
    // (the worker fetch relay, debug helpers), and an unbound native fetch
    // throws "Illegal invocation" when its receiver isn't the global.
    const realFetch = window.fetch.bind(window);
    window.__noTwitchAds.realFetch = realFetch;
    window.fetch = function (url, init, ...args) {
      if (typeof url === "string" && url.includes("gql") && init) {
        const headers = init.headers;
        let deviceId = headerGet(headers, "X-Device-Id");
        if (typeof deviceId !== "string") deviceId = headerGet(headers, "Device-ID");
        if (typeof deviceId === "string" && GQLDeviceID != deviceId) {
          GQLDeviceID = deviceId;
          postTwitchWorkerMessage("UpdateDeviceId", GQLDeviceID);
        }
        const clientVersion = headerGet(headers, "Client-Version");
        if (typeof clientVersion === "string" && clientVersion !== ClientVersion) {
          postTwitchWorkerMessage("UpdateClientVersion", (ClientVersion = clientVersion));
        }
        const clientSession = headerGet(headers, "Client-Session-Id");
        if (typeof clientSession === "string" && clientSession !== ClientSession) {
          postTwitchWorkerMessage("UpdateClientSession", (ClientSession = clientSession));
        }
        const integrity = headerGet(headers, "Client-Integrity");
        if (typeof integrity === "string" && integrity !== ClientIntegrityHeader) {
          postTwitchWorkerMessage("UpdateClientIntegrityHeader", (ClientIntegrityHeader = integrity));
        }
        const authorization = headerGet(headers, "Authorization");
        if (typeof authorization === "string" && authorization !== AuthorizationHeader) {
          postTwitchWorkerMessage("UpdateAuthorizationHeader", (AuthorizationHeader = authorization));
        }
        if (typeof init.body === "string" && init.body.includes("PlaybackAccessToken") && isActive()) {
          // The mini player above chat requests its own session (and its own ads).
          if (init.body.includes("picture-by-picture")) {
            init.body = "";
          } else if (settings.forcePopoutToken) {
            try {
              let replacedPlayerType = "";
              const newBody = JSON.parse(init.body);
              const entries = Array.isArray(newBody) ? newBody : [newBody];
              for (const entry of entries) {
                const vars = entry && entry.variables;
                if (vars && vars.playerType && vars.playerType !== "popout") {
                  replacedPlayerType = vars.playerType;
                  vars.playerType = "popout";
                }
              }
              if (replacedPlayerType) {
                console.log(LOG, "requesting main stream as 'popout' instead of '" + replacedPlayerType + "'");
                init.body = JSON.stringify(newBody);
              }
            } catch (_) {}
          }
        }
      }
      const response = realFetch.call(this, url, init, ...args);
      if (init && typeof init.body === "string" && typeof url === "string" && url.includes("gql") && init.body.includes("ClaimCommunityPoints")) {
        relayClaimResult(response);
      }
      return response;
    };
  }

  // ------------------------------------------------------------------
  // Twitch player control via React internals
  // ------------------------------------------------------------------
  function getPlayerAndState() {
    function findReactNode(root, constraint) {
      if (root.stateNode && constraint(root.stateNode)) {
        return root.stateNode;
      }
      let node = root.child;
      while (node) {
        const result = findReactNode(node, constraint);
        if (result) {
          return result;
        }
        node = node.sibling;
      }
      return null;
    }
    function findReactRootNode() {
      let reactRootNode = null;
      const rootNode = document.querySelector("#root");
      if (rootNode && rootNode._reactRootContainer && rootNode._reactRootContainer._internalRoot && rootNode._reactRootContainer._internalRoot.current) {
        reactRootNode = rootNode._reactRootContainer._internalRoot.current;
      }
      if (reactRootNode == null && rootNode != null) {
        const containerName = Object.keys(rootNode).find((x) => x.startsWith("__reactContainer"));
        if (containerName != null) {
          reactRootNode = rootNode[containerName];
        }
      }
      return reactRootNode;
    }
    const reactRootNode = findReactRootNode();
    if (!reactRootNode) {
      return null;
    }
    let player = findReactNode(reactRootNode, (node) => node.setPlayerActive && node.props && node.props.mediaPlayerInstance);
    player = player && player.props && player.props.mediaPlayerInstance ? player.props.mediaPlayerInstance : null;
    if (player && player.playerInstance) {
      player = player.playerInstance;
    }
    const playerState = findReactNode(reactRootNode, (node) => node.setSrc && node.setInitialPlaybackSettings);
    return { player: player, state: playerState };
  }

  const playerBufferState = {
    channelName: null,
    hasStreamStarted: false,
    position: 0,
    bufferedPosition: 0,
    bufferDuration: 0,
    numSame: 0,
    lastFixTime: 0,
    isLive: true,
  };
  let playerForMonitoringBuffering = null;

  function doTwitchPlayerTask(isPausePlay, isReload) {
    const playerAndState = getPlayerAndState();
    if (!playerAndState) {
      console.log(LOG, "could not find React root");
      return;
    }
    const player = playerAndState.player;
    const playerState = playerAndState.state;
    if (!player || !playerState) {
      console.log(LOG, "could not find player");
      return;
    }
    if (player.isPaused() || (player.core && player.core.paused)) {
      return;
    }
    playerBufferState.lastFixTime = Date.now();
    playerBufferState.numSame = 0;
    if (isPausePlay) {
      player.pause();
      player.play();
      return;
    }
    if (isReload) {
      const lsKeyQuality = "video-quality";
      const lsKeyMuted = "video-muted";
      const lsKeyVolume = "volume";
      let currentQualityLS = null;
      let currentMutedLS = null;
      let currentVolumeLS = null;
      try {
        currentQualityLS = localStorage.getItem(lsKeyQuality);
        currentMutedLS = localStorage.getItem(lsKeyMuted);
        currentVolumeLS = localStorage.getItem(lsKeyVolume);
        if (localStorageHookFailed && player.core && player.core.state) {
          localStorage.setItem(lsKeyMuted, JSON.stringify({ default: player.core.state.muted }));
          localStorage.setItem(lsKeyVolume, player.core.state.volume);
        }
        if (localStorageHookFailed && player.core && player.core.state && player.core.state.quality && player.core.state.quality.group) {
          localStorage.setItem(lsKeyQuality, JSON.stringify({ default: player.core.state.quality.group }));
        }
      } catch (_) {}
      console.log(LOG, "reloading Twitch player");
      playerState.setSrc({ isNewMediaPlayerInstance: true, refreshAccessToken: true });
      postTwitchWorkerMessage("TriggeredPlayerReload");
      player.play();
      // Watch for a few seconds after the reload and restore quality if it dropped.
      restoreQualityUntil = Date.now() + 12000;
      if (localStorageHookFailed && (currentQualityLS || currentMutedLS || currentVolumeLS)) {
        setTimeout(() => {
          try {
            if (currentQualityLS) localStorage.setItem(lsKeyQuality, currentQualityLS);
            if (currentMutedLS) localStorage.setItem(lsKeyMuted, currentMutedLS);
            if (currentVolumeLS) localStorage.setItem(lsKeyVolume, currentVolumeLS);
          } catch (_) {}
        }, 3000);
      }
    }
  }

  function monitorPlayerBuffering() {
    if (playerForMonitoringBuffering) {
      try {
        const player = playerForMonitoringBuffering.player;
        const state = playerForMonitoringBuffering.state;
        if (!player.core) {
          playerForMonitoringBuffering = null;
        } else if (
          state.props?.content?.type === "live" &&
          !player.isPaused() &&
          !player.getHTMLVideoElement()?.ended &&
          playerBufferState.lastFixTime <= Date.now() - PlayerBufferingMinRepeatDelay &&
          !isActivelyStrippingAds
        ) {
          const m3u8Url = player.core?.state?.path;
          if (m3u8Url) {
            const fileName = new URL(m3u8Url).pathname.split("/").pop();
            if (fileName?.endsWith(".m3u8")) {
              const channelName = fileName.slice(0, -5);
              if (playerBufferState.channelName != channelName) {
                playerBufferState.channelName = channelName;
                playerBufferState.hasStreamStarted = false;
                playerBufferState.numSame = 0;
              }
            }
          }
          if (player.getState() === "Playing") {
            playerBufferState.hasStreamStarted = true;
          }
          if (AutoQualityRestore && player.getQuality && player.getQualities && player.setQuality) {
            const auto = player.core?.state?.autoQualityMode;
            const q = player.getQuality();
            if (player.getState() === "Playing" && !auto && q && q.group) {
              if (restoreQualityUntil && Date.now() < restoreQualityUntil) {
                if (preferredQualityGroup && q.group !== preferredQualityGroup) {
                  const target = player.getQualities().find((x) => x.group === preferredQualityGroup);
                  if (target) {
                    console.log(LOG, "restoring quality " + q.group + " -> " + preferredQualityGroup + " after reload");
                    player.setQuality(target);
                  }
                  restoreQualityUntil = 0;
                } else if (preferredQualityGroup) {
                  restoreQualityUntil = 0; // already at the preferred quality
                }
              } else {
                // Steady state: remember what the viewer is watching.
                preferredQualityGroup = q.group;
              }
            }
          }
          const position = player.core?.state?.position;
          const bufferedPosition = player.core?.state?.bufferedPosition;
          const bufferDuration = player.getBufferDuration();
          if (position !== undefined && bufferedPosition !== undefined) {
            if (
              playerBufferState.hasStreamStarted &&
              (!PlayerBufferingPrerollCheckEnabled || position > PlayerBufferingPrerollCheckOffset) &&
              (playerBufferState.position == position || bufferDuration < PlayerBufferingDangerZone) &&
              playerBufferState.bufferedPosition == bufferedPosition &&
              playerBufferState.bufferDuration >= bufferDuration &&
              (position != 0 || bufferedPosition != 0 || bufferDuration != 0)
            ) {
              playerBufferState.numSame++;
              if (playerBufferState.numSame == PlayerBufferingSameStateCount) {
                console.log(LOG, "player looks stuck (position " + playerBufferState.position + "), nudging it");
                doTwitchPlayerTask(!PlayerBufferingDoPlayerReload, PlayerBufferingDoPlayerReload);
                playerBufferState.lastFixTime = Date.now();
                playerBufferState.numSame = 0;
              }
            } else {
              playerBufferState.numSame = 0;
            }
            playerBufferState.position = position;
            playerBufferState.bufferedPosition = bufferedPosition;
            playerBufferState.bufferDuration = bufferDuration;
          } else {
            playerBufferState.numSame = 0;
          }
        }
      } catch (err) {
        console.error(LOG, "error while monitoring player buffering: " + err);
        playerForMonitoringBuffering = null;
      }
    }
    if (!playerForMonitoringBuffering && document.querySelector("video")) {
      const playerAndState = getPlayerAndState();
      if (playerAndState && playerAndState.player && playerAndState.state) {
        playerForMonitoringBuffering = { player: playerAndState.player, state: playerAndState.state };
      }
    }
    const isLive = playerForMonitoringBuffering?.state?.props?.content?.type === "live";
    if (playerBufferState.isLive && !isLive) {
      updateAdblockBanner({ hasAds: false });
    }
    playerBufferState.isLive = isLive;
    setTimeout(monitorPlayerBuffering, PlayerBufferingDelay);
  }

  // ------------------------------------------------------------------
  // Banner + status reporting
  // ------------------------------------------------------------------
  function dispatchStatus(status) {
    lastStatus = status;
    try {
      document.dispatchEvent(new CustomEvent("nta:status", { detail: JSON.stringify(status) }));
    } catch (_) {}
  }

  function updateAdblockBanner(data) {
    isActivelyStrippingAds = !!data.isStrippingAdSegments;
    const status = {
      hasAds: !!data.hasAds,
      stripping: !!data.isStrippingAdSegments,
      midroll: !!data.isMidroll,
      backup: data.backupPlayerType || null,
      leaked: !!data.leaked,
      channel: getChannelFromUrl(),
    };
    if (JSON.stringify(status) !== JSON.stringify(lastStatus)) dispatchStatus(status);
    const playerRootDiv = document.querySelector(".video-player");
    if (playerRootDiv == null) return;
    let adBlockDiv = playerRootDiv.querySelector(".nta-overlay");
    if (adBlockDiv == null) {
      adBlockDiv = document.createElement("div");
      adBlockDiv.className = "nta-overlay";
      adBlockDiv.style.cssText = "position:absolute;top:0;left:0;z-index:10;pointer-events:none;display:none";
      const label = document.createElement("p");
      label.style.cssText = "margin:0;color:#fff;background:rgba(0,0,0,.75);padding:4px 8px;font:12px/1.4 system-ui,sans-serif;border-bottom-right-radius:6px";
      adBlockDiv.appendChild(label);
      playerRootDiv.appendChild(adBlockDiv);
    }
    const label = adBlockDiv.firstElementChild;
    label.textContent = "No Twitch Ads: skipping" + (data.isMidroll ? " midroll" : "") + " ad" + (data.isStrippingAdSegments ? " (blanking segments)" : data.backupPlayerType ? " (backup: " + data.backupPlayerType + ")" : "");
    adBlockDiv.style.display = data.hasAds && playerBufferState.isLive && settings.showBanner ? "block" : "none";
  }

  // ------------------------------------------------------------------
  // Keep the player going when the tab is hidden; preserve player prefs
  // ------------------------------------------------------------------
  function onContentLoaded() {
    // Twitch pauses playback for hidden tabs when an ad starts. Pretend we are visible.
    try {
      Object.defineProperty(document, "visibilityState", { get() { return "visible"; } });
    } catch (_) {}
    const hidden = document.__lookupGetter__("hidden");
    const webkitHidden = document.__lookupGetter__("webkitHidden");
    try {
      Object.defineProperty(document, "hidden", { get() { return false; } });
    } catch (_) {}
    const block = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    let wasVideoPlaying = true;
    let latencyTimer = null;
    const visibilityChange = (e) => {
      const isChrome = typeof chrome !== "undefined";
      const videos = document.getElementsByTagName("video");
      if (videos.length > 0) {
        if ((hidden && hidden.apply(document) === true) || (webkitHidden && webkitHidden.apply(document) === true)) {
          wasVideoPlaying = !videos[0].paused && !videos[0].ended;
        } else {
          if (!playerBufferState.hasStreamStarted) {
            playerBufferState.hasStreamStarted = true;
          }
          if (isChrome && wasVideoPlaying && !videos[0].ended && videos[0].paused && videos[0].muted) {
            videos[0].play();
          }
          // Catch back up to live after the tab has been in the background.
          clearTimeout(latencyTimer);
          latencyTimer = setTimeout(() => {
            try {
              if ((hidden && hidden.apply(document) === true) || isActivelyStrippingAds || playerBufferState.lastFixTime > Date.now() - PlayerBufferingMinRepeatDelay) {
                return;
              }
              const playerAndState = playerForMonitoringBuffering || getPlayerAndState();
              const player = playerAndState?.player;
              if (!player?.getLiveLatency || playerAndState.state?.props?.content?.type !== "live") {
                return;
              }
              if (player.getLiveLatency() > (player.isLiveLowLatency?.() ? 5 : 15)) {
                doTwitchPlayerTask(true, false);
              }
            } catch (_) {}
          }, 3000);
        }
      }
      block(e);
    };
    document.addEventListener("visibilitychange", visibilityChange, true);
    document.addEventListener("webkitvisibilitychange", visibilityChange, true);
    document.addEventListener("mozvisibilitychange", visibilityChange, true);
    document.addEventListener("hasFocus", block, true);
    try {
      if (/Firefox/.test(navigator.userAgent)) {
        Object.defineProperty(document, "mozHidden", { get() { return false; } });
      } else {
        Object.defineProperty(document, "webkitHidden", { get() { return false; } });
      }
    } catch (_) {}
    // Player reloads re-read these keys; cache them so quality/volume survive.
    try {
      const keysToCache = ["video-quality", "video-muted", "volume", "lowLatencyModeEnabled", "persistenceEnabled"];
      const cachedValues = new Map();
      for (const key of keysToCache) {
        cachedValues.set(key, localStorage.getItem(key));
      }
      const realSetItem = localStorage.setItem;
      localStorage.setItem = function (key, value) {
        if (cachedValues.has(key)) {
          cachedValues.set(key, value);
        }
        realSetItem.apply(this, arguments);
      };
      const realGetItem = localStorage.getItem;
      localStorage.getItem = function (key) {
        if (cachedValues.has(key)) {
          return cachedValues.get(key);
        }
        return realGetItem.apply(this, arguments);
      };
      if (!localStorage.getItem.toString().includes("cachedValues")) {
        // Firefox does not allow replacing localStorage methods.
        localStorageHookFailed = true;
      }
    } catch (err) {
      localStorageHookFailed = true;
    }
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  window.__noTwitchAds = {
    version: NTA_VERSION,
    realFetch: window.fetch.bind(window),
    settings,
    getStatus: () => lastStatus,
    reloadPlayer: () => doTwitchPlayerTask(false, true),
    // Debug: simulateAds(1) treats every playlist as an ad break and uses the
    // backup session at that depth (1 = embed, 2 = popout, 3 = 360p). 0 = off.
    simulateAds: (depth) => postTwitchWorkerMessage("SimulateAds", Math.max(0, depth | 0)),
    allSegmentsAreAdSegments: () => postTwitchWorkerMessage("AllSegmentsAreAdSegments"),
    _internal: { declareOptions, parseAttributes, getServerTimeFromM3u8, replaceServerTimeInM3u8, stripAdSegments, getStreamUrlForResolution, hasUnblankedAdSegment, processM3U8, buildWorkerPrelude, getChannelFromUrl },
  };

  hookWindowWorker();
  hookFetch();
  if (PlayerBufferingFix) {
    monitorPlayerBuffering();
  }
  if (document.readyState === "complete" || document.readyState === "interactive") {
    onContentLoaded();
  } else {
    window.addEventListener("DOMContentLoaded", onContentLoaded);
  }
  document.dispatchEvent(new CustomEvent("nta:request-settings"));
  console.log(LOG, "v" + NTA_VERSION + " active");
})();
