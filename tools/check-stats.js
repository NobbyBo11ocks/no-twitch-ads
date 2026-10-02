// Offline checks for the lifetime stats / channel-point claim counter.
// Run: node tools/check-stats.js [path/to/content.js]
//
// Loads the real src/content.js (one instance per simulated tab) and
// src/background.js against a fake chrome.* API with ONE shared storage area and
// a virtual clock, then drives claim buttons the way Twitch does.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const root = path.join(__dirname, "..");
const contentSource = fs.readFileSync(process.argv[2] || path.join(root, "src", "content.js"), "utf8");
const backgroundSource = fs.readFileSync(path.join(root, "src", "background.js"), "utf8");

const flush = () => new Promise((resolve) => setImmediate(resolve));

// ---- virtual clock shared by every simulated context ----
function makeClock() {
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms = 0) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn, every: 0 });
      return id;
    },
    setInterval(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn, every: ms });
      return id;
    },
    clear: (id) => timers.delete(id),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        let nextId = null;
        for (const [id, t] of timers) if (t.at <= end && (nextId === null || t.at < timers.get(nextId).at)) nextId = id;
        if (nextId === null) break;
        const t = timers.get(nextId);
        now = Math.max(now, t.at);
        if (t.every) t.at += t.every;
        else timers.delete(nextId);
        t.fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

// ---- fake extension runtime: shared storage + message bus ----
function makeBrowser(clock) {
  const data = { local: {}, sync: {} };
  const messageListeners = [];
  const area = (name) => ({
    async get(keys) {
      const store = data[name];
      if (keys == null) return { ...store };
      if (typeof keys === "string") keys = [keys];
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
      return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in store ? structuredClone(store[k]) : d]));
    },
    async set(patch) {
      Object.assign(data[name], structuredClone(patch));
    },
  });
  return {
    data,
    clock,
    messageListeners,
    chrome(sender) {
      return {
        storage: { local: area("local"), sync: area("sync"), onChanged: { addListener() {} } },
        runtime: {
          id: "test",
          onInstalled: { addListener() {} },
          onMessage: { addListener: (fn) => messageListeners.push(fn) },
          getManifest: () => ({ version: "test" }),
          sendMessage(message) {
            return new Promise((resolve) => {
              let async = false;
              for (const listener of messageListeners) {
                const result = listener(structuredClone(message), sender, resolve);
                if (result === true) async = true;
              }
              if (!async) resolve(undefined);
            });
          },
        },
        action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
      };
    },
  };
}

// ---- fake Twitch claim button ----
// Like the real thing (captured live): Twitch answers the click with a
// ClaimCommunityPoints reply ({ points, error }), then removes the button.
// result = null simulates a reply we never see; accepts = false a dead click.
function makeClaimButton({ latencyMs = 800, accepts = true, clock, result = { points: 50, error: null } } = {}) {
  const state = { claimable: true, connected: true, clicks: 0 };
  const icon = { closest: () => button };
  const button = {
    get isConnected() { return state.connected; },
    matches: () => false,
    querySelector: (sel) => (state.claimable && sel === ".claimable-bonus__icon" ? icon : null),
    closest: () => button,
    click() {
      state.clicks++;
      if (!accepts) return;
      clock.setTimeout(() => {
        if (result && item.emit) item.emit(result);
        state.claimable = false;
        state.connected = false;
      }, latencyMs);
    },
  };
  const item = { button, icon, state, emit: null };
  return item;
}

// ---- one simulated Twitch tab running src/content.js ----
function makeTab(browser, { channel = "mammoth", claimable = [] } = {}) {
  const { clock } = browser;
  const queue = [...claimable];
  const listeners = {};
  const document = {
    addEventListener: (name, fn) => ((listeners[name] = listeners[name] || []).push(fn)),
    dispatchEvent: () => true,
    querySelector: (sel) => {
      const next = queue.find((item) => item.state.claimable && item.state.connected);
      return next && sel === ".claimable-bonus__icon" ? next.icon : null;
    },
  };
  const attach = (item) => {
    item.emit = (detail) => (listeners["nta:claim-result"] || []).forEach((fn) => fn({ detail: JSON.stringify(detail) }));
  };
  queue.forEach(attach);
  const window = { location: { href: "https://www.twitch.tv/" + channel } };
  window.top = window;
  const logs = [];
  const sandbox = {
    window, document, console: { log: (...a) => logs.push(a.join(" ")), warn() {}, error() {} },
    location: window.location, URL, Math, JSON, Promise, WeakMap, WeakSet, Object, Number, Date: { now: clock.now },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    setTimeout: clock.setTimeout, setInterval: clock.setInterval, clearTimeout: clock.clear, clearInterval: clock.clear,
    chrome: browser.chrome({ tab: { id: Math.floor(Math.random() * 1000) } }),
  };
  vm.createContext(sandbox);
  vm.runInContext(contentSource, sandbox, { filename: "content.js" });
  return {
    logs,
    addClaim: (item) => {
      attach(item);
      queue.push(item);
    },
    status: (detail) => listeners["nta:status"].forEach((fn) => fn({ detail: JSON.stringify(detail) })),
  };
}

function startBackground(browser) {
  const sandbox = { console, Promise, Object, Number, Math, Date: { now: browser.clock.now }, chrome: browser.chrome({}), setTimeout: browser.clock.setTimeout };
  vm.createContext(sandbox);
  vm.runInContext(backgroundSource, sandbox, { filename: "background.js" });
}

function freshWorld({ seedStats, legacyStats } = {}) {
  const clock = makeClock();
  const browser = makeBrowser(clock);
  if (seedStats) browser.data.local.stats = { adsSkipped: 0, pointsClaimed: 0, pointsEarned: 0, timeSavedMs: 0, blanked: 0, leaks: 0, ...seedStats };
  if (legacyStats) browser.data.local.stats = { ...legacyStats }; // stored by a version that had no pointsEarned
  browser.data.sync = { autoClaimPoints: true };
  startBackground(browser);
  return { clock, browser };
}

const stat = (browser, key) => (browser.data.local.stats || {})[key] || 0;
const POLL = 3000;

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("ok   -", name);
  } catch (err) {
    console.log("FAIL -", name);
    console.log("      ", err.message);
    process.exitCode = 1;
  }
}

(async () => {
  await test("a claim Twitch accepts is counted exactly once", async () => {
    const { clock, browser } = freshWorld({ seedStats: { pointsClaimed: 3 } });
    const claim = makeClaimButton({ clock });
    const tab = makeTab(browser, { claimable: [claim] });
    await clock.advance(POLL * 3);
    assert.strictEqual(claim.state.clicks, 1);
    assert.strictEqual(stat(browser, "pointsClaimed"), 4);
    assert.strictEqual(stat(browser, "pointsEarned"), 50, "the bonus was worth 50 points");
    await clock.advance(60_000); // nothing more to claim
    assert.strictEqual(stat(browser, "pointsClaimed"), 4);
    assert.strictEqual(stat(browser, "pointsEarned"), 50);
    assert(tab.logs.some((l) => l.includes("claimed channel points bonus") && l.includes("+50")));
  });

  await test("points earned are exactly what Twitch reports (multiplied bonuses, several claims)", async () => {
    const { clock, browser } = freshWorld({ seedStats: { pointsClaimed: 1, pointsEarned: 50 } });
    const tab = makeTab(browser, { claimable: [makeClaimButton({ clock, result: { points: 75, error: null } })] });
    await clock.advance(POLL * 3);
    assert.strictEqual(stat(browser, "pointsEarned"), 125);
    await clock.advance(15 * 60_000);
    tab.addClaim(makeClaimButton({ clock, result: { points: 50, error: null } }));
    await clock.advance(POLL * 3);
    assert.strictEqual(stat(browser, "pointsClaimed"), 3);
    assert.strictEqual(stat(browser, "pointsEarned"), 175);
  });

  await test("a claim Twitch refuses is not counted, even though the button disappears", async () => {
    const { clock, browser } = freshWorld({ seedStats: { pointsClaimed: 3, pointsEarned: 150 } });
    makeTab(browser, { claimable: [makeClaimButton({ clock, result: { points: 0, error: "CLAIM_ALREADY_CLAIMED" } })] });
    await clock.advance(POLL * 4);
    assert.strictEqual(stat(browser, "pointsClaimed"), 3);
    assert.strictEqual(stat(browser, "pointsEarned"), 150);
  });

  await test("two tabs on one channel: Twitch accepts one claim and refuses the other, points counted once", async () => {
    const { clock, browser } = freshWorld({ seedStats: { pointsClaimed: 3, pointsEarned: 150 } });
    makeTab(browser, { channel: "mammoth", claimable: [makeClaimButton({ clock, result: { points: 50, error: null } })] });
    makeTab(browser, { channel: "mammoth", claimable: [makeClaimButton({ clock, result: { points: 0, error: "CLAIM_ALREADY_CLAIMED" } })] });
    await clock.advance(POLL * 4);
    assert.strictEqual(stat(browser, "pointsClaimed"), 4);
    assert.strictEqual(stat(browser, "pointsEarned"), 200);
  });

  await test("button gone but no reply seen: the claim is counted, its points are not guessed", async () => {
    const { clock, browser } = freshWorld({ seedStats: { pointsClaimed: 3, pointsEarned: 150 } });
    const tab = makeTab(browser, { claimable: [makeClaimButton({ clock, result: null })] });
    await clock.advance(POLL * 4);
    assert.strictEqual(stat(browser, "pointsClaimed"), 4);
    assert.strictEqual(stat(browser, "pointsEarned"), 150);
    assert(tab.logs.some((l) => l.includes("value unknown")));
  });

  await test("claims recorded before points existed are credited at 50 each, once", async () => {
    const { clock, browser } = freshWorld({ legacyStats: { adsSkipped: 4, pointsClaimed: 3, timeSavedMs: 1000, blanked: 0, leaks: 0 } });
    makeTab(browser, { claimable: [makeClaimButton({ clock, result: { points: 50, error: null } })] });
    await clock.advance(POLL * 3);
    assert.strictEqual(stat(browser, "pointsClaimed"), 4);
    assert.strictEqual(stat(browser, "pointsEarned"), 3 * 50 + 50);
    const send = (delta) => browser.chrome({}).runtime.sendMessage({ type: "nta:stats", delta });
    await send({ adsSkipped: 1 });
    await send({ adsSkipped: 1 });
    assert.strictEqual(stat(browser, "pointsEarned"), 200, "migration must not repeat");
  });

  await test("a click Twitch ignores is NOT counted (and is retried a bounded number of times)", async () => {
    const { clock, browser } = freshWorld({ seedStats: { pointsClaimed: 3 } });
    const claim = makeClaimButton({ clock, accepts: false });
    makeTab(browser, { claimable: [claim] });
    await clock.advance(5 * 60_000);
    assert.strictEqual(stat(browser, "pointsClaimed"), 3, "unconfirmed clicks must not be counted");
    assert(claim.state.clicks >= 1 && claim.state.clicks <= 3, "retries are bounded, got " + claim.state.clicks);
  });

  await test("a bonus that vanishes before our click is not counted (another tab/device took it)", async () => {
    const { clock, browser } = freshWorld({ seedStats: { pointsClaimed: 3 } });
    const claim = makeClaimButton({ clock });
    makeTab(browser, { claimable: [claim] });
    await clock.advance(POLL); // poll sees the button, click is pending
    claim.state.claimable = false;
    claim.state.connected = false;
    await clock.advance(30_000);
    assert.strictEqual(claim.state.clicks, 0);
    assert.strictEqual(stat(browser, "pointsClaimed"), 3);
  });

  await test("auto-claim switched off: no click, no count", async () => {
    const { clock, browser } = freshWorld({ seedStats: { pointsClaimed: 3 } });
    browser.data.sync.autoClaimPoints = false;
    const claim = makeClaimButton({ clock });
    makeTab(browser, { claimable: [claim] });
    await clock.advance(60_000);
    assert.strictEqual(claim.state.clicks, 0);
    assert.strictEqual(stat(browser, "pointsClaimed"), 3);
  });

  await test("two tabs open on different channels each count their own claim", async () => {
    const { clock, browser } = freshWorld({ seedStats: { pointsClaimed: 3 } });
    makeTab(browser, { channel: "mammoth", claimable: [makeClaimButton({ clock })] });
    makeTab(browser, { channel: "xqc", claimable: [makeClaimButton({ clock })] });
    await clock.advance(POLL * 4);
    assert.strictEqual(stat(browser, "pointsClaimed"), 5, "3 + one per channel");
  });

  await test("same bonus claimed from two tabs on one channel counts once", async () => {
    const { clock, browser } = freshWorld({ seedStats: { pointsClaimed: 3 } });
    makeTab(browser, { channel: "mammoth", claimable: [makeClaimButton({ clock })] });
    makeTab(browser, { channel: "mammoth", claimable: [makeClaimButton({ clock })] }); // popout chat etc.
    await clock.advance(POLL * 4);
    assert.strictEqual(stat(browser, "pointsClaimed"), 4);
    assert.strictEqual(stat(browser, "pointsEarned"), 50, "points must not be double counted either");
  });

  await test("a later bonus on the same channel (15 min on) is counted again", async () => {
    const { clock, browser } = freshWorld({ seedStats: { pointsClaimed: 3 } });
    const tab = makeTab(browser, { claimable: [makeClaimButton({ clock })] });
    await clock.advance(POLL * 3);
    assert.strictEqual(stat(browser, "pointsClaimed"), 4);
    await clock.advance(15 * 60_000);
    tab.addClaim(makeClaimButton({ clock }));
    await clock.advance(POLL * 3);
    assert.strictEqual(stat(browser, "pointsClaimed"), 5);
  });

  await test("stale tabs cannot overwrite each other's counters", async () => {
    const { clock, browser } = freshWorld({ seedStats: { pointsClaimed: 3, adsSkipped: 4 } });
    const a = makeTab(browser, { channel: "mammoth" }); // loaded while stats were 3 / 4
    const b = makeTab(browser, { channel: "xqc", claimable: [makeClaimButton({ clock })] });
    a.status({ hasAds: true });
    await clock.advance(1000);
    a.status({ hasAds: false });
    await clock.advance(POLL * 4); // b claims after a's ad break
    assert.strictEqual(stat(browser, "adsSkipped"), 5, "a's ad break must survive b's claim");
    assert.strictEqual(stat(browser, "pointsClaimed"), 4, "b's claim must survive a's ad break");
    a.status({ hasAds: true });
    await clock.advance(1000);
    a.status({ hasAds: false });
    await clock.advance(5000);
    assert.strictEqual(stat(browser, "pointsClaimed"), 4, "a's second ad break must not roll the claim back");
    assert.strictEqual(stat(browser, "adsSkipped"), 6);
  });

  await test("a claim made right after load is not lost to a late stats load", async () => {
    const { clock, browser } = freshWorld({ seedStats: { pointsClaimed: 40 } });
    makeTab(browser, { claimable: [makeClaimButton({ clock })] });
    await clock.advance(POLL * 3);
    assert.strictEqual(stat(browser, "pointsClaimed"), 41);
  });

  await test("ad-break stats: break counted on start, time/blanked/leaks on end", async () => {
    const { clock, browser } = freshWorld();
    const tab = makeTab(browser);
    tab.status({ hasAds: true, stripping: false });
    await clock.advance(10_000);
    tab.status({ hasAds: true, stripping: true, leaked: true });
    await clock.advance(20_000);
    tab.status({ hasAds: false });
    await clock.advance(1000);
    assert.strictEqual(stat(browser, "adsSkipped"), 1);
    assert.strictEqual(stat(browser, "timeSavedMs"), 30_000);
    assert.strictEqual(stat(browser, "blanked"), 1);
    assert.strictEqual(stat(browser, "leaks"), 1);
  });

  await test("background ignores junk deltas (unknown keys, NaN, negatives, strings)", async () => {
    const { clock, browser } = freshWorld({ seedStats: { pointsClaimed: 3 } });
    const send = (delta) => browser.chrome({}).runtime.sendMessage({ type: "nta:stats", delta });
    await send({ pointsClaimed: -5, adsSkipped: NaN, evil: 99, blanked: "x" });
    await send({ pointsClaimed: 2 });
    await clock.advance(10);
    assert.strictEqual(stat(browser, "pointsClaimed"), 5);
    assert.strictEqual(stat(browser, "adsSkipped"), 0);
    assert.strictEqual(browser.data.local.stats.evil, undefined);
  });

  await test("claim de-dupe survives a background restart", async () => {
    const { clock, browser } = freshWorld({ seedStats: { pointsClaimed: 3 } });
    const send = () => browser.chrome({}).runtime.sendMessage({ type: "nta:stats", delta: { pointsClaimed: 1 }, claimChannel: "mammoth" });
    await send();
    browser.messageListeners.length = 0; // service worker died...
    startBackground(browser); // ...and came back with only storage left
    await clock.advance(5000);
    await send();
    assert.strictEqual(stat(browser, "pointsClaimed"), 4);
  });

  await test("sendMessage failing (extension reloaded under the tab) does not throw", async () => {
    const { clock, browser } = freshWorld();
    const tab = makeTab(browser);
    browser.messageListeners.length = 0;
    browser.chrome = () => { throw new Error("unused"); };
    tab.status({ hasAds: true });
    await clock.advance(1000);
    tab.status({ hasAds: false });
    await clock.advance(1000);
  });

  console.log(process.exitCode ? "\nSome stats checks FAILED" : "\nAll " + passed + " stats checks passed");
})();
