// Pliki tymczasowe w prywatnym magazynie wtyczki (OPFS). Dzieki nim duze pobrania (4K/8K, kilka GB)
// trafiaja na dysk zamiast do pamieci RAM. Gdy OPFS jest niedostepny, wolajacy wraca do pamieci.
const DIR = 'ytdl-tmp';
let available = null;
let cleaning = Promise.resolve();

async function tmpDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

/** Czy OPFS dziala (raz na sesje: proba zapisu i odczytu malego pliku). */
export function opfsAvailable() {
  available ??= (async () => {
    try {
      const f = await createTempFile('probe');
      await f.writable.write({ type: 'write', position: 0, data: new Uint8Array([1, 2, 3]) });
      await f.close();
      const ok = (await f.handle.getFile()).size === 3;
      await f.remove();
      return ok;
    } catch (e) {
      console.warn('[ytdl] OPFS niedostepny, pliki beda budowane w pamieci', e);
      return false;
    }
  })();
  return available;
}

/** Nowy plik tymczasowy z otwartym strumieniem zapisu (zapisy z pozycja: {type:'write', position, data}). */
export async function createTempFile(label) {
  await cleaning;
  const dir = await tmpDir();
  const name = `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  let closed = false;
  return {
    name, handle, writable,
    async close() { if (!closed) { closed = true; await writable.close(); } },
    markClosed() { closed = true; },
    /** File czytany z dysku - mozna go podac do BlobSource albo URL.createObjectURL. */
    async file() { return handle.getFile(); },
    async remove() {
      if (!closed) { closed = true; await writable.abort().catch(() => {}); }
      await dir.removeEntry(name).catch(() => {});
    },
  };
}

/** Usuwa pozostalosci po przerwanych zadaniach (np. po zamknieciu przegladarki w trakcie pobierania). */
export function clearTempFiles() {
  cleaning = (async () => {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(DIR, { recursive: true });
    } catch { /* brak katalogu albo OPFS */ }
  })();
  return cleaning;
}
