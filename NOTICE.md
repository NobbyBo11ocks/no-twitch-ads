# Notices and sources

No Twitch Ads is licensed under the GNU General Public License v3.0 only
(see `LICENSE`). It is original packaging and glue code around an ad-skipping
technique the Twitch community has maintained in the open for years. The
projects below were studied directly, from their source code rather than from
write-ups about them, and parts of their logic are adapted here. The adapted
portions remain available under their original MIT terms, reproduced below, and
the combined work is distributed under the GPL-3.0.

## Adapted code (MIT)

- **pixeltris/TwitchAdSolutions**, the `vaft` userscript, version 37.0.0.
  Archived by its author on 2026-03-05. Origin of the Worker/fetch hooking,
  playlist inspection, backup-session swap, ad-segment stripping, HEVC
  fallback, player reload through React internals, and the blank MP4 segment.
  https://github.com/pixeltris/TwitchAdSolutions
- **0rpi/twitch-adblock-userscript**, maintained fork of vaft, version 37.2.2,
  last updated 2026-09-29. Source of several fixes carried here: null-safe
  `SERVER-TIME` parsing, the ad tracking URL rewrite being written back, a
  gentler pause/play after breaks instead of a full reload, React lookups only
  when a video exists, and the latency catch-up after returning to a tab.
  https://github.com/0rpi/twitch-adblock-userscript
- **VideoAdBlockForTwitch contributors**, the project vaft itself built on.
  https://github.com/cleanlock/VideoAdBlockForTwitch#credits

```
MIT License

Copyright (c) 2020-present TwitchAdSolutions Contributors
Copyright (c) 2026 0rpi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Reference only (no code copied)

- **younesaassila/ttv-lol-pro** (GPL-3.0). Used as a reference for the
  Manifest V3 layout (MAIN-world content script, `minimum_chrome_version` 111),
  the `PlaybackAccessToken_Template` full GraphQL query used as a fallback when
  Twitch rotates its persisted-query hash, and the `stitched-ad` marker.
  https://github.com/younesaassila/ttv-lol-pro

## Verified live, 2026-10-01

Observed from a Chrome session on twitch.tv (Amazon IVS Player SDK 1.57.0):

- The `PlaybackAccessToken` persisted-query hash
  `ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9` still
  resolves; tokens are version 3 and carry `server_ads` / `show_ads` flags.
- Usher serves both the v1 (`#EXT-X-TWITCH-INFO`) and v2
  (`#EXT-X-SESSION-DATA`) master playlist formats.
- Live segments are tagged `#EXTINF:2.000,live`; a captured midroll used
  `#EXTINF:2.000,Amazon|2474283100494`, a `CLASS="twitch-stitched-ad"`
  DATERANGE with `X-TV-TWITCH-AD-ROLL-TYPE="MIDROLL"`, a 6-ad pod and
  `#EXT-X-DISCONTINUITY` at the boundary.
- The React 18 container, the player component exposing `setSrc`, and the IVS
  player methods used for pause/play/reload all exist.
- During a 212-second midroll (20:08:55Z to 20:12:27Z, 6-ad pod, 180 s
  filled), four parallel sessions were polled every 2 s: `site` carried the ad
  throughout; `embed` and the 360p `autoplay` session stayed clean throughout;
  `popout` carried the ad from roughly 8 s to 100 s and was clean otherwise.

Twitch, the Twitch logo and Amazon IVS are trademarks of their owners. This
project is not affiliated with or endorsed by Twitch or Amazon.
