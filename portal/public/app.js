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
  card.hidden = !needs || state.tab === 'search';
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
function route() {
  const [tab, ...rest] = location.hash.slice(1).split('/');
  state.tab = ['downloads', 'files', 'search'].includes(tab) ? tab : 'downloads';
  document.querySelectorAll('.tabs a').forEach((a) => {
    if (a.dataset.tab === state.tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  for (const t of ['downloads', 'files', 'search']) $(`#tab-${t}`).hidden = t !== state.tab;
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
    state.filesPath = decodeURIComponent(rest.join('/'));
    if (linked) loadFiles();
  }
}
window.addEventListener('hashchange', route);

// ---------- torrents ----------
const STATUS = {
  0: ['En pause', ''], 1: ['Vérification en attente', 'warn'], 2: ['Vérification', 'warn'],
  3: ['En file d\'attente', ''], 4: ['Téléchargement', 'ok'], 5: ['En attente de partage', ''], 6: ['Partage', 'ok'],
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

// ---------- files ----------
const ICONS = { video: '🎬', audio: '🎵', image: '🖼️', text: '📄', archive: '📦', other: '📄' };
const KIND = {
  video: /\.(mp4|m4v|mkv|webm|avi|mov|wmv|ts)$/i, audio: /\.(mp3|flac|m4a|ogg|opus|wav|aac)$/i,
  image: /\.(jpe?g|png|gif|webp)$/i, text: /\.(txt|nfo|srt|sub|pdf|log)$/i, archive: /\.(zip|rar|7z|tar|gz|iso)$/i,
};
const kindOf = (name) => Object.keys(KIND).find((k) => KIND[k].test(name)) || 'other';
// Kinds the browser can usually open (mkv/avi often cannot: download them, or use VLC)
const playable = (name) => /\.(mp4|m4v|webm|mp3|m4a|flac|ogg|opus|wav|jpe?g|png|gif|webp|pdf|txt|nfo|srt|log)$/i.test(name);

async function loadFiles() {
  const p = state.filesPath;
  const parts = p ? p.split('/') : [];
  $('#crumbs').replaceChildren(
    h('a', { href: '#files' }, 'Downloads'),
    ...parts.flatMap((part, i) => [' / ', h('a', { href: `#files/${encodePath(parts.slice(0, i + 1).join('/'))}` }, part)]),
  );
  let data;
  try {
    data = await api('GET', `/api/files?path=${encodeURIComponent(p)}`);
  } catch (err) {
    if (!err.needsLink) $('#files').replaceChildren(h('p', { class: 'empty' }, err.message));
    return;
  }
  if (!data.entries.length) {
    $('#files').replaceChildren(h('p', { class: 'empty' }, 'Dossier vide.'));
    return;
  }
  $('#files').replaceChildren(...data.entries.map((e) => {
    const rel = p ? `${p}/${e.name}` : e.name;
    if (e.type === 'dir') {
      return h('div', { class: 'item file-row' },
        h('span', { class: 'icon' }, '📁'),
        h('span', { class: 'name' }, h('a', { href: `#files/${encodePath(rel)}` }, e.name)),
        h('span', { class: 'muted small' }, date(e.mtime)));
    }
    const href = `/files/${encodePath(rel)}`;
    return h('div', { class: 'item file-row' },
      h('span', { class: 'icon' }, ICONS[kindOf(e.name)]),
      h('span', { class: 'name' }, h('a', { href, download: e.name }, e.name), h('div', { class: 'muted small' }, `${size(e.size)} · ${date(e.mtime)}`)),
      h('span', { class: 'item-actions' },
        playable(e.name) ? h('a', { class: 'btn secondary small', href: `${href}?inline=1`, target: '_blank', rel: 'noopener' }, 'Ouvrir') : null,
        h('a', { class: 'btn primary small', href, download: e.name }, 'Télécharger')),
    );
  }));
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
