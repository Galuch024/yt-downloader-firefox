// Przycisk "Pobierz" w pasku odtwarzacza YouTube + menu wyboru formatu w stylu menu ustawien.
// Bez innerHTML (YouTube wymusza Trusted Types) - elementy budowane przez createElement(NS).
import { videoQualities, formatBytes } from '../shared/util.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_DOWNLOAD = 'M12 3a1 1 0 0 1 1 1v9.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V4a1 1 0 0 1 1-1zM5 19a1 1 0 1 0 0 2h14a1 1 0 1 0 0-2H5z';
const ICON_CHECK = 'M9.55 17.6 4.3 12.35l1.4-1.4 3.85 3.85 8.75-8.75 1.4 1.4z';
const ICON_ERROR = 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2zm0-4h-2V7h2z';
const ICON_MUSIC = 'M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z';
const ICON_VIDEO = 'M4 5h12a2 2 0 0 1 2 2v2.5l4-2.5v10l-4-2.5V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z';
const RING_R = 10.5;
const RING_C = 2 * Math.PI * RING_R;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function svg(viewBox, paths, cls) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', viewBox);
  s.setAttribute('width', '24');
  s.setAttribute('height', '24');
  s.setAttribute('aria-hidden', 'true');
  if (cls) s.setAttribute('class', cls);
  for (const [d, pcls] of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'currentColor');
    if (pcls) p.setAttribute('class', pcls);
    s.append(p);
  }
  return s;
}

const stopAll = (node) => {
  for (const t of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'keydown', 'keyup', 'wheel', 'contextmenu']) {
    node.addEventListener(t, (e) => { e.stopPropagation(); if (t === 'contextmenu') e.preventDefault(); });
  }
};

export class PlayerButton {
  /**
   * @param {{getVideoId: () => string|null, loadInfo: (id: string) => Promise<any>, onChoose: (mode: string, quality: string|null) => Promise<void>, getSettings: () => Promise<any>}} deps
   */
  constructor(deps) {
    this.deps = deps;
    this.btn = null;
    this.menu = null;
    this.tooltip = null;
    this.job = null;
    this.flashTimer = null;
  }

  /** Wstawia przycisk, jesli go nie ma (wywolywane cyklicznie - YouTube przebudowuje odtwarzacz). */
  ensure() {
    const player = document.querySelector('#movie_player.html5-video-player');
    if (!player) return false;
    const controls = player.querySelector('.ytp-right-controls');
    if (!controls) return false;
    if (this.btn && controls.contains(this.btn)) return true;
    this.closeMenu();
    this.player = player;
    this.btn ??= this.buildButton();

    const settings = controls.querySelector('.ytp-settings-button');
    const leftGroup = controls.querySelector('.ytp-right-controls-left');
    if (settings?.parentElement) settings.after(this.btn);
    else if (leftGroup) leftGroup.append(this.btn);
    else controls.prepend(this.btn);
    this.render();
    return true;
  }

  buildButton() {
    const b = el('button', 'ytp-button ytdl-btn');
    b.type = 'button';
    b.setAttribute('aria-label', 'Pobierz');
    b.setAttribute('aria-haspopup', 'true');
    b.setAttribute('aria-expanded', 'false');
    b.dataset.priority = '6';

    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', '24');
    s.setAttribute('height', '24');
    s.setAttribute('class', 'ytdl-btn-svg');
    const track = document.createElementNS(SVG_NS, 'circle');
    track.setAttribute('class', 'ytdl-ring-track');
    const ring = document.createElementNS(SVG_NS, 'circle');
    ring.setAttribute('class', 'ytdl-ring');
    for (const c of [track, ring]) { c.setAttribute('cx', '12'); c.setAttribute('cy', '12'); c.setAttribute('r', String(RING_R)); }
    ring.setAttribute('stroke-dasharray', String(RING_C));
    ring.setAttribute('stroke-dashoffset', String(RING_C));
    const icon = document.createElementNS(SVG_NS, 'path');
    icon.setAttribute('class', 'ytdl-icon');
    icon.setAttribute('fill', 'currentColor');
    icon.setAttribute('d', ICON_DOWNLOAD);
    s.append(track, ring, icon);
    b.append(s);
    this.ringEl = ring;
    this.iconEl = icon;

    stopAll(b);
    b.addEventListener('click', () => (this.menu ? this.closeMenu() : this.openMenu()));
    b.addEventListener('mouseenter', () => this.showTooltip());
    b.addEventListener('mouseleave', () => this.hideTooltip());
    b.addEventListener('focus', () => this.showTooltip());
    b.addEventListener('blur', () => this.hideTooltip());
    return b;
  }

  // ------------------------------------------------------------ tooltip

  tooltipText() {
    const j = this.job;
    if (j && ['queued', 'downloading', 'processing', 'saving'].includes(j.state)) {
      const pct = Math.round((j.progress || 0) * 100);
      return `${j.label}: ${j.stage}${j.state === 'downloading' ? ` ${pct}%` : ''}`;
    }
    if (j?.state === 'error' && this.flashTimer) return `Błąd: ${j.error}`;
    if (j?.state === 'done' && this.flashTimer) return `Pobrano ${j.label}`;
    return 'Pobierz (MP3 / MP4)';
  }

  showTooltip() {
    if (this.menu || !this.btn || !this.player) return;
    this.tooltip ??= el('div', 'ytdl-tooltip');
    this.tooltip.textContent = this.tooltipText();
    if (!this.player.contains(this.tooltip)) this.player.append(this.tooltip);
    const pr = this.player.getBoundingClientRect();
    const br = this.btn.getBoundingClientRect();
    this.tooltip.style.visibility = 'hidden';
    this.tooltip.style.display = 'block';
    const tw = this.tooltip.offsetWidth;
    let left = br.left + br.width / 2 - pr.left - tw / 2;
    left = Math.max(8, Math.min(left, pr.width - tw - 8));
    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.bottom = `${pr.bottom - br.top + 10}px`;
    this.tooltip.style.visibility = '';
  }

  hideTooltip() { if (this.tooltip) this.tooltip.style.display = 'none'; }

  // ------------------------------------------------------------ menu

  /**
   * Otwiera menu formatow. Bez argumentu: nad przyciskiem w pasku odtwarzacza.
   * opts = { anchor, placement: 'below' } - menu przypiete (position: fixed) pod dowolnym elementem, np. pod ⋮ na Shorts.
   */
  async openMenu(opts) {
    const videoId = this.deps.getVideoId();
    const o = opts ?? (this.player && this.btn ? { anchor: this.btn, placement: 'above' } : null);
    if (!videoId || !o?.anchor) return;
    this.hideTooltip();
    this.closeMenu();
    const menu = el('div', 'ytdl-menu');
    menu.setAttribute('role', 'menu');
    stopAll(menu);
    menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { this.closeMenu(); o.anchor?.focus?.(); } });
    this.menu = menu;
    this.menuOpts = o;
    this.menuVideoId = videoId;
    if (o.placement === 'below') {
      menu.classList.add('ytdl-menu-floating');
      document.body.append(menu);
    } else {
      this.btn.setAttribute('aria-expanded', 'true');
      this.player.append(menu);
      this.player.classList.add('ytdl-menu-open');
    }
    this.renderLoading();
    this.position();

    // klik w przycisk paska sam przelacza menu; przy menu "plywajacym" kazdy klik poza nim je zamyka
    this.outside = (e) => {
      if (!this.menu || this.menu.contains(e.target)) return;
      if (o.placement !== 'below' && this.btn?.contains(e.target)) return;
      this.closeMenu();
    };
    document.addEventListener('pointerdown', this.outside, true);
    this.onResize = () => this.position();
    window.addEventListener('resize', this.onResize);
    document.addEventListener('fullscreenchange', this.onResize);

    try {
      const [info, settings] = await Promise.all([this.deps.loadInfo(videoId), this.deps.getSettings()]);
      if (this.menu !== menu) return;
      this.renderOptions(info, settings);
    } catch (e) {
      if (this.menu !== menu) return;
      this.renderError(e);
    }
    this.position();
  }

  closeMenu() {
    if (!this.menu) return;
    this.menu.remove();
    this.menu = null;
    this.player?.classList.remove('ytdl-menu-open');
    this.btn?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', this.outside, true);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('fullscreenchange', this.onResize);
  }

  position() {
    const o = this.menuOpts;
    if (!this.menu || !o) return;
    if (o.placement === 'below') {
      let r = o.anchor.isConnected ? o.anchor.getBoundingClientRect() : null;
      if (!r || !r.width) r = o.fallbackRect?.() ?? r;
      if (!r) return;
      const top = Math.round(r.bottom + 8);
      this.menu.style.top = `${top}px`;
      this.menu.style.right = `${Math.max(12, Math.round(window.innerWidth - r.right))}px`;
      this.menu.style.maxHeight = `${Math.max(160, window.innerHeight - top - 16)}px`;
      return;
    }
    if (!this.player || !this.btn) return;
    const pr = this.player.getBoundingClientRect();
    const br = this.btn.getBoundingClientRect();
    const right = Math.max(12, pr.right - br.right - 8);
    this.menu.style.right = `${right}px`;
    this.menu.style.bottom = `${Math.max(12, pr.bottom - br.top + 12)}px`;
    this.menu.style.maxHeight = `${Math.max(160, br.top - pr.top - 24)}px`;
  }

  header(text, sub) {
    const h = el('div', 'ytdl-menu-header');
    h.append(el('span', 'ytdl-menu-title', text));
    if (sub) h.append(el('span', 'ytdl-menu-sub', sub));
    return h;
  }

  renderLoading() {
    this.menu.replaceChildren(this.header('Pobierz'), Object.assign(el('div', 'ytdl-menu-loading'), {}));
    const box = this.menu.lastChild;
    box.append(el('span', 'ytdl-spinner'), el('span', null, 'Sprawdzam dostępne formaty…'));
  }

  renderError(e) {
    const box = el('div', 'ytdl-menu-error');
    box.append(svg('0 0 24 24', [[ICON_ERROR]], 'ytdl-error-icon'), el('div', 'ytdl-error-text', errorText(e)));
    const retry = el('button', 'ytdl-menu-item ytdl-retry', 'Spróbuj ponownie');
    retry.type = 'button';
    retry.addEventListener('click', () => { this.deps.invalidate?.(this.menuVideoId); this.openMenu(); });
    this.menu.replaceChildren(this.header('Pobierz'), box, retry);
  }

  item(iconPath, label, secondary, badge, onClick) {
    const b = el('button', 'ytdl-menu-item');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.append(svg('0 0 24 24', [[iconPath]], 'ytdl-item-icon'));
    const l = el('span', 'ytdl-item-label', label);
    if (badge) l.append(el('sup', 'ytdl-badge', badge));
    b.append(l);
    if (secondary) b.append(el('span', 'ytdl-item-secondary', secondary));
    b.addEventListener('click', async () => {
      this.closeMenu();
      try { await onClick(); } catch (e) { this.flash({ state: 'error', error: errorText(e), label: label }); }
    });
    return b;
  }

  renderOptions(info, settings) {
    const dur = info.duration ? fmtDuration(info.duration) : null;
    const nodes = [this.header('Pobierz', dur)];

    nodes.push(el('div', 'ytdl-menu-section', 'Audio'));
    const audio = info.audios.find((a) => a.mime.includes('mp4a')) || info.audios[0];
    nodes.push(this.item(ICON_MUSIC, 'MP3', `${settings.mp3Bitrate} kb/s${audio?.size ? ` · ~${formatBytes((info.duration || 0) * settings.mp3Bitrate * 125)}` : ''}`, null,
      () => this.deps.onChoose('mp3', null)));

    const qualities = videoQualities(info);
    nodes.push(el('div', 'ytdl-menu-section', 'Wideo MP4'));
    if (!qualities.length) nodes.push(el('div', 'ytdl-menu-empty', 'Brak strumieni H.264 dla tego filmu'));
    for (const q of qualities) {
      const v = info.videos.find((x) => String(x.height) === q.quality);
      const size = v && audio ? formatBytes((v.size || 0) + (audio.size || 0)) : null;
      nodes.push(this.item(ICON_VIDEO, q.label, size, q.hd ? 'HD' : null, () => this.deps.onChoose('mp4', q.quality)));
    }
    this.menu.replaceChildren(...nodes);
    this.menu.querySelector('.ytdl-menu-item')?.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------ stan zadania

  onJob(job) {
    if (job.videoId !== this.deps.getVideoId()) return;
    this.job = job;
    if (job.state === 'done' || job.state === 'error') this.flash(job);
    this.render();
    if (this.tooltip?.style.display === 'block') this.tooltip.textContent = this.tooltipText();
  }

  flash(job) {
    this.job = { ...this.job, ...job };
    this.deps.onFlash?.(this.job);
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => { this.flashTimer = null; this.render(); }, job.state === 'error' ? 8000 : 4000);
    this.render();
  }

  reset() {
    this.job = null;
    clearTimeout(this.flashTimer);
    this.flashTimer = null;
    this.closeMenu();
    this.render();
  }

  render() {
    if (!this.btn) return;
    const j = this.job;
    const active = j && ['queued', 'downloading', 'processing', 'saving'].includes(j.state);
    this.btn.classList.toggle('ytdl-active', !!active);
    this.btn.classList.toggle('ytdl-indeterminate', !!active && j.state !== 'downloading');
    this.btn.classList.toggle('ytdl-done', !active && j?.state === 'done' && !!this.flashTimer);
    this.btn.classList.toggle('ytdl-failed', !active && j?.state === 'error' && !!this.flashTimer);
    const p = active ? Math.max(0.02, j.progress || 0) : 0;
    this.ringEl.setAttribute('stroke-dashoffset', String(RING_C * (1 - p)));
    this.iconEl.setAttribute('d', this.btn.classList.contains('ytdl-done') ? ICON_CHECK : this.btn.classList.contains('ytdl-failed') ? ICON_ERROR : ICON_DOWNLOAD);
    this.btn.setAttribute('aria-label', this.tooltipText());
  }
}

function fmtDuration(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

export function errorText(e) {
  const code = e?.code;
  if (code === 'LOGIN_REQUIRED') return 'Ten film wymaga zalogowania (np. ograniczenie wiekowe).';
  if (code === 'LIVE') return 'Transmisji na żywo nie można pobrać.';
  if (code === 'BLOCKED') return 'YouTube zablokował pobieranie. Spróbuj odświeżyć stronę.';
  return e?.message || String(e);
}
