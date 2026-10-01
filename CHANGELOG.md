# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

## [1.0.1] - 2026-10-01

### Fixed

- Backup sessions failed with "Illegal invocation" because the page-side fetch
  relay was called with the wrong receiver, so playback fell through to blanking
  on every break. The saved fetch is now bound to its global. Verified live.

### Changed

- Twitch-styled rework: chat-bubble skip icon and Twitch-purple palette.
- Popup pared back to a master switch, two counters, and the auto-claim toggle.
  Removed the fallback (360p/Source), allow-ads, popout and banner controls.
- "Source" is now the only backup strategy (embed → popout, blank as last
  resort); it keeps your quality through breaks.
- The content-classification disclosure ("Intended for certain audiences") is
  hidden, and the on-player banner is off by default.

## [1.0.0] - 2026-10-01

### Added

- Manifest V3 extension for Chrome 111+, Edge, Brave and Firefox 128+.
- Ad-break detection on live streams via the `twitch-stitched-ad` playlist
  marker, verified against a midroll captured live on 2026-10-01.
- Backup-session swap (`embed` → `popout` → 360p `autoplay`) during breaks,
  with segment blanking as the last resort.
- HEVC (2K/4K) fallback to the closest AVC rendition during breaks.
- Persisted-query hash for `PlaybackAccessToken` with a full-query fallback in
  case Twitch rotates the hash.
- Channel-points auto-claim: the "Claim Bonus" button under chat is clicked
  automatically (language independent, keyed on Twitch's own markup).
- Popup: master switch, live per-tab status, breaks skipped and points claimed
  counters, per-channel allow list, fallback mode (360p / Source), auto-claim,
  popout-token and banner toggles.
- Offline checks (`npm test`) against captured playlists and a build script
  that produces Chrome and Firefox packages.
