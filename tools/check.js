// Offline sanity checks for the worker-side playlist logic in src/page.js.
// Run: node tools/check.js
//
// Loads page.js in a sandbox with a fake window/document, pulls the worker
// functions out via window.__noTwitchAds._internal, and runs them against
// playlists captured from twitch.tv (2026-10-01) plus a synthetic ad break.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "page.js"), "utf8");
assert(!source.includes("__BLANK_MP4_B64__"), "blank MP4 placeholder was not replaced");

// ---- minimal browser-ish sandbox ----
const listeners = {};
const dispatched = []; // CustomEvents page.js sends to the content script
let nextFetchResponse = null; // lets a test stand in for Twitch's reply
const document = {
  readyState: "loading",
  addEventListener: (name, fn) => ((listeners[name] = listeners[name] || []).push(fn)),
  dispatchEvent: (event) => (dispatched.push(event), true),
  querySelector: () => null,
  __lookupGetter__: () => undefined,
};
class FakeWorker {
  constructor() {}
  postMessage() {}
  addEventListener() {}
}
const window = {
  Worker: FakeWorker,
  fetch: async () => nextFetchResponse || { status: 200, text: async () => "", headers: new Map() },
  addEventListener: () => {},
  location: { href: "https://www.twitch.tv/faide" },
};
const sandbox = {
  window,
  document,
  location: window.location,
  console,
  setTimeout: () => 0,
  clearTimeout: () => {},
  CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
  URL,
  Response: class Response { constructor(body, init) { this.body = body; this.status = (init && init.status) || 200; } async text() { return this.body; } async json() { return JSON.parse(this.body); } },
  Blob: class Blob { constructor(parts) { this.parts = parts; } },
  localStorage: { getItem: () => null, setItem: () => {} },
  navigator: { userAgent: "node" },
  chrome: undefined,
};
sandbox.self = sandbox; // so declareOptions(self) works
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "page.js" });

const nta = window.__noTwitchAds;
assert(nta && nta._internal, "page.js did not expose internals");
const I = nta._internal;

// Worker globals live on `self`; set them up exactly like the worker does.
I.declareOptions(sandbox);
sandbox.pendingFetchRequests = new Map();

// ---- captured master playlist (usher v2 format, 2026-10-01) ----
const masterV2 = [
  "#EXTM3U",
  '#EXT-X-SESSION-DATA:DATA-ID="NODE",VALUE="7325bab210ad.j.cloudfront.hls.ttvnw.net"',
  '#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="1790884138.07"',
  '#EXT-X-SESSION-DATA:DATA-ID="USER-COUNTRY",VALUE="GB"',
  '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="1440p60",NAME="1440p60",AUTOSELECT=YES,DEFAULT=YES',
  '#EXT-X-STREAM-INF:BANDWIDTH=9586583,RESOLUTION=2560x1440,CODECS="hev1.1.6.L150.90.0.0.0.0.0,mp4a.40.2",VIDEO="1440p60",FRAME-RATE=60.000',
  "https://euw13.playlist.ttvnw.net/v1/playlist/AAAA.m3u8",
  '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="1080p60",NAME="1080p60",AUTOSELECT=YES,DEFAULT=YES',
  '#EXT-X-STREAM-INF:BANDWIDTH=8042999,RESOLUTION=1920x1080,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="1080p60",FRAME-RATE=60.000',
  "https://euw13.playlist.ttvnw.net/v1/playlist/BBBB.m3u8",
  '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="720p60",NAME="720p60",AUTOSELECT=YES,DEFAULT=YES',
  '#EXT-X-STREAM-INF:BANDWIDTH=3322199,RESOLUTION=1280x720,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="720p60",FRAME-RATE=60.000',
  "https://euw13.playlist.ttvnw.net/v1/playlist/CCCC.m3u8",
  '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="160p30",NAME="160p30",AUTOSELECT=YES,DEFAULT=YES',
  '#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=284x160,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="160p30",FRAME-RATE=30.000',
  "https://euw13.playlist.ttvnw.net/v1/playlist/DDDD.m3u8",
].join("\n");

// ---- captured v1 master header (usher v1 format, 2026-10-01) ----
const masterV1Head = '#EXTM3U\n#EXT-X-TWITCH-INFO:NODE="x",SERVER-TIME="1790884137.36",USER-COUNTRY="GB"\n';

// ---- captured media playlist (no ad), trimmed ----
const liveMedia = [
  "#EXTM3U",
  "#EXT-X-VERSION:6",
  "#EXT-X-TARGETDURATION:6",
  "#EXT-X-MEDIA-SEQUENCE:8378",
  '#EXT-X-DATERANGE:ID="playlist-session-1790884138",CLASS="twitch-session",START-DATE="2026-10-01T19:48:58.345Z",END-ON-NEXT=YES,X-TV-TWITCH-SESSIONID="8127737990597563640"',
  '#EXT-X-DATERANGE:ID="source-1790884108",CLASS="twitch-stream-source",START-DATE="2026-10-01T19:48:28.580Z",END-ON-NEXT=YES,X-TV-TWITCH-STREAM-SOURCE="live"',
  '#EXT-X-MAP:URI="https://7325bab210ad.j.cloudfront.hls.ttvnw.net/v1/segment/INIT.mp4"',
  "#EXTINF:2.000,live",
  "https://7325bab210ad.j.cloudfront.hls.ttvnw.net/v1/segment/S1.mp4",
  "#EXTINF:2.000,live",
  "https://7325bab210ad.j.cloudfront.hls.ttvnw.net/v1/segment/S2.mp4",
  "#EXT-X-TWITCH-PREFETCH:https://7325bab210ad.j.cloudfront.hls.ttvnw.net/v1/segment/S3.mp4",
].join("\n");

// ---- ad break, shaped like the midroll captured live on twitch.tv/faide at
// 2026-10-01T19:57:20Z (tags and attribute names verbatim, values shortened) ----
const adMedia = [
  "#EXTM3U",
  "#EXT-X-VERSION:6",
  "#EXT-X-TARGETDURATION:6",
  "#EXT-X-MEDIA-SEQUENCE:2850",
  "#EXT-X-TWITCH-LIVE-SEQUENCE:2850",
  '#EXT-X-DATERANGE:ID="playlist-session-1790884577",CLASS="twitch-session",START-DATE="2026-10-01T19:56:17.091Z",END-ON-NEXT=YES,X-TV-TWITCH-SESSIONID="7118666334057774101"',
  '#EXT-X-DATERANGE:ID="source-1790884546",CLASS="twitch-stream-source",START-DATE="2026-10-01T19:55:46.377Z",END-ON-NEXT=YES,X-TV-TWITCH-STREAM-SOURCE="live"',
  '#EXT-X-MAP:URI="https://7dba300ff494.j.cloudfront.hls.ttvnw.net/v1/segment/INIT.mp4"',
  "#EXT-X-PROGRAM-DATE-TIME:2026-10-01T19:57:16.377Z",
  "#EXTINF:2.000,live",
  "https://7dba300ff494.j.cloudfront.hls.ttvnw.net/v1/segment/S8.mp4",
  "#EXT-X-PROGRAM-DATE-TIME:2026-10-01T19:57:18.377Z",
  "#EXTINF:2.000,live",
  "https://7dba300ff494.j.cloudfront.hls.ttvnw.net/v1/segment/S9.mp4",
  '#EXT-X-DATERANGE:ID="stitched-ad-1790884640-30235000000",CLASS="twitch-stitched-ad",START-DATE="2026-10-01T19:57:20.377Z",DURATION=30.235,X-TV-TWITCH-AD-POD-LENGTH="6",X-TV-TWITCH-AD-ROLL-TYPE="MIDROLL",X-TV-TWITCH-AD-URL="https://advertiser.example/landing",X-TV-TWITCH-AD-CLICK-BEACON-ID="click3d5d4d58_fake",X-TV-TWITCH-AD-CREATIVE-ID="2474283100494",X-TV-TWITCH-AD-CLICK-TRACKING-URL="https://tracking.example/click",X-TV-TWITCH-AD-AD-FORMAT="standard_video_ad",X-TV-TWITCH-AD-POD-POSITION="0",X-TV-TWITCH-AD-POD-FILLED-DURATION="180"',
  '#EXT-X-DATERANGE:ID="source-1790884640",CLASS="twitch-stream-source",START-DATE="2026-10-01T19:57:20.377Z",END-ON-NEXT=YES,X-TV-TWITCH-STREAM-SOURCE="Amazon|2474283100494"',
  '#EXT-X-DATERANGE:ID="quartile-1790884640-0",CLASS="twitch-ad-quartile",START-DATE="2026-10-01T19:57:20.377Z",DURATION=2.000,X-TV-TWITCH-AD-QUARTILE="0"',
  "#EXT-X-DISCONTINUITY",
  "#EXT-X-PROGRAM-DATE-TIME:2026-10-01T19:57:20.377Z",
  "#EXTINF:2.000,Amazon|2474283100494",
  "https://ads.example/AD1.mp4",
  "#EXT-X-PROGRAM-DATE-TIME:2026-10-01T19:57:22.377Z",
  "#EXTINF:2.000,Amazon|2474283100494",
  "https://ads.example/AD2.mp4",
  "#EXT-X-TWITCH-PREFETCH:https://ads.example/AD3.mp4",
].join("\n");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("ok   -", name);
  } catch (err) {
    console.log("FAIL -", name);
    console.log("      ", err.message);
    process.exitCode = 1;
  }
}

test("parseAttributes reads RESOLUTION / CODECS / FRAME-RATE", () => {
  const a = I.parseAttributes('#EXT-X-STREAM-INF:BANDWIDTH=8042999,RESOLUTION=1920x1080,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="1080p60",FRAME-RATE=60.000');
  assert.strictEqual(a.RESOLUTION, "1920x1080");
  assert.strictEqual(a.CODECS, "avc1.4D401F,mp4a.40.2");
  assert.strictEqual(a["FRAME-RATE"], 60);
});

test("server time: v2 session-data format", () => {
  sandbox.V2API = true;
  assert.strictEqual(I.getServerTimeFromM3u8(masterV2), "1790884138.07");
  const replaced = I.replaceServerTimeInM3u8(masterV2, "1790884999.99");
  assert(replaced.includes('DATA-ID="SERVER-TIME",VALUE="1790884999.99"'));
});

test("server time: v1 TWITCH-INFO format", () => {
  sandbox.V2API = false;
  assert.strictEqual(I.getServerTimeFromM3u8(masterV1Head), "1790884137.36");
  assert(I.replaceServerTimeInM3u8(masterV1Head, "1").includes('SERVER-TIME="1"'));
});

test("server time: missing SERVER-TIME does not throw (fork fix)", () => {
  sandbox.V2API = true;
  assert.strictEqual(I.getServerTimeFromM3u8("#EXTM3U\n"), null);
  assert.strictEqual(I.replaceServerTimeInM3u8("#EXTM3U\n", null), "#EXTM3U\n");
});

test("getStreamUrlForResolution prefers exact resolution + framerate, else closest", () => {
  assert.strictEqual(I.getStreamUrlForResolution(masterV2, { Resolution: "1920x1080", FrameRate: 60 }), "https://euw13.playlist.ttvnw.net/v1/playlist/BBBB.m3u8");
  assert.strictEqual(I.getStreamUrlForResolution(masterV2, { Resolution: "852x480", FrameRate: 30 }), "https://euw13.playlist.ttvnw.net/v1/playlist/DDDD.m3u8");
});

test("stripAdSegments leaves a clean live playlist untouched", () => {
  const info = { NumStrippedAdSegments: 0, IsStrippingAdSegments: false };
  const out = I.stripAdSegments(liveMedia, false, info);
  assert.strictEqual(out, liveMedia);
  assert.strictEqual(info.IsStrippingAdSegments, false);
  assert.strictEqual(sandbox.AdSegmentCache.size, 0);
});

test("stripAdSegments marks ad segments, keeps live ones, drops prefetch, neuters tracking URLs", () => {
  const info = { NumStrippedAdSegments: 0, IsStrippingAdSegments: false };
  const out = I.stripAdSegments(adMedia, false, info);
  assert.strictEqual(info.IsStrippingAdSegments, true);
  assert.strictEqual(info.NumStrippedAdSegments, 2);
  assert(sandbox.AdSegmentCache.has("https://ads.example/AD1.mp4"));
  assert(sandbox.AdSegmentCache.has("https://ads.example/AD2.mp4"));
  assert(!sandbox.AdSegmentCache.has("https://7dba300ff494.j.cloudfront.hls.ttvnw.net/v1/segment/S9.mp4"), "live segment must not be blanked");
  assert(!out.includes("#EXT-X-TWITCH-PREFETCH"), "prefetch hint should be removed during ads");
  assert(!out.includes("advertiser.example"), "ad URL should be rewritten (fork fix: write-back)");
  assert(!out.includes("tracking.example"), "click tracking URL should be rewritten");
  assert(out.includes("https://7dba300ff494.j.cloudfront.hls.ttvnw.net/v1/segment/S9.mp4"), "live segment must survive");
  assert(out.includes("#EXT-X-DISCONTINUITY"), "discontinuity marker must survive");
});

test("hasUnblankedAdSegment: clean live playlist has no leak", () => {
  assert.strictEqual(I.hasUnblankedAdSegment(liveMedia), false);
});

test("hasUnblankedAdSegment: raw ad playlist is a leak until its segments are blanked", () => {
  // A fresh ad playlist whose ad segments are not yet cached counts as a leak.
  sandbox.AdSegmentCache.clear();
  assert.strictEqual(I.hasUnblankedAdSegment(adMedia), true);
  // After stripping caches the ad segments, the same playlist no longer leaks.
  I.stripAdSegments(adMedia, false, { NumStrippedAdSegments: 0, IsStrippingAdSegments: false });
  assert.strictEqual(I.hasUnblankedAdSegment(adMedia), false);
});

test("processM3U8: unknown playlist passes through", async () => {
  const out = await I.processM3U8("https://nowhere/x.m3u8", adMedia, async () => ({ status: 404 }));
  assert.strictEqual(out, adMedia);
});

test("processM3U8: swaps to an ad-free backup session during an ad break", async () => {
  // Register the stream like the usher hook does.
  const variantUrl = "https://euw13.playlist.ttvnw.net/v1/playlist/BBBB.m3u8";
  const streamInfo = {
    ChannelName: "faide", IsShowingAd: false, LastPlayerReload: 0, EncodingsM3U8: masterV2, ModifiedM3U8: null,
    IsUsingModifiedM3U8: false, UsherParams: "?allow_source=true", RequestedAds: new Set(),
    Urls: { [variantUrl]: { Resolution: "1920x1080", FrameRate: 60, Codecs: "avc1.4D401F,mp4a.40.2", Url: variantUrl } },
    ResolutionList: [], BackupEncodingsM3U8Cache: {}, ActiveBackupPlayerType: null, IsMidroll: false,
    IsStrippingAdSegments: false, NumStrippedAdSegments: 0,
  };
  sandbox.StreamInfos.faide = streamInfo;
  sandbox.StreamInfosByUrl[variantUrl] = streamInfo;
  sandbox.V2API = true;
  const posted = [];
  sandbox.postMessage = (m) => {
    posted.push(m);
    // Emulate the page answering the GQL relay with a token.
    if (m.key === "FetchRequest") {
      const body = JSON.parse(m.value.options.body);
      assert.strictEqual(body.operationName, "PlaybackAccessToken");
      assert.strictEqual(body.variables.playerType, "embed");
      assert.strictEqual(body.variables.platform, "web");
      const { resolve } = sandbox.pendingFetchRequests.get(m.value.id);
      sandbox.pendingFetchRequests.delete(m.value.id);
      resolve(new sandbox.Response(JSON.stringify({ data: { streamPlaybackAccessToken: { value: "TOKEN", signature: "SIG" } } }), { status: 200 }));
    }
  };
  const fetched = [];
  const backupMaster = masterV2.replaceAll("euw13", "euw12");
  const realFetch = async (url) => {
    fetched.push(url);
    if (url.startsWith("https://usher.ttvnw.net/api/v2/channel/hls/faide.m3u8")) {
      assert(url.includes("sig=SIG") && url.includes("token=TOKEN"));
      return new sandbox.Response(backupMaster, { status: 200 });
    }
    if (url === "https://euw12.playlist.ttvnw.net/v1/playlist/BBBB.m3u8") return new sandbox.Response(liveMedia, { status: 200 });
    return new sandbox.Response("", { status: 404 });
  };
  return (async () => {
    const out = await I.processM3U8(variantUrl, adMedia, realFetch);
    assert.strictEqual(out, liveMedia, "player should receive the clean backup playlist");
    assert.strictEqual(streamInfo.IsShowingAd, true);
    assert.strictEqual(streamInfo.IsMidroll, true);
    assert.strictEqual(streamInfo.ActiveBackupPlayerType, "embed");
    assert(posted.some((m) => m.key === "UpdateAdBlockBanner" && m.hasAds === true));
    // Ad break ends: next clean playlist resets state and nudges the player.
    const after = await I.processM3U8(variantUrl, liveMedia, realFetch);
    assert.strictEqual(after, liveMedia);
    assert.strictEqual(streamInfo.IsShowingAd, false);
    assert(posted.some((m) => m.key === "PauseResumePlayer"));
  })().then(() => { passed++; console.log("ok   - processM3U8 backup swap (async)"); }, (err) => { console.log("FAIL - processM3U8 backup swap (async)\n      ", err.message); process.exitCode = 1; });
});

test("worker prelude builds and parses as JavaScript", () => {
  const prelude = I.buildWorkerPrelude({ Enabled: true, Whitelist: [], BackupPlayerTypes: ["embed"], GQLDeviceID: null });
  new vm.Script(prelude, { filename: "worker-prelude.js" }); // throws on syntax error
  assert(prelude.includes("workerMain("));
  assert(prelude.includes("data:video/mp4;base64,AAAA"));
});

test("getChannelFromUrl handles normal, popout, moderator and non-channel paths", () => {
  const g = I.getChannelFromUrl;
  window.location.href = "https://www.twitch.tv/Faide?x=1"; assert.strictEqual(g(), "faide");
  window.location.href = "https://www.twitch.tv/popout/faide/chat"; assert.strictEqual(g(), "faide");
  window.location.href = "https://www.twitch.tv/moderator/faide"; assert.strictEqual(g(), "faide");
  window.location.href = "https://www.twitch.tv/directory/category/x"; assert.strictEqual(g(), null);
  window.location.href = "https://player.twitch.tv/?channel=Faide&parent=x"; assert.strictEqual(g(), "faide");
});

// Captured live 2026-10-02 on twitch.tv/Mammoth: the reply to a Claim Bonus click.
const claimReply = (claimCommunityPoints) => ({ status: 200, clone() { return this; }, json: async () => [{ data: { claimCommunityPoints } }] });
const claimRequest = JSON.stringify([{ operationName: "ClaimCommunityPoints", variables: { input: { channelID: "65425478", claimID: "1cceedfe" } } }]);
const claimEvents = () => dispatched.filter((e) => e.type === "nta:claim-result").map((e) => JSON.parse(e.detail));
const settle = () => new Promise((resolve) => setImmediate(resolve));

(async () => {
  try {
    dispatched.length = 0;
    nextFetchResponse = claimReply({ claim: { id: "1cceedfe", multipliers: [], pointsEarnedBaseline: 50, pointsEarnedTotal: 50 }, currentPoints: 160, error: null });
    await window.fetch("https://gql.twitch.tv/gql", { method: "POST", body: claimRequest });
    await settle();
    assert.deepStrictEqual(claimEvents(), [{ claimId: "1cceedfe", points: 50, balance: 160, error: null }]);

    dispatched.length = 0;
    nextFetchResponse = claimReply({ claim: null, currentPoints: 0, error: { code: "CLAIM_ALREADY_CLAIMED" } });
    await window.fetch("https://gql.twitch.tv/gql", { method: "POST", body: claimRequest });
    await settle();
    assert.deepStrictEqual(claimEvents(), [{ claimId: null, points: 0, balance: 0, error: "CLAIM_ALREADY_CLAIMED" }]);

    // Other GQL traffic, and non-GQL URLs, must never produce a claim event.
    dispatched.length = 0;
    nextFetchResponse = claimReply({ claim: { id: "x", pointsEarnedTotal: 50 }, currentPoints: 1, error: null });
    await window.fetch("https://gql.twitch.tv/gql", { method: "POST", body: JSON.stringify([{ operationName: "ChannelPointsContext" }]) });
    await window.fetch("https://example.com/other", { method: "POST", body: claimRequest });
    await settle();
    assert.deepStrictEqual(claimEvents(), []);

    // A reply that is not JSON must not break the page's own request.
    nextFetchResponse = { status: 200, clone() { return this; }, json: async () => { throw new Error("not json"); } };
    const res = await window.fetch("https://gql.twitch.tv/gql", { method: "POST", body: claimRequest });
    assert.strictEqual(res.status, 200);
    passed++;
    console.log("ok   - claim relay reports Twitch's claim reply (accepted, refused) and ignores everything else");
  } catch (err) {
    console.log("FAIL - claim relay");
    console.log("      ", err.message);
    process.exitCode = 1;
  } finally {
    nextFetchResponse = null;
  }
})();

setTimeout(() => {
  console.log(process.exitCode ? "\nSome checks FAILED" : "\nAll checks passed");
}, 150);
