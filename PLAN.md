# Plan: wtyczka Firefox do pobierania z YouTube (MP3 + MP4), bez dodatkowych programów

## Stan realizacji (2026-11-08)

- ✅ Etapy 1–6: wtyczka działa end-to-end (MP3 z okładką i tagami, MP4 do 1080p, kolejka, popup, ustawienia, menu PPM).
- ✅ Przycisk „Pobierz” w pasku odtwarzacza (za kołem ustawień) z menu w stylu YouTube i pierścieniem postępu.
- ✅ Shorts: pozycja „Pobierz (MP3 / MP4)” w menu ⋮ odtwarzacza, menu formatów pod ⋮, toasty o postępie.
  Jakość liczona po krótszym boku klatki (pionowe 1080×1920 = 1080p).
- ✅ Etap 8 (częściowo): `npm run package` buduje niepodpisany .xpi, GitHub Actions budują go przy każdym pushu,
  a tag `v*` podpisuje paczkę u Mozilli (kanał unlisted) i publikuje ją w Releases.
- ⏳ Do zrobienia: lokalizacja (etap 7), automatyczne aktualizacje (wymagają publicznego adresu update_url), testy etapu 9.

## 1. Cel i zakres

Jedno rozszerzenie Firefoksa (plik `.xpi`), **bez instalowania czegokolwiek poza nim**. Pozwala pobrać z YouTube:

- **MP3**: dźwięk z okładką i tagami (tytuł, kanał);
- **MP4**: wideo z dźwiękiem, jakość 360p / 480p / 720p / 1080p.

Do tego postęp, kolejka, anulowanie, przycisk pod filmem, menu PPM i ustawienia.

**v1.1 (opcjonalnie):** 1440p / 4K (VP9/AV1 → MP4), playlisty.

> Uwaga prawna: pobieranie z YouTube narusza jego regulamin, chyba że chodzi o własne treści albo treści na wolnej licencji. Wtyczka jest do użytku osobistego.

---

## 2. Co zastępuje yt-dlp i ffmpeg

| Zadanie | W wersji z programem | W wersji „tylko wtyczka” |
|---|---|---|
| Lista strumieni, odszyfrowanie podpisów (n-sig), tokeny PO | yt-dlp + deno | **youtubei.js** (LuanRT/YouTube.js) + **BgUtils** (tokeny PO), uruchamiane na karcie youtube.com |
| Pobieranie strumieni | yt-dlp | własny moduł: `fetch` z zakresami (kawałki ~10 MB, 3–4 równolegle, ponawianie) |
| Scalanie obrazu i dźwięku do MP4 | ffmpeg | **Mediabunny** (odczyt MP4/WebM, zapis MP4 bez rekodowania); w razie problemów **mp4box.js** + własny muxer |
| Konwersja do MP3 | ffmpeg (LAME) | dekodowanie: WebCodecs `AudioDecoder` / `decodeAudioData`; kodowanie: **LAME w WASM** (np. `@mediabunny/mp3-encoder`) lub **lamejs** |
| Tagi i okładka MP3 | ffmpeg | **browser-id3-writer** (ID3v2, ramka APIC z miniaturą) |
| Zapis na dysk | host | `browser.downloads.download()` z `Blob`/`blob:` URL |

> ✅ **Etap 0 zakończony (2026-11-08), decyzja: idziemy dalej.** Szczegóły: [spike/WYNIKI-ETAP0.md](spike/WYNIKI-ETAP0.md).
> Sprawdzone wersje: youtubei.js 18.3.0, bgutils-js 4.0.3, mediabunny 1.65.2, @mediabunny/mp3-encoder 1.65.2 (LAME w WASM), Firefox 159.
> Kluczowe ustalenia, które zmieniają plan:
> - ekstrakcja i BotGuard działają **tylko w świecie strony** (w piaskownicy content scriptu minter tokenów PO zawodzi);
> - jedyny działający klient to **TV_SIMPLY z tokenem PO**, a bez tokenu YouTube odcina pobieranie po kilku MB;
> - CSP rozszerzenia musi dopuszczać WASM i workery z `blob:` (koder MP3);
> - browser-id3-writer jest zbędny, bo tagi i okładkę zapisuje Mediabunny (`setMetadataTags` / `tags`).

---

## 3. Architektura

```
┌──────────────────────────── Firefox ────────────────────────────┐
│                                                                 │
│  ┌─ karta youtube.com ───────────────────────────────────────┐  │
│  │ content script                                            │  │
│  │  • przycisk „⬇ Pobierz” pod filmem (obsługa nawigacji SPA)│  │
│  │  • EXTRACTOR: youtubei.js                                 │  │
│  │      - zapytania InnerTube przez content.fetch            │  │
│  │        (pochodzenie i ciasteczka youtube.com)             │  │
│  │      - eval kodu odtwarzacza i BotGuard w świecie strony  │  │
│  │  → zwraca: tytuł, kanał, miniaturę, listę formatów        │  │
│  │    z gotowymi (odszyfrowanymi) URL-ami googlevideo.com    │  │
│  └───────────────────────────┬───────────────────────────────┘  │
│                              │ runtime.connect (port)           │
│  ┌─ background (strona tła, MV2, trwała) ───────────────────┐   │
│  │  • kolejka zadań, stan, powiadomienia, menu PPM          │   │
│  │  • DOWNLOADER: fetch kawałkami z googlevideo.com         │   │
│  │  • Web Worker „media”:                                   │   │
│  │      MP4: wideo (avc1) + audio (mp4a) → remux → .mp4     │   │
│  │      MP3: audio → dekodowanie PCM → LAME → ID3 → .mp3    │   │
│  │  • downloads.download(blob URL) → folder Pobrane         │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  popup (wybór MP3/MP4, jakość, lista zadań)   options (ustawienia)│
└─────────────────────────────────────────────────────────────────┘
```

### Dlaczego ekstrakcja na karcie YouTube, a nie w tle
- Zapytania do API InnerTube i BotGuard działają najpewniej z **prawdziwego kontekstu youtube.com**: właściwe pochodzenie, ciasteczka, `visitorData` i środowisko, w którym BotGuard się nie „dziwi”.
- W Firefoksie content script może wysyłać zapytania „jako strona” przez `content.fetch()`.
- Kod odtwarzacza (odszyfrowanie podpisów) i BotGuard wykonujemy **w świecie strony**: skrypt `page.js` z `web_accessible_resources` wstrzykiwany przez content script, `eval` przez własną politykę Trusted Types. Nie potrzebujemy `unsafe-eval` w samym rozszerzeniu. *(Potwierdzone w etapie 0: w piaskownicy content scriptu minter tokenów PO zwraca `PMD:Undefined`.)*
- Klient InnerTube: **TV_SIMPLY** + token PO (sesyjny w URL-u strumienia, filmowy w zapytaniu `player`). Moduł klientów musi być wymienny. Plan B na wypadek zmian: SABR przez bibliotekę `googlevideo` z klientem WEB.
- Content script przekazuje do tła tylko gotowe URL-e i metadane. Pobieranie odbywa się w tle (`credentials: 'omit'`), co w etapie 0 dało ~40 MB/s.
- Wklejony URL albo link spoza YouTube: background używa istniejącej karty youtube.com, a jeśli jej nie ma, otwiera nieaktywną kartę `youtube.com` jako „silnik” i zamyka ją po ekstrakcji.

### Kluczowe decyzje

| Kwestia | Decyzja | Uzasadnienie |
|---|---|---|
| Manifest | **MV2**, trwała strona tła | Długie pobieranie i przetwarzanie nie może zostać uśpione. Mozilla utrzymuje MV2. |
| Język i budowanie | **TypeScript + esbuild** → `extension/dist/` | youtubei.js i Mediabunny to pakiety npm (ESM). Trzeba je zbundlować, bo wtyczka nie może ładować kodu z sieci. |
| Przetwarzanie mediów | **Web Worker** w tle | Kodowanie MP3 i remux nie blokują UI ani kolejki. |
| Bufor danych | Pamięć RAM; dla plików > ~500 MB **OPFS** (`navigator.storage.getDirectory()`) | Długie filmy 1080p nie muszą zmieścić się w pamięci. |
| Zapis | `downloads.download({ url: blobURL, filename: "YouTube/MP3/…" })` | Rozszerzenie ma dostęp tylko do folderu Pobrane (i podfolderów) albo okna „Zapisz jako”. |
| Dystrybucja | Podpisany `.xpi`, kanał **unlisted** + **własne aktualizacje** (`update_url`) | AMO raczej nie przyjmie takiej wtyczki. Automatyczne aktualizacje są niezbędne, bo poprawki po zmianach YouTube trzeba szybko dostarczać. |

---

## 4. Struktura repozytorium

```
YoutubeDownloaderExtansion/
├── src/
│   ├── manifest.json
│   ├── background/
│   │   ├── index.ts              # start, porty, menu PPM, powiadomienia
│   │   ├── queue.ts              # kolejka, limit równoległości, stan → storage.local
│   │   ├── downloader.ts         # fetch kawałkami, ponawianie, postęp, anulowanie (AbortController)
│   │   ├── engineTab.ts          # wybór/otwarcie karty youtube.com do ekstrakcji
│   │   └── save.ts               # Blob → downloads.download, sprzątanie blob URL
│   ├── content/
│   │   ├── index.ts              # komunikacja z tłem
│   │   ├── extractor.ts          # youtubei.js: info + formaty + odszyfrowane URL-e
│   │   ├── pageWorld.ts          # most do świata strony (eval kodu odtwarzacza, BotGuard)
│   │   ├── button.ts             # przycisk i menu pod odtwarzaczem, yt-navigate-finish
│   │   └── button.css
│   ├── worker/
│   │   ├── media.worker.ts       # punkt wejścia workera
│   │   ├── mp4.ts                # remux wideo + audio → MP4
│   │   ├── mp3.ts                # dekodowanie + LAME + ID3
│   │   └── formats.ts            # wybór itagów dla danej jakości
│   ├── popup/  (popup.html, popup.ts, popup.css)
│   ├── options/ (options.html, options.ts)
│   ├── shared/
│   │   ├── protocol.ts           # typy komunikatów
│   │   ├── url.ts                # rozpoznawanie i normalizacja URL-i YouTube
│   │   └── filename.ts           # szablon nazwy, usuwanie niedozwolonych znaków
│   ├── _locales/{pl,en}/messages.json
│   └── icons/
├── spike/                        # kod z etapu 0 (do wyrzucenia)
├── tests/                        # vitest: formaty, nazwy plików, ID3, remux na próbkach
├── scripts/build.mjs             # esbuild: background, content, worker, popup, options
├── updates.json                  # manifest aktualizacji dla update_url
├── package.json
├── tsconfig.json
├── PLAN.md
└── README.md
```

---

## 5. Manifest (szkic)

```json
{
  "manifest_version": 2,
  "name": "YouTube Downloader (MP3/MP4)",
  "version": "0.1.0",
  "browser_specific_settings": {
    "gecko": {
      "id": "yt-downloader@twoja-domena.pl",
      "strict_min_version": "128.0",
      "update_url": "https://<twoj-hosting>/updates.json"
    }
  },
  "permissions": [
    "downloads", "storage", "notifications", "contextMenus", "tabs",
    "*://*.youtube.com/*", "*://*.googlevideo.com/*", "*://*.ytimg.com/*"
  ],
  "background": { "scripts": ["background.js"], "persistent": true },
  "content_scripts": [{
    "matches": ["*://www.youtube.com/*", "*://m.youtube.com/*"],
    "js": ["content.js"],
    "css": ["content.css"],
    "run_at": "document_idle"
  }],
  "browser_action": { "default_popup": "popup.html", "default_icon": "icons/48.png" },
  "options_ui": { "page": "options.html" },
  "web_accessible_resources": ["page.js"],
  "content_security_policy": "script-src 'self' 'wasm-unsafe-eval' blob:; object-src 'self'; worker-src 'self' blob:"
}
```

- `page.js`: ekstraktor (youtubei.js + BgUtils) uruchamiany w świecie strony youtube.com.
- `content_security_policy`: koder MP3 (LAME w WASM) startuje własny Worker z `blob:`. Bez tego wpisu konwersja do MP3 jest blokowana (sprawdzone w etapie 0).

- `*.googlevideo.com`: pobieranie strumieni z tła bez blokad CORS.
- `*.ytimg.com`: miniatury do okładki MP3.
- `strict_min_version: 128`: WebCodecs (`AudioDecoder`), stabilne OPFS w workerach. Dokładną wersję ustalimy w etapie 0.

---

## 6. Przepływ jednego pobrania

1. **Wybór.** Użytkownik klika „⬇ Pobierz → MP4 720p” (przycisk, popup albo menu PPM). Komunikat trafia do tła.
2. **Ekstrakcja.** Tło prosi content script na karcie youtube.com o `extract(videoId)`. Ten zwraca metadane i formaty z URL-ami: wideo `itag 136` (720p avc1), audio `itag 140` (AAC 128k).
3. **Pobieranie.** `downloader.ts` pobiera każdy strumień kawałkami: `&range=start-end` lub nagłówek `Range`, ~10 MB, 3–4 równolegle, do 3 ponowień z odczekaniem. Postęp jest wysyłany ~4 razy na sekundę.
4. **Przetwarzanie** (worker):
   - **MP4:** demux obu strumieni i zapis próbek do jednego MP4 (`fastStart`, czyli indeks na początku pliku), **bez rekodowania**, więc trwa to sekundy;
   - **MP3:** demux audio, dekodowanie do PCM, LAME (VBR V0 lub CBR 320/192), dopisanie ID3v2 (tytuł, kanał, rok, okładka JPG).
5. **Zapis.** `Blob` → `URL.createObjectURL` → `downloads.download({ filename: "YouTube/MP4/<tytuł>.mp4" })`. Po `downloads.onChanged` = `complete` zwalniamy `revokeObjectURL` i czyścimy OPFS.
6. **Powiadomienie** „Gotowe”. Kliknięcie → `downloads.show(id)`.

### Mapa jakości (v1, wszystko H.264 + AAC)

| Wybór | Wideo (itag, preferowany → zapasowy) | Audio |
|---|---|---|
| MP4 1080p | 137 → 136 | 140 |
| MP4 720p | 136 → 135 | 140 |
| MP4 480p | 135 → 134 | 140 |
| MP4 360p | 18 (strumień z gotowym dźwiękiem, bez scalania) → 134 | (w 18) / 140 |
| MP3 | n/d | 140 (AAC) → 251 (Opus) |

W kodzie wybieramy po **parametrach** (`height`, `mimeType` zawierające `avc1`/`mp4a`), a nie po sztywnych numerach. Tabela jest tylko punktem odniesienia.

---

## 7. Protokół komunikatów wewnątrz wtyczki

```ts
// UI/content → background
{ type: "enqueue", url, mode: "mp3" | "mp4", quality?: "1080"|"720"|"480"|"360", audioBitrate?: "v0"|"320"|"192" }
{ type: "cancel", jobId }
{ type: "subscribe" }                       // popup chce strumień stanu kolejki

// background → content (karta-silnik)
{ type: "extract", videoId }
// content → background
{ type: "extracted", videoId, title, author, thumbnail, duration, formats: Format[] }
{ type: "extractError", videoId, code: "AGE_RESTRICTED"|"PRIVATE"|"LIVE"|"BOTGUARD"|"DECIPHER"|"UNKNOWN", message }

// background → UI
{ type: "jobUpdate", jobId, state: "queued"|"extracting"|"downloading"|"processing"|"saving"|"done"|"error"|"cancelled",
  percent?, speed?, eta?, error? }

// background ⇄ worker
{ type: "mux", jobId, video: Blob|OPFSHandle, audio: Blob|OPFSHandle } → { type: "muxed", jobId, blob }
{ type: "mp3", jobId, audio, bitrate, tags: {title, artist, year, cover: ArrayBuffer} } → { type: "encoded", jobId, blob, progress? }
```

---

## 8. Etapy realizacji

### ✅ Etap 0: prototyp, decyzja „idziemy dalej / nie idziemy” (ZROBIONE 2026-11-08: IDZIEMY DALEJ)

Wynik: 1080p pobrane w całości (163 MB / 4 s), MP4 scalone w 0,45 s, MP3 z okładką w 7,4 s dla 9 min audio. Działa wyłącznie świat strony + TV_SIMPLY + token PO. Pełny raport: [spike/WYNIKI-ETAP0.md](spike/WYNIKI-ETAP0.md). Do sprawdzenia później: Shorts, ograniczenie wiekowe, MP3 > 1 h, wygasanie tokenu PO.

Cel: sprawdzić **najsłabsze ogniwo**, zanim powstanie reszta. Kod w `spike/`, bez dbania o jakość.

- [ ] Content script na youtube.com z youtubei.js (zbundlowanym esbuildem).
- [ ] Sprawdzić, jak w obecnej wersji youtubei.js podać własny `eval`: w świecie strony (`window.wrappedJSObject` / wstrzyknięty `<script>` z Trusted Types). Sprawdzić, czy CSP YouTube na to pozwala.
- [ ] Sprawdzić, czy potrzebny jest token PO i czy BgUtils generuje go na karcie youtube.com.
- [ ] Przetestować różne klienty InnerTube (WEB, MWEB, TV, IOS/ANDROID): który zwraca zwykłe URL-e strumieni zamiast samego SABR (`serverAbrStreamingUrl`).
- [ ] Pobrać z tła **pełny** strumień 1080p (itag 137) i audio (140) kawałkami: brak 403, brak dławienia do ~50 KB/s.
- [ ] Sprawdzić Mediabunny w workerze: remux 137 + 140 → MP4 otwierany w odtwarzaczu Windows i VLC.
- [ ] Sprawdzić kodowanie MP3 (`@mediabunny/mp3-encoder` lub lamejs): czas dla 4 min i 60 min audio, zużycie pamięci.

**Kryteria „idziemy dalej” (wszystkie muszą być spełnione):**
1. Zwykły film, Shorts i film > 1 h pobierają się w 1080p bez błędów, 5 prób z rzędu.
2. Prędkość pobierania jest porównywalna z odtwarzaniem w przeglądarce (nie dławiona).
3. MP4 i MP3 odtwarzają się poprawnie, a tagi i okładka są widoczne w Eksploratorze Windows.

**Jeśli nie:** wracamy do wariantu „wtyczka + mały program pomocniczy (yt-dlp/ffmpeg)” z wcześniejszej wersji planu.

### Etap 1: szkielet projektu (0,5–1 dnia)
- [ ] `package.json`, TypeScript, esbuild (osobne paczki: background, content, worker, popup, options).
- [ ] `web-ext run` z automatycznym przeładowaniem, `web-ext lint`, ESLint, vitest.
- [ ] Manifest, ikony, komunikacja tło ⇄ content ⇄ popup (`shared/protocol.ts`).

### Etap 2: moduł ekstrakcji (1,5–2 dni)
- [ ] `extractor.ts` + `pageWorld.ts` na podstawie wniosków z etapu 0.
- [ ] Obsługa `/watch`, `/shorts/`, `youtu.be`, `/live/` (transmisje na żywo odrzucamy z komunikatem), `/embed/`.
- [ ] Czytelne kody błędów (ograniczenie wiekowe, prywatny, niedostępny w regionie, BotGuard).
- [ ] `engineTab.ts`: ekstrakcja dla URL-a spoza aktywnej karty.

### Etap 3: silnik pobierania (1–1,5 dnia)
- [ ] Pobieranie kawałkami, równoległość, ponawianie z odczekaniem, `AbortController`.
- [ ] Odświeżenie URL-a (ponowna ekstrakcja) po 403 lub wygaśnięciu (`expire`).
- [ ] Bufor RAM, a dla dużych plików OPFS.
- [ ] Postęp, prędkość, ETA.

### Etap 4: MP3 (1 dzień)
- [ ] Worker: demux audio → PCM → LAME (V0 / 320 / 192).
- [ ] ID3v2: tytuł, kanał jako wykonawca, rok, okładka (miniatura `maxresdefault`/`hqdefault`, przycięta do kwadratu przez `OffscreenCanvas`).
- [ ] Zapis przez `downloads`, powiadomienie.
- **Gotowe, gdy:** MP3 z okładką i tagami od kliknięcia do pliku.

### Etap 5: MP4 do 1080p (1 dzień)
- [ ] `formats.ts`: wybór najlepszego `avc1` ≤ wybranej wysokości + `mp4a`.
- [ ] Worker: remux z `fastStart`. 360p przez itag 18 bez scalania.
- [ ] Popup i przycisk pokazują tylko jakości faktycznie dostępne dla danego filmu.

### Etap 6: interfejs (1,5–2 dni)
- [ ] Przycisk „⬇ Pobierz” pod odtwarzaczem z menu (MP3 / MP4 z jakościami), postęp przy przycisku. Ponowne wstawienie po `yt-navigate-finish` i przez `MutationObserver`. Selektory DOM w jednym miejscu, z zapasowymi wariantami.
- [ ] Popup: miniatura i tytuł bieżącego filmu, wybór trybu i jakości, pole do wklejenia URL-a, lista zadań (postęp, Anuluj, Pokaż w folderze).
- [ ] Menu PPM na linkach i stronach YouTube: „Pobierz jako MP3”, „Pobierz jako MP4 ▸ 1080p/720p/480p/360p”.
- [ ] Kolejka: domyślnie 2 zadania równolegle, stan zachowany w `storage.local`.

### Etap 7: ustawienia i lokalizacja (0,5–1 dnia)
- [ ] Podfolder w Pobranych (osobno MP3/MP4), „pytaj, gdzie zapisać” (`saveAs`).
- [ ] Domyślna jakość MP4 i bitrate MP3, szablon nazwy (`{kanał} - {tytuł}`), limit równoległości.
- [ ] `_locales` PL/EN.

### Etap 8: dystrybucja i aktualizacje (0,5–1 dnia)
- [ ] `web-ext sign --channel=unlisted` (klucze API z AMO), czyli podpisany `.xpi`.
- [ ] `update_url` + `updates.json` (np. na GitHub Pages / w Releases): Firefox sam pobiera nowe wersje.
- [ ] Skrypt wydania: zwiększenie wersji, budowanie, podpisanie, aktualizacja `updates.json`.
- [ ] README: instalacja (przeciągnięcie `.xpi` do Firefoksa), znane ograniczenia.

### Etap 9: testy i dopracowanie (1–2 dni, potem na bieżąco)
- [ ] Testy jednostkowe (vitest): wybór formatów na zapisanych odpowiedziach InnerTube, szablon i sanityzacja nazw (polskie znaki, `/\:*?"<>|`, długość), zapis ID3, remux na krótkich próbkach.
- [ ] Testy ręczne według listy: zwykły film, Shorts, film > 2 h, transmisja na żywo, ograniczenie wiekowe, prywatny lub usunięty, brak internetu w trakcie, anulowanie podczas pobierania i podczas przetwarzania, 3 pobrania naraz, zamknięcie karty-silnika w trakcie.
- [ ] Zużycie pamięci przy 1080p > 1 h (oczekiwane użycie OPFS).

### v1.1 (opcjonalnie)
- [ ] 1440p / 4K: WebM VP9/AV1 + Opus → MP4 przez Mediabunny, z informacją w UI o zgodności odtwarzaczy.
- [ ] Playlisty (kolejka wielu filmów, wybór pozycji).
- [ ] Napisy (.srt).

**Łącznie do v1.0:** około 10–14 dni pracy jednej osoby, w tym etap 0.

---

## 9. Ryzyka i jak je ograniczyć

| Ryzyko | Wpływ | Ograniczenie |
|---|---|---|
| YouTube zmienia zabezpieczenia (n-sig, tokeny PO, SABR) | Pobieranie przestaje działać | youtubei.js w osobnym module łatwym do podmiany, szybkie wydania przez `update_url`, czytelny komunikat „wymaga aktualizacji wtyczki”. |
| **Działa tylko jeden klient (TV_SIMPLY + token PO)** (potwierdzone w etapie 0) | YouTube zmieni klienta, pobieranie przestaje działać | Wymienny moduł klientów, automatyczny test „zakres w środku pliku = 200” przy każdym wydaniu. Plan B: SABR (`googlevideo`) z klientem WEB. |
| Trusted Types na youtube.com | Brak odszyfrowania | Rozwiązane w etapie 0: własna polityka `trustedTypes.createPolicy` w świecie strony działa. |
| Duże pliki w pamięci | Zawieszenie karty tła | OPFS dla dużych plików, przetwarzanie strumieniowe w Mediabunny. |
| Zmiany DOM YouTube | Znika przycisk pod filmem | Popup i menu PPM działają niezależnie od DOM. Selektory w jednym miejscu. |
| AMO nie przyjmie wtyczki | Brak publicznego sklepu | Podpisany `.xpi` z kanału unlisted, aktualizacje własne. |
| Filmy z ograniczeniem wiekowym | Błąd ekstrakcji | Ekstrakcja w kontekście zalogowanego użytkownika (ciasteczka youtube.com), więc działa, jeśli użytkownik ma potwierdzony wiek. |

---

## 10. Narzędzia

- **Node.js 20+**, `npm`, **TypeScript**, **esbuild**, **web-ext**, **vitest**, ESLint.
- Biblioteki (sprawdzone w etapie 0): `youtubei.js` 18.x, `bgutils-js` 4.x, `mediabunny` 1.65+, `@mediabunny/mp3-encoder`. Plan B dla strumieni: `googlevideo` (SABR).
- Debug: `about:debugging` → „Zbadaj” (tło i worker), narzędzia deweloperskie na karcie YouTube (content script), zakładka Sieć dla zapytań do `googlevideo.com`.
