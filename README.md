# YouTube Downloader (MP3/MP4) for Firefox

A Firefox extension that downloads audio (MP3, M4A, Opus or WAV, with cover art and tags) and video (MP4 up to 1080p in H.264,
and 1440p / 4K / 8K in VP9 or AV1) from YouTube.
It is fully self-contained — no yt-dlp, ffmpeg or any other program is needed: extraction (youtubei.js + BotGuard/PO token),
stream muxing and MP3 encoding (Mediabunny + LAME compiled to WASM) all run inside the browser.

## How to download

- **Regular video**: the ⬇ button in the player bar, next to the settings gear → pick an audio format or an MP4 quality.
- **Shorts**: the ⋮ menu in the top-right corner of the player → **Download (MP3 / MP4)**.
- **Extension popup**: the current video, a field to paste any link, and the download list with progress.
- **Context menu** on a video link or a video page.

Files are saved to your downloads folder, by default in a `YouTube` subfolder (configurable in the extension settings).

## Audio formats

| Format | What you get | Best for |
|---|---|---|
| **MP3** | Re-encoded at 128–320 kb/s (setting, default 192 kb/s) | Plays on anything, including old car stereos and MP3 players. |
| **M4A** | YouTube's original AAC audio (~128 kb/s), copied without re-encoding | Same quality as on YouTube, plays everywhere (phones, iTunes, Windows). |
| **Opus** | YouTube's original Opus audio (~130–160 kb/s), copied without re-encoding | The best sound YouTube offers, smallest file. Plays in browsers, VLC, Android, foobar2000. |
| **WAV** | Uncompressed 16-bit PCM decoded from the best source | Audio/video editors and DAWs that don't read lossy formats. Large (~10 MB per minute). |

All audio files get the title, the channel name as artist, and the video thumbnail as square cover art.
WAV cannot add quality that the source does not have – it is only uncompressed for compatibility.

## Video quality

| Quality | Video codec | Notes |
|---|---|---|
| 144p – 1080p | H.264 + AAC | Plays everywhere: Windows, phones, TVs, video editors. |
| 1440p, 4K, 8K (*Higher quality MP4*) | VP9 or AV1 + AAC | YouTube does not provide H.264 above 1080p. |

- Streams are never re-encoded: video and audio are copied as-is into one MP4 file, so there is no quality loss.
- Above 1080p the extension prefers VP9 (better player support, lighter to decode) and uses AV1 only when VP9 is
  missing (e.g. 8K) or has fewer frames per second. HDR versions are skipped – the SDR version is downloaded.
- VP9/AV1 files play in Firefox, Chrome, VLC, mpv and most recent phones and TVs. On Windows the built-in player may
  need the free *VP9 Video Extensions* / *AV1 Video Extension* from the Microsoft Store. Older devices and some video
  editors may not open them.
- Shorts and other vertical videos are labelled by the shorter side of the frame (a 1080×1920 Short is 1080p).
- The original audio track is preferred over dubbed or auto-dubbed tracks.

Large downloads are written to the extension's private storage on disk (OPFS) while downloading and merging,
so a multi-gigabyte 4K/8K video does not have to fit in memory. Temporary files are deleted when the download
finishes (and on the next browser start, if it was interrupted). This needs free disk space of roughly twice the
video size; the extension asks for the *unlimited storage* permission for this reason.

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
  background/           queue, chunked downloading, MP4 muxing, MP3 encoding, saving,
                        temporary files on disk (tempfiles.js)
  popup/, options/      user interface
scripts/build.mjs       esbuild + static file copying
spike/                  stage 0 prototype (to be removed)
```
