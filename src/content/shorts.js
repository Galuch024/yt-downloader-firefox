// YouTube Shorts: pozycja "Pobierz" w menu ⋮ odtwarzacza + krotkie powiadomienia (toast).
// Menu ⋮ to wspolny tp-yt-iron-dropdown w ytd-popup-container, wiec pozycje wstrzykujemy tylko
// tuz po kliknieciu ⋮ w odtworzu Shorts i usuwamy ja, gdy dropdown sie zamknie.

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_DOWNLOAD = 'M12 2a1 1 0 0 0-1 1v11.59l-4.29-4.3a1 1 0 1 0-1.42 1.42L12 18.41l6.71-6.7a1 1 0 0 0-1.42-1.42L13 14.59V3a1 1 0 0 0-1-1Zm7 18H5a1 1 0 0 0 0 2h14a1 1 0 0 0 0-2Z';
const MENU_BUTTON = 'ytd-shorts #menu-button, ytd-shorts .ytdShortsPlayerControlsMenuButton';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export const isShortsPage = () => location.pathname.startsWith('/shorts/');

export class ShortsMenu {
  /** @param {{ onActivate: (anchor: Element) => void, label: () => {title: string, secondary?: string} }} deps */
  constructor(deps) {
    this.deps = deps;
    this.anchor = null;
    this.timer = null;
    this.item = null;
    this.dropdown = null;
  }

  start() {
    const arm = (e) => {
      if (!isShortsPage()) return;
      const mb = e.target?.closest?.(MENU_BUTTON);
      if (!mb) return;
      this.anchor = mb.querySelector('button') || mb;
      this.watch();
    };
    document.addEventListener('pointerdown', arm, true);
    document.addEventListener('click', arm, true);
  }

  /** Przez ~2 s szuka otwartego dropdownu i wstawia pozycje; potem pilnuje, by zniknela razem z nim. */
  watch() {
    clearInterval(this.timer);
    const until = Date.now() + 2500;
    this.timer = setInterval(() => {
      if (this.item?.isConnected && this.dropdown) {
        if (!isOpen(this.dropdown)) this.cleanup();
        return;
      }
      if (Date.now() > until) { this.cleanup(); return; }
      const dd = findOpenDropdown();
      if (dd) this.inject(dd);
    }, 60);
  }

  inject(dd) {
    const list = dd.querySelector('yt-list-view-model');
    if (!list) return;
    this.removeItem();
    this.dropdown = dd;
    this.item = this.buildItem(dd);
    list.prepend(this.item);
    dd.dispatchEvent(new Event('iron-resize', { bubbles: true }));
  }

  buildItem(dd) {
    const { title, secondary } = this.deps.label();
    // ta sama struktura i klasy co pozycje YouTube (yt-list-item-view-model), ale w zwyklym <div>,
    // zeby silnik komponentow YouTube nie probowal "ulepszyc" naszego elementu
    const host = el('div', 'ytListItemViewModelHost ytdl-shorts-item');
    host.setAttribute('role', 'presentation');
    const wrap = el('div', `ytListItemViewModelLayoutWrapper ytListItemViewModelContainer ytListItemViewModelCompact ytListItemViewModelTappable ytListItemViewModelInPopup${secondary ? '' : ' ytListItemViewModelNoTrailingText'}`);
    const main = el('div', 'ytListItemViewModelMainContainer');

    const lead = el('div', 'ytListItemViewModelImageContainer ytListItemViewModelLeading');
    lead.setAttribute('aria-hidden', 'true');
    const iconWrap = el('span', 'ytIconWrapperHost ytListItemViewModelAccessory ytListItemViewModelImage');
    const shape = el('span', 'yt-icon-shape ytSpecIconShapeHost');
    const box = el('div');
    box.style.cssText = 'width:100%;height:100%;display:block;fill:currentcolor';
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', '24');
    s.setAttribute('height', '24');
    s.setAttribute('aria-hidden', 'true');
    s.style.cssText = 'pointer-events:none;display:inherit;width:100%;height:100%';
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', ICON_DOWNLOAD);
    s.append(p);
    box.append(s);
    shape.append(box);
    iconWrap.append(shape);
    lead.append(iconWrap);

    const btn = el('button', 'ytButtonOrAnchorHost ytButtonOrAnchorButton ytListItemViewModelButtonOrAnchor ytListItemViewModelTextWrapper');
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    btn.setAttribute('aria-label', title);
    const t1 = el('div');
    const t2 = el('div', 'ytListItemViewModelTitleWrapper');
    t2.append(el('span', 'ytAttributedStringHost ytListItemViewModelTitle ytAttributedStringWhiteSpacePreWrap', title));
    t1.append(t2);
    btn.append(t1);

    main.append(lead, btn);
    if (secondary) main.append(el('span', 'ytAttributedStringHost ytListItemViewModelSelectionText ytListItemViewModelTrailingSelectionText ytAttributedStringWhiteSpacePreWrap', secondary));
    wrap.append(main);
    host.append(wrap);

    host.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const anchor = this.anchor;
      closeDropdown(dd);
      this.cleanup();
      // po zamknieciu dropdownu YouTube przywraca fokus - menu otwieramy w nastepnej klatce
      requestAnimationFrame(() => this.deps.onActivate(anchor));
    });
    return host;
  }

  removeItem() {
    this.item?.remove();
    this.item = null;
    this.dropdown = null;
  }

  cleanup() {
    clearInterval(this.timer);
    this.timer = null;
    this.removeItem();
  }
}

/** Prostokat zapasowy (gdy ⋮ jest ukryty): prawy gorny rog aktywnego odtwarzacza Shorts. */
export function shortsPlayerRect() {
  const players = [...document.querySelectorAll('ytd-shorts #shorts-player, ytd-shorts .html5-video-player')];
  const r = players.map((p) => p.getBoundingClientRect()).find((x) => x.width && x.bottom > 0 && x.top < window.innerHeight);
  if (!r) return null;
  return { top: r.top + 8, bottom: r.top + 48, left: r.right - 48, right: r.right - 8, width: 40, height: 40 };
}

function isOpen(dd) {
  return dd.isConnected && dd.style.display !== 'none' && dd.getAttribute('aria-hidden') !== 'true';
}

function findOpenDropdown() {
  for (const dd of document.querySelectorAll('ytd-popup-container tp-yt-iron-dropdown')) {
    if (isOpen(dd) && dd.querySelector('yt-sheet-view-model yt-list-view-model')) return dd;
  }
  return null;
}

function closeDropdown(dd) {
  try {
    const page = dd.wrappedJSObject; // Firefox: dostep do metod komponentu w swiecie strony
    if (typeof page?.close === 'function') { page.close(); return; }
  } catch { /* nic */ }
  dd.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
}

// ------------------------------------------------------------ toast

let toastEl = null;
let toastTimer = null;
export function toast(text, kind = 'info') {
  toastEl ??= el('div', 'ytdl-toast');
  toastEl.textContent = text;
  toastEl.className = `ytdl-toast ytdl-toast-${kind}`;
  if (!toastEl.isConnected) document.body.append(toastEl);
  requestAnimationFrame(() => toastEl.classList.add('ytdl-toast-show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl?.classList.remove('ytdl-toast-show'), kind === 'error' ? 7000 : 3500);
}
