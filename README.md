# YouTube Downloader for Firefox

Download YouTube videos and music straight from the player – no yt-dlp, ffmpeg or any other program to install.
Everything (finding the streams, merging video with audio, converting to MP3) happens inside Firefox.

- **Video:** MP4 from 144p to 1080p (H.264), and 1440p, 4K and 8K (VP9/AV1)
- **Audio:** MP3, M4A, Opus or WAV – with title, artist and cover art
- **Works on regular videos and Shorts**, with a download button that looks like part of YouTube
- **No quality loss:** video and original audio streams are copied, not re-encoded
- **Private:** no accounts, no tracking, no third-party servers – the extension only talks to YouTube

## Installation

1. Open the [latest release](../../releases/latest) and download `yt-downloader-vX.Y.Z.xpi`.
2. Open the file in Firefox (or drag it onto a Firefox window) and click **Add**.

Requires Firefox 140 or newer. The `.xpi` is signed by Mozilla, so it stays installed after a restart.

**Updating:** the extension does not update itself (the repository is private). To update, install the newer
`.xpi` from Releases the same way – it replaces the old version and keeps your settings.

## How to use

| Where | How |
|---|---|
| **Video page** | Click the ⬇ button in the player bar (next to the ⚙ settings gear) and pick a format. |
| **Shorts** | Open the ⋮ menu in the top-right corner of the Short → **Download (MP3 / MP4)**. |
| **Toolbar popup** | Click the extension icon: download the current video, paste any YouTube link, see progress and history. |
| **Right-click** | On a YouTube link or video page: **Download from YouTube** / **Download this video**. |

While a download runs, the ⬇ button shows a progress ring (on Shorts a small notice appears at the bottom).
When it is done you get a system notification – click it to show the file in its folder.

Files are saved to your **Downloads** folder, in a `YouTube` subfolder by default.

## Formats

### Video

| Quality | Codec | Plays in |
|---|---|---|
| 144p – 1080p | H.264 + AAC | Everything: Windows, macOS, phones, TVs, video editors. |
| 1440p, 4K, 8K (*Higher quality MP4*) | VP9 or AV1 + AAC | Firefox, Chrome, VLC, mpv, most recent phones and TVs. |

YouTube does not offer H.264 above 1080p, so higher resolutions use VP9 (preferred) or AV1.
On Windows the built-in player may need the free *VP9 Video Extensions* or *AV1 Video Extension* from the
Microsoft Store; VLC plays them out of the box. HDR versions are skipped – you always get the SDR video.

### Audio

| Format | What you get | Good for |
|---|---|---|
| **MP3** | Converted, 128–320 kb/s (192 kb/s by default) | Any device, including old car stereos and MP3 players. |
| **M4A** | YouTube's original AAC (~128 kb/s), not re-encoded | Same quality as on YouTube; plays on phones, iTunes, Windows. |
| **Opus** ⭐ | YouTube's original Opus (~130–160 kb/s), not re-encoded | The best sound YouTube offers. Browsers, VLC, Android, foobar2000. |
| **WAV** | Uncompressed 16-bit PCM | Audio and video editors. Large (~10 MB per minute). |

WAV is only uncompressed for compatibility – it cannot sound better than the source.
When a video has several audio tracks (dubbed or auto-dubbed), the original one is used.

## Settings

Use the ⚙ button in the popup, or `about:addons` → *YouTube Downloader* → *Preferences*:

- **Subfolder in Downloads** – default `YouTube`; leave empty to save directly to Downloads
- **Ask where to save each file**
- **MP3 quality** – 128 / 192 / 256 / 320 kb/s
- **Default MP4 quality** in the popup
- **Simultaneous downloads** – 1 to 3

## Permissions

| Permission | Why |
|---|---|
| Access to youtube.com, googlevideo.com, ytimg.com, googleapis.com | Read video information, download the streams and the thumbnail used as cover art. |
| Downloads | Save the finished file to your Downloads folder. |
| Unlimited storage | Big 4K/8K files are assembled on disk instead of in memory. Temporary files are deleted right after saving. |
| Tabs, notifications, context menus, storage | Progress in the player, "download finished" notifications, the right-click menu, your settings and history. |

## Limitations and troubleshooting

- **Live streams** (and premieres that are still live) cannot be downloaded.
- **Age-restricted or members-only videos** may require you to be signed in to YouTube in Firefox.
- **Playlists, subtitles and whole channels** are not supported – one video at a time.
- **"YouTube blocked the download" or the button is missing:** refresh the YouTube tab. YouTube changes often;
  if it keeps failing, a newer release is needed.
- **4K/8K:** you need free disk space of roughly twice the file size while the download is being assembled.

Please download only content you have the right to download, and respect YouTube's Terms of Service and
the creators' copyright.

## For developers

Requires Node.js 22+.

```bash
npm ci
npm start            # development build + Firefox with the extension loaded
npm run build        # production build into dist/
npm run lint         # web-ext lint
npm run package      # unsigned .xpi in artifacts/
```

An unsigned build can be loaded temporarily via `about:debugging` → *This Firefox* → *Load Temporary Add-on*.

### Releasing

Pushing a version tag builds the extension, signs it with Mozilla (unlisted – not published on addons.mozilla.org)
and attaches the signed `.xpi` to a GitHub release:

```bash
git tag v0.1.3 && git push origin v0.1.3
```

The repository needs the secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`
([API keys from addons.mozilla.org](https://addons.mozilla.org/developers/addon/api/key/)).
Every release needs a higher version number. Mozilla's approval usually takes a few minutes.

### How it works

```
src/
  page/extractor.js     runs in the YouTube page: youtubei.js gets the stream list, BotGuard provides the PO token
  content/              the player button, the Shorts menu item and the bridge to the extractor
  background/           download queue, parallel chunked downloading, merging (Mediabunny),
                        MP3 encoding (LAME in WebAssembly), temporary files on disk (OPFS), saving
  popup/, options/      toolbar popup and settings page
scripts/build.mjs       esbuild bundling into dist/
```
