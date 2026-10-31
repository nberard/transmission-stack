// Front-end of the downloads portal: no framework, no build step.
'use strict';

const $ = (sel) => document.querySelector(sel);
const state = { me: null, tab: 'downloads', filesPath: '', timer: null, lastQuery: null };

// ---------- helpers ----------
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM: allowed by the CSP, unlike a style attribute
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

class ApiError extends Error {}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'X-Portal': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') {
    showLogin();
    throw new ApiError(data.error || 'Connexion requise');
  }
  if (data.needsLink) {
    state.me.transmission = null;
    renderLinkCard(data.error);
  }
  if (!res.ok) {
    const err = new ApiError(data.error || `Erreur ${res.status}`);
    err.needsLink = Boolean(data.needsLink);
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

const UNITS = ['o', 'Ko', 'Mo', 'Go', 'To'];
function size(n) {
  if (n == null) return '';
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1).replace('.', ',')} ${UNITS[i]}`;
}
const speed = (n) => (n > 0 ? `${size(n)}/s` : '—');
function eta(s) {
  if (s < 0) return '';
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  return `${Math.round(s / 86400)} j`;
}
const date = (iso) => (iso ? new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

// ---------- sign-in ----------
function showLogin() {
  clearInterval(state.timer);
  state.me = null;
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-form [name=username]').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('button');
  btn.disabled = true;
  $('#login-error').hidden = true;
  try {
    await api('POST', '/api/login', { username: f.username.value, password: f.password.value });
    f.password.value = '';
    await start();
  } catch (err) {
    $('#login-error').textContent = err.message;
    $('#login-error').hidden = false;
  } finally {
    btn.disabled = false;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  showLogin();
});

// ---------- Transmission link ----------
function renderLinkCard(message) {
  const card = $('#link-card');
  const needs = state.me && !state.me.transmission && state.me.canLink;
  card.hidden = !needs || state.tab === 'search' || state.tab === 'shared';
  if (message) $('#link-error').textContent = message;
  $('#link-error').hidden = !message;
}

$('#link-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const r = await api('POST', '/api/link', { transmission: f.transmission.value, password: f.password.value });
    f.password.value = '';
    state.me.transmission = r.transmission;
    renderLinkCard();
    renderWho();
    toast(`Relié au Transmission « ${r.transmission} »`);
    route();
  } catch (err) {
    $('#link-error').textContent = err.message;
    $('#link-error').hidden = false;
  }
});

function renderWho() {
  const { user, transmission } = state.me;
  $('#who').textContent = transmission && transmission !== user ? `${user} (Transmission : ${transmission})` : user;
}

// ---------- tabs ----------
// #downloads · #files/<path> · #shared · #shared/<id>/<path> · #search
const TABS = ['downloads', 'files', 'shared', 'search'];
function route() {
  const [tab, ...rest] = location.hash.slice(1).split('/');
  state.tab = TABS.includes(tab) ? tab : 'downloads';
  document.querySelectorAll('.tabs a').forEach((a) => {
    if (a.dataset.tab === state.tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  for (const t of TABS) $(`#tab-${t}`).hidden = t !== state.tab;
  renderLinkCard();
  clearInterval(state.timer);
  const linked = Boolean(state.me.transmission);
  if (state.tab === 'downloads') {
    $('#tab-downloads').hidden = !linked;
    if (linked) {
      loadTorrents();
      state.timer = setInterval(() => document.visibilityState === 'visible' && loadTorrents(), 3000);
    }
  } else if (state.tab === 'files') {
    $('#tab-files').hidden = !linked;
    if (linked) loadFiles(null, decodeURIComponent(rest.join('/')));
  } else if (state.tab === 'shared') {
    if (rest[0]) loadFiles(rest[0], decodeURIComponent(rest.slice(1).join('/')));
    else loadShares();
  }
}
window.addEventListener('hashchange', route);

// ---------- torrents ----------
const STATUS = {
  0: ['En pause', ''], 1: ['Vérification en attente', 'warn'], 2: ['Vérification', 'warn'],
  3: ['En file d\'attente', ''], 4: ['Téléchargement', 'ok'], 5: ['Terminé, seed en attente', ''], 6: ['Terminé, en seed', 'ok'],
};

async function loadTorrents() {
  let data;
  try {
    data = await api('GET', '/api/torrents');
  } catch (err) {
    if (!err.needsLink) $('#torrents').replaceChildren(h('p', { class: 'empty' }, err.message));
    return;
  }
  $('#speeds').textContent = `${data.torrents.length} torrent${data.torrents.length > 1 ? 's' : ''} · ↓ ${speed(data.stats.downloadSpeed)} · ↑ ${speed(data.stats.uploadSpeed)}`;
  if (!data.torrents.length) {
    $('#torrents').replaceChildren(h('p', { class: 'empty' }, 'Aucun torrent. Colle un lien magnet ci-dessus ou cherche dans l\'onglet « Chercher ».'));
    return;
  }
  $('#torrents').replaceChildren(...data.torrents.map(torrentItem));
}

function torrentItem(t) {
  const done = t.percentDone >= 1;
  const paused = t.status === 0;
  const [label, tone] = t.error ? [t.errorString || 'Erreur', 'err'] : STATUS[t.status] || ['', ''];
  const pct = Math.floor(t.percentDone * 1000) / 10;
  const meta = [
    h('span', {}, h('span', { class: `badge ${tone}` }, label)),
    h('span', {}, done ? size(t.sizeWhenDone) : `${size(t.sizeWhenDone - t.leftUntilDone)} / ${size(t.sizeWhenDone)} (${String(pct).replace('.', ',')} %)`),
  ];
  if (t.status === 4) meta.push(h('span', {}, `↓ ${speed(t.rateDownload)}`), h('span', {}, eta(t.eta) && `reste ${eta(t.eta)}`));
  if (t.rateUpload > 0) meta.push(h('span', {}, `↑ ${speed(t.rateUpload)}`));
  if (t.metadataPercentComplete < 1) meta.push(h('span', {}, 'récupération des infos du torrent…'));
  if (done) meta.push(h('span', {}, `ratio ${t.uploadRatio >= 0 ? t.uploadRatio.toFixed(2).replace('.', ',') : '0'}`));

  const act = async (fn, okMsg) => {
    try { await fn(); if (okMsg) toast(okMsg); loadTorrents(); } catch (err) { toast(err.message); }
  };
  return h('article', { class: 'item' },
    h('div', { class: 'item-head' },
      h('div', { class: 'item-name' }, t.name),
      h('div', { class: 'item-actions' },
        done && t.path ? h('a', { class: 'btn secondary small', href: `#files/${encodePath(t.path)}` }, 'Ouvrir') : null,
        h('button', { class: 'btn secondary small', type: 'button', onclick: () => act(() => api('POST', `/api/torrents/${t.id}/${paused ? 'start' : 'stop'}`)) }, paused ? 'Reprendre' : 'Pause'),
        h('button', {
          class: 'btn danger small', type: 'button',
          onclick: () => {
            if (!confirm(`Retirer « ${t.name} » de Transmission ?`)) return;
            const wipe = confirm('Supprimer aussi les fichiers téléchargés ?\n\nOK : supprimer les fichiers · Annuler : les garder');
            act(() => api('DELETE', `/api/torrents/${t.id}${wipe ? '?deleteData=1' : ''}`), wipe ? 'Torrent et fichiers supprimés' : 'Torrent retiré (fichiers gardés)');
          },
        }, 'Retirer'),
      ),
    ),
    h('div', { class: `progress ${done ? 'done' : paused ? 'paused' : ''}` }, h('span', { style: `width:${pct}%` })),
    h('div', { class: 'item-meta' }, meta),
  );
}

async function addTorrent(magnet) {
  const r = await api('POST', '/api/torrents', { magnet });
  toast(r.duplicate ? `Déjà dans tes torrents : ${r.name || ''}` : `Ajouté : ${r.name || 'torrent'}`);
  return r;
}

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await addTorrent(e.target.magnet.value.trim());
    e.target.magnet.value = '';
    loadTorrents();
  } catch (err) {
    toast(err.message);
  }
});

// ---------- files (mine, or inside a share) ----------
const ICONS = { video: '🎬', audio: '🎵', image: '🖼️', text: '📄', archive: '📦', other: '📄' };
const KIND = {
  video: /\.(mp4|m4v|mkv|webm|avi|mov|wmv|ts|m2ts|flv|mpg|mpeg)$/i, audio: /\.(mp3|flac|m4a|ogg|opus|wav|aac|wma)$/i,
  image: /\.(jpe?g|png|gif|webp)$/i, text: /\.(txt|nfo|srt|sub|pdf|log)$/i, archive: /\.(zip|rar|7z|tar|gz|iso)$/i,
};
const kindOf = (name) => Object.keys(KIND).find((k) => KIND[k].test(name)) || 'other';
const viewable = (name) => /\.(jpe?g|png|gif|webp|pdf|txt|nfo|srt|log)$/i.test(name);
const playable = (name) => ['video', 'audio'].includes(kindOf(name));

// URL of a file: /files/<path> for mine, /shared/<id>/<path> inside a share
const fileUrl = (share, rel) => (share ? `/shared/${share}/${encodePath(rel)}` : `/files/${encodePath(rel)}`);
const dirHash = (share, rel) => (share ? `#shared/${share}${rel ? '/' + encodePath(rel) : ''}` : `#files${rel ? '/' + encodePath(rel) : ''}`);

async function loadFiles(share, p) {
  const target = share ? '#shared-list' : '#files';
  const crumbs = share ? '#shared-crumbs' : '#crumbs';
  const parts = p ? p.split('/') : [];
  let shareInfo = null;
  let myShares = [];
  try {
    const all = (await api('GET', '/api/shares')).shares;
    if (share) {
      shareInfo = all.find((s) => s.id === share);
      if (!shareInfo) throw new ApiError("Ce partage n'existe plus");
    } else {
      myShares = all.filter((s) => s.mine);
    }
  } catch (err) {
    $(target).replaceChildren(h('p', { class: 'empty' }, err.message));
    return;
  }
  $(crumbs).hidden = false;
  $(crumbs).replaceChildren(
    share ? h('a', { href: '#shared' }, 'Partagé') : h('a', { href: '#files' }, 'Downloads'),
    ...(share ? [' / ', h('a', { href: dirHash(share, '') }, shareInfo.name)] : []),
    ...parts.flatMap((part, i) => [' / ', h('a', { href: dirHash(share, parts.slice(0, i + 1).join('/')) }, part)]),
  );
  let data;
  try {
    data = await api('GET', `/api/files?path=${encodeURIComponent(p)}${share ? `&share=${share}` : ''}`);
  } catch (err) {
    if (!err.needsLink) $(target).replaceChildren(h('p', { class: 'empty' }, err.message));
    return;
  }
  if (!data.entries.length) {
    $(target).replaceChildren(h('p', { class: 'empty' }, 'Dossier vide.'));
    return;
  }
  // The real path of the folder in its owner's Downloads, to know what is already shared
  const sharedPaths = new Map(myShares.map((s) => [s.path, s]));
  $(target).replaceChildren(...data.entries.map((e) => {
    const rel = p ? `${p}/${e.name}` : e.name;
    return entryRow(e, { share, rel, siblings: data.entries, shared: share ? null : sharedPaths.get(rel) || false });
  }));
}

// One file or folder line. ctx: { share, rel, siblings, shared: share object | false | null (null: inside a share) }
function entryRow(e, ctx) {
  const { share, rel } = ctx;
  const actions = [];
  let nameEl;
  if (e.type === 'dir') {
    nameEl = h('a', { href: dirHash(share, rel) }, e.name);
  } else {
    const href = fileUrl(share, rel);
    nameEl = h('a', { href, download: e.name }, e.name);
    if (playable(e.name)) {
      actions.push(h('button', { class: 'btn primary small', type: 'button', onclick: () => openPlayer({ share, rel, name: e.name, siblings: ctx.siblings }) }, '▶ Lire'));
      actions.push(h('button', { class: 'btn secondary small', type: 'button', title: 'Lien pour VLC, une TV ou une appli', onclick: () => playerLink(share, rel) }, 'VLC'));
    } else if (viewable(e.name)) {
      actions.push(h('a', { class: 'btn secondary small', href: `${href}?inline=1`, target: '_blank', rel: 'noopener' }, 'Ouvrir'));
    }
    actions.push(h('a', { class: 'btn secondary small', href, download: e.name, title: 'Télécharger' }, '↓'));
  }
  if (ctx.shared !== null && ctx.shared !== undefined) actions.push(shareButton(rel, ctx.shared));
  const meta = [e.size != null ? size(e.size) : null, date(e.mtime)].filter(Boolean).join(' · ');
  return h('div', { class: 'item file-row' },
    h('span', { class: 'icon' }, e.type === 'dir' ? '📁' : ICONS[kindOf(e.name)]),
    h('span', { class: 'name' }, nameEl, h('div', { class: 'muted small' }, meta)),
    h('span', { class: 'item-actions' }, actions),
  );
}

function shareButton(rel, shared) {
  const btn = h('button', {
    class: `btn small ${shared ? 'shared-on' : 'secondary'}`, type: 'button',
    title: shared ? 'Visible par tous les potes · cliquer pour arrêter' : 'Rendre visible par tous les potes',
    onclick: async () => {
      btn.disabled = true;
      try {
        if (shared) {
          await api('DELETE', `/api/shares/${shared.id}`);
          toast('Ne plus partagé');
        } else {
          await api('POST', '/api/shares', { path: rel });
          toast('Partagé avec les potes (onglet Partagé)');
        }
        route();
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    },
  }, shared ? '✓ Partagé' : 'Partager');
  return btn;
}

// ---------- « Partagé »: what every pote shared ----------
async function loadShares() {
  $('#shared-crumbs').hidden = true;
  let list;
  try {
    list = (await api('GET', '/api/shares')).shares;
  } catch (err) {
    $('#shared-list').replaceChildren(h('p', { class: 'empty' }, err.message));
    return;
  }
  if (!list.length) {
    $('#shared-list').replaceChildren(h('p', { class: 'empty' }, 'Rien de partagé pour l\'instant. Dans « Mes fichiers », le bouton « Partager » rend un fichier ou un dossier visible par tous les potes.'));
    return;
  }
  $('#shared-list').replaceChildren(...list.map((s) => {
    // A share is the root of its own tree: /shared/<id>/ for a file, #shared/<id> for a folder
    const row = entryRow(s, { share: s.id, rel: '', siblings: [] });
    const meta = row.querySelector('.name .muted');
    meta.textContent = `par ${s.by} · ${[s.size != null ? size(s.size) : null, date(s.sharedAt)].filter(Boolean).join(' · ')}`;
    if (s.mine) {
      row.querySelector('.item-actions').append(h('button', {
        class: 'btn danger small', type: 'button',
        onclick: async () => {
          try {
            await api('DELETE', `/api/shares/${s.id}`);
            toast('Ne plus partagé');
            loadShares();
          } catch (err) {
            toast(err.message);
          }
        },
      }, 'Arrêter'));
    }
    return row;
  }));
}

// ---------- link for VLC / TV / phone apps ----------
async function playerLink(share, rel) {
  try {
    const r = await api('POST', '/api/player-link', { path: rel, share });
    const input = h('input', { value: r.url, readonly: true, 'aria-label': 'Lien', onfocus: (e) => e.target.select() });
    const hours = Math.round((new Date(r.expires) - Date.now()) / 3600e3);
    const dlg = modal(
      h('h2', {}, 'Lire ailleurs'),
      h('p', { class: 'muted' }, `Colle ce lien dans VLC (Média › Ouvrir un flux réseau), une appli de TV ou un autre lecteur : tous les formats et toutes les pistes y passent. Il marche ${hours} h, pour n'importe qui qui l'a : ne le partage pas.`),
      input,
      h('div', { class: 'row-form' },
        h('button', { class: 'btn primary', type: 'button', onclick: async () => {
          try { await navigator.clipboard.writeText(r.url); toast('Lien copié'); } catch { input.select(); }
        } }, 'Copier'),
        h('a', { class: 'btn secondary', href: `vlc://${r.url}` }, 'Ouvrir dans VLC'),
        h('button', { class: 'btn link', type: 'button', onclick: () => dlg.close() }, 'Fermer')),
    );
    input.select();
  } catch (err) {
    toast(err.message);
  }
}

function modal(...children) {
  const box = h('div', { class: 'modal card', role: 'dialog', 'aria-modal': 'true' }, children);
  const back = h('div', { class: 'backdrop', onclick: (e) => e.target === back && close() }, box);
  const onKey = (e) => e.key === 'Escape' && close();
  function close() {
    back.remove();
    document.removeEventListener('keydown', onKey);
  }
  document.addEventListener('keydown', onKey);
  document.body.append(back);
  return { close, el: box };
}

// ---------- player ----------
// "direct": the browser reads the file itself (mp4/webm with compatible codecs), seeking is native.
// "stream": the server converts on the fly (/stream); seeking restarts the conversion at that time, so the
// player keeps the offset itself. It falls back to "stream" whenever the browser fails to read the file.
const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return (hh ? `${hh}:${String(mm).padStart(2, '0')}` : `${mm}`) + `:${String(ss).padStart(2, '0')}`;
};

// SRT or WebVTT → [{ start, end, text }]
function parseCues(text) {
  const ts = (t) => {
    const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/.exec(t);
    return m ? (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, '0') / 1000 : null;
  };
  const cues = [];
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = ts(a), end = ts(b);
    const body = lines.slice(i + 1).join('\n').replace(/\{\\[^}]*\}/g, '').replace(/<(?!\/?[ibu]>)[^>]+>/g, '').trim();
    if (start != null && end != null && body) cues.push({ start, end, text: body });
  }
  return cues;
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Erreur ${res.status}`);
  const buf = await res.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf); // old French .srt files
  }
}

async function openPlayer({ share, rel, name, siblings = [] }) {
  const q = new URLSearchParams({ path: rel });
  if (share) q.set('share', share);
  let info;
  try {
    info = await api('GET', `/api/media?${q}`);
  } catch (err) {
    toast(err.message);
    return;
  }

  const video = h('video', { playsinline: true, preload: 'auto' });
  const msg = h('div', { class: 'player-msg' });
  const seek = h('input', { type: 'range', min: 0, max: Math.max(1, Math.floor(info.duration || 0)), step: 1, value: 0, 'aria-label': 'Position' });
  const time = h('span', { class: 'player-time' }, `0:00 / ${fmtTime(info.duration)}`);
  const playBtn = h('button', { class: 'pbtn', type: 'button', 'aria-label': 'Lecture' }, '▶');
  const fullBtn = h('button', { class: 'pbtn', type: 'button', 'aria-label': 'Plein écran' }, '⛶');
  const closeBtn = h('button', { class: 'pbtn', type: 'button', 'aria-label': 'Fermer' }, '✕');

  // Audio tracks (VF / VO…): picking one that is not the default needs the converted stream
  const audioSel = h('select', { 'aria-label': 'Piste audio', hidden: info.audio.length < 2 },
    info.audio.map((a) => h('option', { value: a.index, selected: a.index === info.defaultAudio }, `🔊 ${a.label}`)));

  // Subtitles: .srt/.vtt next to the video (same name first), then the ones inside the file
  const base = name.replace(/\.[^.]+$/, '').toLowerCase();
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
  const external = siblings.filter((e) => e.type === 'file' && /\.(srt|vtt)$/i.test(e.name))
    .sort((a, b) => b.name.toLowerCase().startsWith(base) - a.name.toLowerCase().startsWith(base));
  const subOptions = [
    ...external.map((e) => ({ label: e.name.toLowerCase().startsWith(base) ? e.name.slice(base.length).replace(/^[._ -]+/, '') || e.name : e.name, url: fileUrl(share, dir + e.name) })),
    ...info.subtitles.map((s) => ({ label: s.label, url: `/api/subtitle?${q}&track=${s.index}` })),
  ];
  const subSel = h('select', { 'aria-label': 'Sous-titres', hidden: !subOptions.length },
    h('option', { value: '' }, '💬 Sans sous-titres'),
    subOptions.map((o, i) => h('option', { value: i }, `💬 ${o.label}`)));

  const stage = h('div', { class: 'player-stage' }, video, msg);
  const box = h('div', { class: 'player', role: 'dialog', 'aria-modal': 'true', 'aria-label': name },
    h('div', { class: 'player-top' }, h('span', { class: 'player-title' }, name), closeBtn),
    stage,
    h('div', { class: 'player-bar' }, playBtn, time, seek, audioSel, subSel, fullBtn),
  );
  const back = h('div', { class: 'backdrop player-backdrop' }, box);
  document.body.append(back);

  const st = { mode: info.direct ? 'direct' : 'stream', offset: 0, audio: info.defaultAudio, cues: [], dragging: false };
  const now = () => (st.mode === 'direct' ? video.currentTime : st.offset + video.currentTime);
  const say = (text) => { msg.textContent = text || ''; msg.hidden = !text; };

  // A fresh track each time: Chromium keeps showing a removed cue that was on screen
  let track = null;
  function applyCues() {
    if (track) track.mode = 'disabled';
    track = null;
    if (!st.cues.length) return;
    track = video.addTextTrack('subtitles', 'Sous-titres', 'fr');
    const shift = st.mode === 'direct' ? 0 : st.offset;
    for (const c of st.cues) if (c.end > shift) track.addCue(new VTTCue(Math.max(0, c.start - shift), c.end - shift, c.text));
    track.mode = 'showing';
  }

  function load(t, autoplay = true) {
    if (st.mode === 'direct') {
      video.src = `${fileUrl(share, rel)}?inline=1`;
      if (t > 0) video.addEventListener('loadedmetadata', () => (video.currentTime = t), { once: true });
    } else {
      st.offset = Math.max(0, Math.floor(t));
      video.src = `/stream?${q}&t=${st.offset}&audio=${st.audio}`;
      say('Conversion en cours…');
    }
    applyCues();
    if (autoplay) video.play().catch(() => {});
  }

  function seekTo(t) {
    t = Math.min(Math.max(0, t), info.duration || t);
    if (st.mode === 'direct') video.currentTime = t;
    else load(t);
  }

  video.addEventListener('timeupdate', () => {
    if (!st.dragging) seek.value = Math.floor(now());
    time.textContent = `${fmtTime(now())} / ${fmtTime(info.duration)}`;
  });
  video.addEventListener('play', () => (playBtn.textContent = '❚❚'));
  video.addEventListener('pause', () => (playBtn.textContent = '▶'));
  video.addEventListener('waiting', () => say('Chargement…'));
  video.addEventListener('playing', () => say(''));
  video.addEventListener('error', () => {
    if (st.mode === 'direct') {
      // The browser cannot read this file: let the server convert it
      const t = video.currentTime || 0;
      st.mode = 'stream';
      load(t);
    } else if (video.getAttribute('src')) {
      say('Lecture impossible ici. Essaie « VLC » ou télécharge le fichier.');
    }
  });

  seek.addEventListener('input', () => {
    st.dragging = true;
    time.textContent = `${fmtTime(+seek.value)} / ${fmtTime(info.duration)}`;
  });
  seek.addEventListener('change', () => {
    st.dragging = false;
    seekTo(+seek.value);
  });
  playBtn.addEventListener('click', () => (video.paused ? video.play() : video.pause()));
  video.addEventListener('click', () => (video.paused ? video.play() : video.pause()));
  audioSel.addEventListener('change', () => {
    st.audio = +audioSel.value;
    const t = now();
    st.mode = 'stream';
    load(t);
  });
  subSel.addEventListener('change', async () => {
    st.cues = [];
    applyCues();
    if (subSel.value === '') return;
    say('Chargement des sous-titres…');
    try {
      st.cues = parseCues(await fetchText(subOptions[+subSel.value].url));
      applyCues();
      say('');
      if (!st.cues.length) toast('Aucun sous-titre lisible dans ce fichier');
    } catch (err) {
      say('');
      toast(err.message);
    }
  });
  fullBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (box.requestFullscreen) box.requestFullscreen().catch(() => video.webkitEnterFullscreen?.());
    else video.webkitEnterFullscreen?.();
  });

  function onKey(e) {
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT' && e.target !== seek) return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); video.paused ? video.play() : video.pause(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seekTo(now() + 10); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seekTo(now() - 10); }
    else if (e.key === 'f') fullBtn.click();
    else if (e.key === 'Escape' && !document.fullscreenElement) close();
  }
  function close() {
    document.removeEventListener('keydown', onKey);
    video.pause();
    video.removeAttribute('src');
    video.load(); // closes the connection: the server stops the conversion
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    back.remove();
  }
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  // Subtitles on by default when a .srt carries the video's name
  say('');
  load(0);
  const firstExternal = external.findIndex((e) => e.name.toLowerCase().startsWith(base));
  if (firstExternal >= 0) {
    subSel.value = String(firstExternal);
    subSel.dispatchEvent(new Event('change'));
  }
  box.focus();
}

// ---------- search ----------
function fillProviders() {
  const ps = state.me.providers;
  const sel = $('#search-form [name=provider]');
  sel.replaceChildren(...ps.map((p) => h('option', { value: p.id }, p.name)));
  sel.hidden = ps.length < 2;
  fillCategories();
  sel.addEventListener('change', fillCategories);
}
function fillCategories() {
  const p = state.me.providers.find((x) => x.id === $('#search-form [name=provider]').value) || state.me.providers[0];
  $('#search-form [name=cat]').replaceChildren(...(p?.categories || []).map((c) => h('option', { value: c.id }, c.label)));
}

async function runSearch(kind) {
  const f = $('#search-form');
  const params = new URLSearchParams({ provider: f.provider.value, cat: f.cat.value });
  if (kind === 'search') {
    const q = f.q.value.trim();
    if (!q) return f.q.focus();
    params.set('q', q);
  }
  $('#search-info').textContent = 'Recherche…';
  $('#results').replaceChildren();
  try {
    const data = await api('GET', `/api/${kind}?${params}`);
    const name = state.me.providers.find((p) => p.id === data.provider)?.name || '';
    $('#search-info').textContent = data.results.length
      ? `${data.results.length} résultat${data.results.length > 1 ? 's' : ''} sur ${name}${kind === 'top' ? ' (les plus partagés)' : ''}, triés par sources`
      : `Rien trouvé sur ${name}.`;
    const sorted = kind === 'search' ? data.results.sort((a, b) => b.seeders - a.seeders) : data.results;
    $('#results').replaceChildren(...sorted.map(resultItem));
  } catch (err) {
    $('#search-info').textContent = err.message;
  }
}

function resultItem(r) {
  const btn = h('button', {
    class: 'btn primary small', type: 'button',
    disabled: !state.me.transmission,
    title: state.me.transmission ? null : 'Relie d\'abord ton Transmission',
    onclick: async () => {
      btn.disabled = true;
      try {
        await addTorrent(r.magnet);
        btn.textContent = 'Ajouté ✓';
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    },
  }, 'Télécharger');
  return h('article', { class: 'item' },
    h('div', { class: 'item-head' },
      h('div', { class: 'item-name' }, r.name),
      h('div', { class: 'item-actions' },
        h('a', { class: 'btn secondary small', href: r.link, target: '_blank', rel: 'noopener noreferrer' }, 'Fiche'),
        btn),
    ),
    h('div', { class: 'item-meta' },
      r.category ? h('span', { class: 'badge' }, r.category) : null,
      h('span', {}, size(r.size)),
      h('span', {}, h('span', { class: 'seeds' }, `▲ ${r.seeders}`), ` ▼ ${r.leechers}`),
      r.added ? h('span', {}, date(r.added)) : null,
      r.uploader ? h('span', {}, r.uploader, r.trusted ? ' ' : null, r.trusted ? h('span', { class: 'badge ok', title: 'Uploader reconnu' }, '✓ fiable') : null) : null,
    ),
  );
}

$('#search-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch('search'); });
$('#top').addEventListener('click', () => runSearch('top'));

// ---------- start ----------
async function start() {
  try {
    state.me = await api('GET', '/api/me');
  } catch {
    return; // showLogin() already called on 401
  }
  $('#login').hidden = true;
  $('#app').hidden = false;
  renderWho();
  fillProviders();
  route();
}

start();
