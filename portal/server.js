// Portail des téléchargements de transmission-stack.
// Friends sign in with their clear-soken account (role "pote", see clear-soken README « Comptes des potes »).
// The portal then shows their torrents, their Downloads folder (read-only) and a torrent search whose
// results are added to their Transmission in one click. Videos play in the browser (converted on the fly by
// ffmpeg when needed), and a pote can share files or folders with every pote (« Partagé »).
// Without COMPTES_JETON (local tests), it falls back to signing in with the Transmission username/password.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TransmissionClient, RpcError, TORRENT_FIELDS } from './lib/transmission.js';
import { listDir, resolveInside, contentType, parseRange, FileError } from './lib/files.js';
import { providers, getProvider, cached } from './lib/providers/index.js';
import { clearSokenAccounts, AccountError } from './lib/accounts.js';
import { LinkStore } from './lib/links.js';
import { ShareStore } from './lib/shares.js';
import { probe, streamArgs, spawnStream, subtitleVtt, MediaError } from './lib/media.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const config = {
  port: Number(process.env.PORT || 8080),
  usersDir: process.env.USERS_DIR || path.resolve(HERE, '../users'),
  // Container of each friend, as started by deploy.sh -H (on the Docker network "proxy")
  transmissionHost: process.env.TRANSMISSION_HOST || 'transmission_stack_transmission_{user}',
  transmissionPort: Number(process.env.TRANSMISSION_PORT || 9091),
  // deploy.sh -H whitelists <user>.<domain> in Transmission: we send that Host header
  domain: process.env.DOMAIN || '',
  secureCookie: process.env.SECURE_COOKIE !== 'false',
  sessionDays: Number(process.env.SESSION_DAYS || 30),
  clearSokenUrl: process.env.CLEARSOKEN_URL || 'http://clearsoken:8080',
  accountsToken: process.env.COMPTES_JETON || '',
  role: process.env.PORTAL_ROLE || 'pote',
  dataDir: process.env.DATA_DIR || path.resolve(HERE, '../portal-data'),
};
const verifyAccount = config.accountsToken ? clearSokenAccounts({ url: config.clearSokenUrl, token: config.accountsToken }) : null;
const links = new LinkStore(path.join(config.dataDir, 'liens.json'));
const shares = new ShareStore(path.join(config.dataDir, 'partages.json'));
// Conversions running at once (each one is an ffmpeg process): one per pote, MAX_STREAMS for the server
const MAX_STREAMS = Number(process.env.MAX_STREAMS || 3);
const streams = new Set();
// Links for VLC & co. (no cookie there): token -> { file, name, expires }
const playerLinks = new Map();
const PLAYER_LINK_HOURS = Number(process.env.PLAYER_LINK_HOURS || 24);

const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const COOKIE = 'portal_session';

// ---------- sessions (memory only: a restart signs everyone out) ----------
// token -> { user, tUser, client, linkKey, expires }
// user: clear-soken account; tUser/client: their Transmission (null until linked); linkKey: to save a link
const sessions = new Map();

function newSession(data) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { ...data, expires: Date.now() + config.sessionDays * 86400e3 });
  return token;
}

function getSession(req) {
  const m = /(?:^|;\s*)portal_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '');
  const s = m && sessions.get(m[1]);
  if (!s) return null;
  if (s.expires < Date.now()) {
    sessions.delete(m[1]);
    return null;
  }
  s.token = m[1];
  return s;
}

setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.expires < now) sessions.delete(t);
}, 3600e3).unref();

function cookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.secureCookie ? '; Secure' : ''}`;
}

// ---------- brute-force protection: 10 failed logins / 15 min per IP ----------
const failures = new Map();
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}
function tooManyFailures(ip) {
  const f = failures.get(ip);
  if (!f || f.until < Date.now()) return false;
  return f.count >= 10;
}
function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || f.until < Date.now()) failures.set(ip, { count: 1, until: Date.now() + 15 * 60e3 });
  else f.count++;
}

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new HttpError(413, 'Requête trop grosse');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON invalide');
  }
}

function clientFor(user, password) {
  return new TransmissionClient({
    host: config.transmissionHost.replaceAll('{user}', user),
    port: config.transmissionPort,
    hostHeader: config.domain ? `${user}.${config.domain}` : undefined,
    username: user,
    password,
  });
}

const downloadsDir = (user) => path.join(config.usersDir, user, 'Downloads');
// A Transmission account = a folder created by deploy.sh; never an arbitrary host
const transmissionExists = (user) => USERNAME_RE.test(user) && fs.existsSync(path.join(config.usersDir, user));

async function works(client) {
  try {
    await client.call('session-get', { fields: ['version'] });
    return true;
  } catch (err) {
    if (err.status === 401) return false;
    throw err;
  }
}

// Sign-in through clear-soken: account with the portal role, then find their Transmission
async function signInPote(user, password) {
  let account;
  try {
    account = await verifyAccount(user, password);
  } catch (err) {
    if (err instanceof AccountError) throw new HttpError(err.status, err.message);
    throw err;
  }
  if (!account.roles.includes(config.role)) {
    throw new HttpError(403, `Ton compte n'a pas le rôle « ${config.role} » : demande à l'admin du serveur`);
  }
  const linkKey = await links.keyFor(account.nom, password);
  const saved = LinkStore.open(linkKey.link, linkKey.key);
  const candidates = [];
  if (saved && transmissionExists(saved.transmission)) candidates.push(saved);
  // Same name and password on both sides: linked without storing anything
  if (transmissionExists(account.nom)) candidates.push({ transmission: account.nom, password });
  for (const c of candidates) {
    const client = clientFor(c.transmission, c.password);
    if (await works(client).catch(() => false)) return { user: account.nom, tUser: c.transmission, client, linkKey };
  }
  return { user: account.nom, tUser: null, client: null, linkKey };
}

// Fallback without clear-soken: the Transmission account is the portal account
async function signInTransmission(user, password) {
  if (!transmissionExists(user)) throw new HttpError(401, 'Identifiant ou mot de passe incorrect');
  const client = clientFor(user, password);
  if (!(await works(client))) throw new HttpError(401, 'Identifiant ou mot de passe incorrect');
  return { user, tUser: user, client, linkKey: null };
}

function needTransmission(session) {
  if (!session.client) {
    const err = new HttpError(409, "Relie d'abord ton Transmission (onglet Téléchargements)");
    err.needsLink = true;
    throw err;
  }
  return session.client;
}

// Where a request's file lives: the pote's own Downloads, or a share (?share=<id>), seen by every pote
async function sourceBase(session, shareId) {
  if (!shareId) {
    needTransmission(session);
    return downloadsDir(session.tUser);
  }
  const share = await shares.get(String(shareId));
  if (!share) throw new HttpError(404, "Ce partage n'existe plus");
  return resolveInside(downloadsDir(share.owner), share.path);
}

async function sourceFile(session, url) {
  const base = await sourceBase(session, url.searchParams.get('share'));
  const file = await resolveInside(base, url.searchParams.get('path') || '');
  if (!(await fsp.stat(file)).isFile()) throw new HttpError(400, "Ce n'est pas un fichier");
  return file;
}

async function shareView(share, session) {
  try {
    const target = await resolveInside(downloadsDir(share.owner), share.path);
    const st = await fsp.stat(target);
    return {
      id: share.id,
      name: path.basename(share.path),
      path: share.path,
      type: st.isDirectory() ? 'dir' : 'file',
      size: st.isDirectory() ? null : st.size,
      mtime: st.mtime.toISOString(),
      sharedAt: share.sharedAt,
      by: share.by,
      mine: share.by === session.user || share.owner === session.tUser,
    };
  } catch {
    return null; // deleted by its owner since
  }
}

// Torrent as shown by the portal; `path` is its location in the Files tab, when inside Downloads
function torrentView(t, user) {
  const root = `/home/${user}/Downloads`;
  const dir = String(t.downloadDir || '').replace(/\/+$/, '');
  let rel = null;
  if (dir === root) rel = t.name;
  else if (dir.startsWith(root + '/')) rel = dir.slice(root.length + 1) + '/' + t.name;
  return { ...t, path: rel };
}

// ---------- API ----------
async function api(req, res, url, session) {
  const route = `${req.method} ${url.pathname}`;

  if (route === 'POST /api/login') {
    const ip = clientIp(req);
    if (tooManyFailures(ip)) throw new HttpError(429, 'Trop de tentatives, réessaie dans 15 minutes');
    const { username = '', password = '' } = await readJson(req);
    const user = String(username).trim().toLowerCase();
    if (!USERNAME_RE.test(user) || !password) {
      recordFailure(ip);
      throw new HttpError(401, 'Identifiant ou mot de passe incorrect');
    }
    let data;
    try {
      data = await (verifyAccount ? signInPote : signInTransmission)(user, String(password));
    } catch (err) {
      if (err.status === 401) recordFailure(ip);
      throw err;
    }
    failures.delete(ip);
    const token = newSession(data);
    return send(res, 200, { user: data.user }, { 'Set-Cookie': cookie(token, config.sessionDays * 86400) });
  }

  if (!session) throw new HttpError(401, 'Connexion requise');
  const { user, tUser } = session;

  if (route === 'POST /api/logout') {
    sessions.delete(session.token);
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
  }

  if (route === 'GET /api/me') {
    return send(res, 200, {
      user,
      transmission: tUser,
      canLink: Boolean(session.linkKey),
      providers: providers.map(({ id, name, categories }) => ({ id, name, categories })),
    });
  }

  // Link this pote to a Transmission account (when its password differs from the clear-soken one)
  if (route === 'POST /api/link') {
    if (!session.linkKey) throw new HttpError(400, 'Rien à relier : tu es connecté avec ton compte Transmission');
    const { transmission = '', password = '' } = await readJson(req);
    const name = String(transmission).trim().toLowerCase();
    if (!transmissionExists(name) || !password) throw new HttpError(401, 'Compte Transmission ou mot de passe incorrect');
    const client = clientFor(name, String(password));
    if (!(await works(client))) throw new HttpError(401, 'Compte Transmission ou mot de passe incorrect');
    await links.save(user, { transmission: name, password: String(password) }, session.linkKey);
    Object.assign(session, { tUser: name, client });
    return send(res, 200, { transmission: name });
  }

  if (route === 'DELETE /api/link') {
    if (!session.linkKey) throw new HttpError(400, 'Rien à délier');
    await links.remove(user);
    Object.assign(session, { tUser: null, client: null });
    return send(res, 200, { ok: true });
  }

  if (route === 'GET /api/torrents') {
    const client = needTransmission(session);
    const [{ torrents }, stats] = await Promise.all([
      client.call('torrent-get', { fields: TORRENT_FIELDS }),
      client.call('session-stats'),
    ]);
    return send(res, 200, {
      torrents: torrents.map((t) => torrentView(t, tUser)).sort((a, b) => b.addedDate - a.addedDate),
      stats: { downloadSpeed: stats.downloadSpeed, uploadSpeed: stats.uploadSpeed },
    });
  }

  if (route === 'POST /api/torrents') {
    const { magnet } = await readJson(req);
    const link = String(magnet || '').trim();
    if (!/^magnet:\?xt=urn:bt(ih|mh):/i.test(link) && !/^https?:\/\/\S+$/i.test(link)) {
      throw new HttpError(400, 'Colle un lien magnet ou une adresse http(s) de fichier .torrent');
    }
    const client = needTransmission(session);
    const r = await client.call('torrent-add', { filename: link });
    const added = r['torrent-added'] || r['torrent-duplicate'];
    return send(res, 200, { id: added?.id, name: added?.name, duplicate: Boolean(r['torrent-duplicate']) });
  }

  const action = /^\/api\/torrents\/(\d+)(?:\/(start|stop))?$/.exec(url.pathname);
  if (action) {
    const ids = [Number(action[1])];
    const client = needTransmission(session);
    if (req.method === 'POST' && action[2]) {
      await client.call(action[2] === 'start' ? 'torrent-start' : 'torrent-stop', { ids });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'DELETE' && !action[2]) {
      await client.call('torrent-remove', { ids, 'delete-local-data': url.searchParams.get('deleteData') === '1' });
      return send(res, 200, { ok: true });
    }
  }

  if (route === 'GET /api/files') {
    const rel = url.searchParams.get('path') || '';
    return send(res, 200, { path: rel, entries: await listDir(await sourceBase(session, url.searchParams.get('share')), rel) });
  }

  // ----- shares -----
  if (route === 'GET /api/shares') {
    const list = await Promise.all((await shares.all()).map((s) => shareView(s, session)));
    return send(res, 200, { shares: list.filter(Boolean).sort((a, b) => b.sharedAt.localeCompare(a.sharedAt)) });
  }

  if (route === 'POST /api/shares') {
    needTransmission(session);
    const rel = String((await readJson(req)).path || '').replace(/^\/+|\/+$/g, '');
    if (!rel) throw new HttpError(400, 'Choisis un fichier ou un dossier');
    const real = await resolveInside(downloadsDir(tUser), rel);
    // Store the path as it really is inside Downloads (no "..", no symlink detour)
    const clean = path.relative(await fsp.realpath(downloadsDir(tUser)), real);
    const share = await shares.add({ owner: tUser, by: user, path: clean });
    return send(res, 200, await shareView(share, session));
  }

  const shareRoute = /^\/api\/shares\/([0-9a-f]{12})$/.exec(url.pathname);
  if (shareRoute && req.method === 'DELETE') {
    const share = await shares.get(shareRoute[1]);
    if (!share) throw new HttpError(404, "Ce partage n'existe plus");
    if (share.by !== user && share.owner !== tUser) throw new HttpError(403, "Seul celui qui l'a partagé peut l'arrêter");
    await shares.remove(share.id);
    return send(res, 200, { ok: true });
  }

  // ----- playback -----
  if (route === 'GET /api/media') {
    try {
      return send(res, 200, await probe(await sourceFile(session, url)));
    } catch (err) {
      if (err instanceof MediaError) throw new HttpError(err.status === 422 ? 422 : 500, 'Fichier illisible : ' + err.message);
      throw err;
    }
  }

  if (route === 'GET /api/subtitle') {
    const file = await sourceFile(session, url);
    let vtt;
    try {
      vtt = await subtitleVtt(file, Math.max(0, Number(url.searchParams.get('track')) || 0));
    } catch (err) {
      if (err instanceof MediaError) throw new HttpError(422, 'Sous-titres illisibles : ' + err.message);
      throw err;
    }
    res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'private, max-age=3600' });
    return res.end(vtt);
  }

  // Link usable without the portal's cookie (VLC, TV, phone app), valid PLAYER_LINK_HOURS
  if (route === 'POST /api/player-link') {
    const { path: rel = '', share = null } = await readJson(req);
    const fake = new URL('http://portal/');
    fake.searchParams.set('path', String(rel));
    if (share) fake.searchParams.set('share', String(share));
    const file = await sourceFile(session, fake);
    const token = crypto.randomBytes(24).toString('base64url');
    const expires = Date.now() + PLAYER_LINK_HOURS * 3600e3;
    playerLinks.set(token, { file, expires });
    const proto = req.headers['x-forwarded-proto'] || (config.secureCookie ? 'https' : 'http');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return send(res, 200, {
      url: `${proto}://${host}/v/${token}/${encodeURIComponent(path.basename(file))}`,
      expires: new Date(expires).toISOString(),
    });
  }

  if (route === 'GET /api/search' || route === 'GET /api/top') {
    const provider = getProvider(url.searchParams.get('provider'));
    if (!provider) throw new HttpError(404, 'Aucune source de recherche activée');
    const cat = url.searchParams.get('cat') || '0';
    let results;
    try {
      if (route === 'GET /api/top') {
        results = await cached(`${provider.id}:top:${cat}`, () => provider.top(cat));
      } else {
        const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
        if (!q) throw new HttpError(400, 'Tape quelque chose à chercher');
        results = await cached(`${provider.id}:q:${cat}:${q.toLowerCase()}`, () => provider.search(q, cat));
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, `${provider.name} ne répond pas (${err.message})`);
    }
    return send(res, 200, { provider: provider.id, results });
  }

  throw new HttpError(404, 'Introuvable');
}

// ---------- files: /files/<path in Downloads>, /shared/<id>/<path in the share>, /v/<token>/<name> ----------
function decodePath(p) {
  try {
    return decodeURIComponent(p);
  } catch {
    throw new HttpError(400, 'Chemin invalide');
  }
}

async function serveFile(req, res, url, session) {
  let file;
  const shared = /^\/shared\/([0-9a-f]{12})(?:\/(.*))?$/.exec(url.pathname);
  const player = /^\/v\/([A-Za-z0-9_-]{32})\/[^/]*$/.exec(url.pathname);
  if (player) {
    const link = playerLinks.get(player[1]);
    if (!link || link.expires < Date.now()) throw new HttpError(404, 'Lien expiré');
    file = link.file;
  } else {
    if (!session) throw new HttpError(401, 'Connexion requise');
    if (shared) file = await resolveInside(await sourceBase(session, shared[1]), decodePath(shared[2] || ''));
    else file = await resolveInside(await sourceBase(session, null), decodePath(url.pathname.slice('/files/'.length)));
  }
  const stat = await fsp.stat(file);
  if (!stat.isFile()) throw new HttpError(400, "Ce n'est pas un fichier");

  const inline = url.searchParams.get('inline') === '1' || Boolean(player);
  const type = inline ? contentType(file) : 'application/octet-stream';
  const name = path.basename(file);
  const headers = {
    'Content-Type': type,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Accept-Ranges': 'bytes',
    'Last-Modified': stat.mtime.toUTCString(),
    'Cache-Control': 'private, no-cache',
    // Files are third-party content: never let them run scripts on the portal's origin
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'",
  };
  const range = parseRange(req.headers.range, stat.size);
  if (range?.invalid) {
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
    return res.end();
  }
  const { start, end } = range || { start: 0, end: stat.size - 1 };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  headers['Content-Length'] = stat.size === 0 ? 0 : end - start + 1;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD' || stat.size === 0) return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

// ---------- on-the-fly conversion: /stream?path=…[&share=…]&t=<seconds>&audio=<track> ----------
async function serveStream(req, res, url, session) {
  if (!session) throw new HttpError(401, 'Connexion requise');
  const file = await sourceFile(session, url);
  const info = await probe(file).catch((err) => {
    throw new HttpError(422, 'Fichier illisible : ' + err.message);
  });
  // Seeking starts a new conversion: stop this pote's previous one first
  if (session.stream) session.stream.kill('SIGKILL');
  if (streams.size >= MAX_STREAMS) throw new HttpError(503, 'Trop de vidéos en lecture sur le serveur, réessaie dans un moment');
  const args = streamArgs(file, info, {
    start: Math.max(0, Number(url.searchParams.get('t')) || 0),
    audio: url.searchParams.has('audio') ? Number(url.searchParams.get('audio')) : info.defaultAudio,
  });
  const child = spawnStream(args);
  streams.add(child);
  session.stream = child;
  let errText = '';
  child.stderr.on('data', (c) => (errText = (errText + c).slice(-1000)));
  child.on('close', (code, signal) => {
    streams.delete(child);
    if (session.stream === child) session.stream = null;
    if (code && !signal) console.error(`ffmpeg ${code}: ${errText.trim()}`);
  });
  child.on('error', (err) => {
    streams.delete(child);
    if (!res.headersSent) send(res, 500, { error: `ffmpeg : ${err.message}` });
    else res.destroy();
  });
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  child.stdout.pipe(res);
  res.on('close', () => child.kill('SIGKILL'));
}

setInterval(() => {
  const now = Date.now();
  for (const [t, l] of playerLinks) if (l.expires < now) playerLinks.delete(t);
}, 3600e3).unref();

// ---------- static front-end ----------
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};
const PAGE_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

async function serveStatic(res, pathname) {
  const entry = STATIC[pathname];
  if (!entry) throw new HttpError(404, 'Introuvable');
  const body = await fsp.readFile(path.join(HERE, 'public', entry[0]));
  res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache', ...PAGE_HEADERS });
  res.end(body);
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://portal');
  let session = null;
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    session = getSession(req);
    if (url.pathname.startsWith('/api/')) {
      // CSRF: on top of SameSite=Strict, every write must come from our own fetch() calls
      if (req.method !== 'GET' && req.headers['x-portal'] !== '1') throw new HttpError(403, 'Requête refusée');
      return await api(req, res, url, session);
    }
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    if (isRead && /^\/(files|shared|v)\//.test(url.pathname)) return await serveFile(req, res, url, session);
    if (req.method === 'GET' && url.pathname === '/stream') return await serveStream(req, res, url, session);
    if (req.method === 'GET') return await serveStatic(res, url.pathname);
    throw new HttpError(405, 'Méthode non autorisée');
  } catch (err) {
    const known = err instanceof HttpError || err instanceof RpcError || err instanceof FileError;
    const status = known ? err.status : 500;
    if (!known) console.error(err);
    if (res.headersSent) return res.destroy();
    // Transmission refuses the stored password (changed since sign-in): back to "link your Transmission"
    if (err instanceof RpcError && status === 401 && session) {
      if (session.linkKey) {
        Object.assign(session, { tUser: null, client: null });
        return send(res, 409, { error: 'Ton mot de passe Transmission a changé : relie à nouveau ton Transmission', needsLink: true });
      }
      sessions.delete(session.token);
      return send(res, 401, { error: err.message }, { 'Set-Cookie': cookie('', 0) });
    }
    send(res, status, { error: known ? err.message : 'Erreur interne', ...(err.needsLink ? { needsLink: true } : {}) });
  }
});

server.listen(config.port, () => {
  const auth = verifyAccount ? `clear-soken accounts with role "${config.role}" (${config.clearSokenUrl})` : 'Transmission accounts (no COMPTES_JETON)';
  console.log(`portal listening on :${config.port}; sign-in: ${auth}; users: ${config.usersDir}; sources: ${providers.map((p) => p.id).join(', ') || 'none'}`);
});
