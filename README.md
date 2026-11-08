# YouTube Downloader (MP3/MP4) dla Firefoksa

Wtyczka do Firefoksa, która pobiera z YouTube muzykę (MP3 z okładką i tagami) i wideo (MP4 do 1080p).
Działa sama, bez yt-dlp, ffmpeg ani innych programów: ekstrakcja (youtubei.js + BotGuard/PO token),
łączenie ścieżek i kodowanie MP3 (Mediabunny + LAME w WASM) odbywa się w przeglądarce.

## Jak pobierać

- **Zwykły film**: przycisk ⬇ w pasku odtwarzacza, obok koła ustawień → wybierz MP3 albo jakość MP4.
- **Shorts**: menu ⋮ w prawym górnym rogu odtwarzacza → **Pobierz (MP3 / MP4)**.
- **Popup wtyczki**: bieżący film, wklejenie dowolnego linku, lista pobrań z postępem.
- **Menu PPM** na linku lub stronie filmu.

Pliki trafiają do folderu pobierania, domyślnie do podfolderu `YouTube` (zmiana w ustawieniach wtyczki).

## Instalacja

Firefox wydaniowy instaluje tylko wtyczki podpisane przez Mozillę.

1. **Podpisany .xpi (zalecane)**: pobierz plik z zakładki *Releases* tego repozytorium i otwórz go w Firefoksie
   (albo przeciągnij na okno przeglądarki) → *Dodaj*.
2. **Bez podpisu (do testów)**: `about:debugging` → *Ten Firefox* → *Wczytaj tymczasowy dodatek* → wskaż
   `dist/manifest.json` lub plik `.xpi`. Działa do restartu przeglądarki.
   W Firefox Developer Edition / Nightly / ESR można trwale zainstalować niepodpisany .xpi po ustawieniu
   `xpinstall.signatures.required = false` w `about:config`.

## Budowanie

Wymagany Node.js 22+.

```bash
npm ci
npm run build        # wersja produkcyjna do dist/
npm run build:dev    # wersja deweloperska (sourcemapy, bez minifikacji)
npm start            # uruchamia Firefoksa z wtyczką (web-ext run)
npm run lint         # web-ext lint
npm run package      # dist/ + artifacts/yt-downloader-<wersja>-unsigned.xpi
```

## Podpisywanie u Mozilli (kanał unlisted)

Podpis nie publikuje wtyczki w katalogu AMO – plik jest tylko podpisany i dostajesz go do własnej dystrybucji.

1. Załóż konto na addons.mozilla.org i wygeneruj klucze API: https://addons.mozilla.org/developers/addon/api/key/
2. Lokalnie:
   ```bash
   AMO_JWT_ISSUER=user:xxx AMO_JWT_SECRET=yyy npm run sign
   ```
3. Automatycznie w GitHub Actions: dodaj sekrety repozytorium `AMO_JWT_ISSUER` i `AMO_JWT_SECRET`,
   potem wypchnij tag z wersją:
   ```bash
   git tag v0.1.0 && git push origin v0.1.0
   ```
   Workflow `release.yml` ustawi wersję z tagu, podpisze paczkę i doda podpisany `.xpi` do Releases.
   Każda kolejna wersja musi mieć wyższy numer.

Uwaga: automatyczne aktualizacje Firefoksa (`update_url`) wymagają publicznie dostępnego pliku `updates.json`.
Z prywatnego repozytorium nie zadziałają – nowe wersje trzeba instalować ręcznie z Releases.

## Struktura

```
src/
  page/extractor.js     ekstrakcja w świecie strony YouTube (youtubei.js, BotGuard, Trusted Types)
  content/              przycisk w odtwarzaczu, menu Shorts, most do ekstraktora
  background/           kolejka, pobieranie fragmentami, mux MP4, kodowanie MP3, zapis
  popup/, options/      interfejs
scripts/build.mjs       esbuild + kopiowanie plików statycznych
spike/                  prototyp z etapu 0 (do wyrzucenia)
```
