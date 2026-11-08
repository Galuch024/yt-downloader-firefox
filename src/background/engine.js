// Wybor karty youtube.com, ktora wykona ekstrakcje (ekstraktor dziala tylko w swiecie strony YouTube).

async function ping(tabId) {
  try {
    const r = await Promise.race([
      browser.tabs.sendMessage(tabId, { type: 'ping' }),
      new Promise((res) => setTimeout(() => res(null), 1500)),
    ]);
    return r?.pong === true;
  } catch { return false; }
}

async function findTab(preferTabId) {
  if (preferTabId != null && (await ping(preferTabId))) return preferTabId;
  const tabs = await browser.tabs.query({ url: '*://www.youtube.com/*' });
  tabs.sort((a, b) => Number(b.active) - Number(a.active));
  for (const t of tabs) if (await ping(t.id)) return t.id;
  return null;
}

async function waitForContent(tabId, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await ping(tabId)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Nie udalo sie uruchomic karty YouTube do pobierania');
}

/** Karty otwarte automatycznie jako "silnik" - zamykane po zakonczeniu zadan. */
const engineTabs = new Map(); // tabId -> liczba aktywnych uzytkownikow

export async function acquireExtractorTab(preferTabId) {
  const found = await findTab(preferTabId);
  if (found != null) return { tabId: found, release: () => {} };
  const tab = await browser.tabs.create({ url: 'https://www.youtube.com/', active: false });
  engineTabs.set(tab.id, 0);
  await waitForContent(tab.id);
  return { tabId: tab.id, release: () => {} , engine: true };
}

export function holdEngineTab(tabId) {
  if (engineTabs.has(tabId)) engineTabs.set(tabId, engineTabs.get(tabId) + 1);
}

export function releaseEngineTab(tabId) {
  if (!engineTabs.has(tabId)) return;
  const n = engineTabs.get(tabId) - 1;
  if (n > 0) { engineTabs.set(tabId, n); return; }
  engineTabs.delete(tabId);
  browser.tabs.remove(tabId).catch(() => {});
}

export async function extractOnTab(tabId, videoId) {
  const r = await browser.tabs.sendMessage(tabId, { type: 'extract', videoId });
  if (!r?.ok) {
    const e = new Error(r?.error?.message || 'Ekstrakcja nie powiodla sie');
    e.code = r?.error?.code;
    throw e;
  }
  return r.result;
}

/** Ekstrakcja informacji o filmie na dowolnej dzialajacej karcie YouTube (lub nowej karcie-silniku). */
export async function extractVideo(videoId, preferTabId) {
  const { tabId, engine } = await acquireExtractorTab(preferTabId);
  if (engine) holdEngineTab(tabId);
  try {
    const info = await extractOnTab(tabId, videoId);
    return { info, tabId, engine: !!engine };
  } catch (e) {
    if (engine) releaseEngineTab(tabId);
    throw e;
  }
}
