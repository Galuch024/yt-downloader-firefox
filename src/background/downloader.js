// Pobieranie strumienia googlevideo kawalkami (zakresy po 10 MB, kilka rownolegle, ponawianie).
const CHUNK = 10 * 1024 * 1024;
const PARALLEL = 4;
const RETRIES = 3;

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function probeSize(url, signal) {
  const r = await fetch(`${url}&range=0-0`, { credentials: 'omit', signal });
  await r.arrayBuffer();
  const total = Number(r.headers.get('content-range')?.split('/')[1]);
  if (!r.ok || !total) throw new HttpError(r.status, `Nie mozna ustalic rozmiaru strumienia (HTTP ${r.status})`);
  return total;
}

/**
 * @param {{url: string, size?: number}} format
 * @param {{signal?: AbortSignal, onBytes?: (n: number) => void, refreshUrl?: () => Promise<string>}} opts
 * refreshUrl: wywolywane raz przy 403 (wygasly adres) - zwraca nowy URL tego samego strumienia.
 */
export async function downloadStream(format, { signal, onBytes, refreshUrl } = {}) {
  let url = format.url;
  let refreshed = null;
  const size = format.size || (await probeSize(url, signal));
  const ranges = [];
  for (let s = 0; s < size; s += CHUNK) ranges.push([s, Math.min(s + CHUNK, size) - 1]);
  const parts = new Array(ranges.length);
  let next = 0;

  async function fetchRange(i) {
    const [a, b] = ranges[i];
    for (let attempt = 1; ; attempt++) {
      if (signal?.aborted) throw new DOMException('Anulowano', 'AbortError');
      let r;
      try {
        r = await fetch(`${url}&range=${a}-${b}`, { credentials: 'omit', signal });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        if (attempt >= RETRIES) throw new Error(`Blad sieci przy pobieraniu: ${e.message}`);
        await sleep(800 * attempt);
        continue;
      }
      if (r.ok) {
        const blob = await r.blob();
        if (blob.size !== b - a + 1) {
          if (attempt >= RETRIES) throw new Error(`Niepelny fragment (${blob.size}/${b - a + 1} B)`);
          continue;
        }
        return blob;
      }
      if (r.status === 403 && refreshUrl) {
        refreshed ??= refreshUrl().then((u) => { url = u; });
        await refreshed;
        if (attempt >= RETRIES + 1) throw new HttpError(403, 'Serwer YouTube odmowil dostepu (HTTP 403)');
        continue;
      }
      if (attempt >= RETRIES) throw new HttpError(r.status, `Serwer YouTube zwrocil blad HTTP ${r.status}`);
      await sleep(800 * attempt);
    }
  }

  async function worker() {
    while (next < ranges.length) {
      const i = next++;
      parts[i] = await fetchRange(i);
      onBytes?.(parts[i].size);
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, ranges.length) }, worker));
  return { blob: new Blob(parts, { type: format.mime?.split(';')[0] || 'application/octet-stream' }), size };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
