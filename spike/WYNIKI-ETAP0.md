# Etap 0: wyniki prototypu (2026-11-08)

**Decyzja: IDZIEMY DALEJ.** Pełne pobranie 1080p, scalenie do MP4 i konwersja do MP3 działają w samym Firefoksie (159), bez żadnych dodatkowych programów.

Środowisko: Firefox 159.0.1, Windows 11, youtubei.js 18.3.0, bgutils-js 4.0.3, mediabunny 1.65.2, @mediabunny/mp3-encoder 1.65.2.
Surowe dane: `results/run1/`, `results/run2/` (JSON z każdego przebiegu).

## Co zadziałało (2 przebiegi × 2 filmy, wszystko OK)

| Element | Wynik |
|---|---|
| Ekstrakcja | **świat strony youtube.com** (skrypt wstrzyknięty z `web_accessible_resources`) + własna polityka **Trusted Types** do `eval` |
| Token PO | BgUtils → BotGuard → GenerateIT → minter: działa w świecie strony, TTL 12 h |
| Klient InnerTube | **TV_SIMPLY + token PO**: zakresy początek/środek/koniec = 200/200/200 dla filmu 9 min i 90 min |
| Pobieranie | z tła rozszerzenia (`fetch`, `credentials: 'omit'`, kawałki 10 MB × 4): 163 MB w 4 s (~40 MB/s) |
| MP4 1080p | Mediabunny, bez rekodowania: 0,45 s, avc+aac, 1920×1080, odtwarza się |
| MP3 | Mediabunny + LAME WASM: 9 min audio w 7,4 s (192 kb/s), ID3v2.4 z tytułem, wykonawcą i okładką (APIC) |

## Co NIE zadziałało

| Wariant | Wynik | Wniosek |
|---|---|---|
| Bez tokenu PO (Node i przeglądarka, każdy klient) | 200 tylko na początku, potem 403 | Token PO jest obowiązkowy. |
| BotGuard w piaskownicy content scriptu | `PMD:Undefined` (minter nie dostaje funkcji przez Xray) | Ekstrakcja i BotGuard **muszą** działać w świecie strony. |
| IOS, ANDROID_VR + token PO (webowy) | 200/403/403 | Token z BotGuard WEB nie pasuje do tych klientów. |
| MWEB + token PO | 403 lub 200/403/403 | Nie działa. |
| WEB | brak URL-i (tylko SABR) | Wymagałby implementacji protokołu SABR. |
| HLS | brak `hls_manifest_url` dla filmów VOD | Nie ma tej ścieżki. |
| Koder MP3 przy domyślnym CSP MV2 | Worker z `blob:` i WASM zablokowane | Potrzebny CSP: `script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:`. |

## Ryzyka potwierdzone przez test
- **Działa tylko jeden klient (TV_SIMPLY).** Gdy YouTube go zmieni, potrzebna będzie aktualizacja. Plan B: SABR przez bibliotekę `googlevideo` (LuanRT) z klientem WEB, czyli to, czego używa sam youtube.com.
- Zapis przez `downloads` trafia do folderu Pobrane (preferencja `browser.download.dir` z web-ext została zignorowana, ale to bez znaczenia dla wtyczki).

## Nie przetestowano (do sprawdzenia w kolejnych etapach)
- Shorts, filmy z ograniczeniem wiekowym (wymaga zalogowanego profilu), transmisje.
- MP3 z bardzo długiego audio (> 1 h): czas i pamięć.
- 5 przebiegów z rzędu (wykonano 2 × 2 filmy, wszystkie OK).
- Zachowanie po wygaśnięciu tokenu PO (TTL 12 h) i URL-i (`expire`).
