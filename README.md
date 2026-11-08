# YouTube Downloader (MP3/MP4) for Firefox

A Firefox extension that downloads audio (MP3 with cover art and tags) and video (MP4 up to 1080p) from YouTube.
It is fully self-contained — no yt-dlp, ffmpeg or any other program is needed: extraction (youtubei.js + BotGuard/PO token),
stream muxing and MP3 encoding (Mediabunny + LAME compiled to WASM) all run inside the browser.

## How to download

- **Regular video**: the ⬇ button in the player bar, next to the settings gear → pick MP3 or an MP4 quality.
- **Shorts**: the ⋮ menu in the top-right corner of the player → **Download (MP3 / MP4)**.
- **Extension popup**: the current video, a field to paste any link, and the download list with progress.
- **Context menu** on a video link or a video page.

Files are saved to your downloads folder, by default in a `YouTube` subfolder (configurable in the extension settings).

## Installation

Release builds of Firefox only install add-ons signed by Mozilla.

1. **Signed .xpi (recommended)**: download the file from this repository's *Releases* page and open it in Firefox
   (or drag it onto the browser window) → *Add*.
2. **Unsigned (for testing)**: `about:debugging` → *This Firefox* → *Load Temporary Add-on* → select
   `dist/manifest.json` or the `.xpi` file. It stays installed until the browser restarts.
   Firefox Developer Edition / Nightly / ESR can install an unsigned .xpi permanently after setting
   `xpinstall.signatures.required = false` in `about:config`.

## Building

Requires Node.js 22+.

```bash
npm ci
npm run build        # production build into dist/
npm run build:dev    # development build (sourcemaps, not minified)
npm start            # launch Firefox with the extension (web-ext run)
npm run lint         # web-ext lint
npm run package      # dist/ + artifacts/yt-downloader-<version>-unsigned.xpi
```

## Signing with Mozilla (unlisted channel)

Signing does not publish the extension on the AMO catalog — the file is only signed and you distribute it yourself.

1. Create an account on addons.mozilla.org and generate API keys: https://addons.mozilla.org/developers/addon/api/key/
2. Locally:
   ```bash
   AMO_JWT_ISSUER=user:xxx AMO_JWT_SECRET=yyy npm run sign
   ```
3. Automatically with GitHub Actions: add the repository secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`,
   then push a version tag:
   ```bash
   git tag v0.1.0 && git push origin v0.1.0
   ```
   The `release.yml` workflow sets the version from the tag, signs the package and attaches the signed `.xpi` to Releases.
   Mozilla's approval usually takes a few minutes. Every new release needs a higher version number.

Note: Firefox automatic updates (`update_url`) require a publicly reachable `updates.json` file.
They will not work from a private repository — install new versions manually from Releases.

## Project structure

```
src/
  page/extractor.js     extraction in the YouTube page context (youtubei.js, BotGuard, Trusted Types)
  content/              player button, Shorts menu item, bridge to the extractor
  background/           queue, chunked downloading, MP4 muxing, MP3 encoding, saving
  popup/, options/      user interface
scripts/build.mjs       esbuild + static file copying
spike/                  stage 0 prototype (to be removed)
```
