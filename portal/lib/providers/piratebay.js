// The Pirate Bay, through apibay.org: the JSON backend thepiratebay.org's own pages read from.
// Mirrors come and go: TPB_API_URL / TPB_SITE_URL point elsewhere without touching the code.
const API = (process.env.TPB_API_URL || 'https://apibay.org').replace(/\/+$/, '');
const SITE = (process.env.TPB_SITE_URL || 'https://thepiratebay.org').replace(/\/+$/, '');

// Same trackers as the ones thepiratebay.org adds to its magnets
const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.bittor.pw:1337/announce',
  'udp://public.popcorn-tracker.org:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://exodus.desync.com:6969',
  'udp://open.demonii.com:1337/announce',
];

const CATEGORIES = [
  { id: '0', label: 'Tout' },
  { id: '100', label: 'Audio' },
  { id: '101', label: 'Musique' },
  { id: '200', label: 'Vidéo' },
  { id: '201', label: 'Films' },
  { id: '207', label: 'Films HD' },
  { id: '211', label: 'Films UHD/4K' },
  { id: '205', label: 'Séries' },
  { id: '208', label: 'Séries HD' },
  { id: '300', label: 'Applications' },
  { id: '400', label: 'Jeux' },
  { id: '601', label: 'Livres' },
  { id: '600', label: 'Autre' },
];

const TOP_LEVEL = { 1: 'Audio', 2: 'Vidéo', 3: 'Applications', 4: 'Jeux', 5: 'Adulte', 6: 'Autre' };
const SUB = Object.fromEntries(CATEGORIES.filter((c) => c.id.slice(1) !== '00').map((c) => [c.id, c.label]));

function categoryLabel(code) {
  return SUB[String(code)] || TOP_LEVEL[Math.floor(Number(code) / 100)] || '';
}

function magnet(hash, name) {
  const tr = TRACKERS.map((t) => '&tr=' + encodeURIComponent(t)).join('');
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}${tr}`;
}

// apibay names carry HTML entities (&amp;, &#039;…)
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
  });
}

function normalize(t) {
  const hash = String(t?.info_hash || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hash) || /^0+$/.test(hash) || String(t.id) === '0') return null; // "No results returned"
  const added = Number(t.added);
  const name = decodeEntities(t.name);
  return {
    id: String(t.id),
    name,
    infoHash: hash,
    magnet: magnet(hash, name),
    link: `${SITE}/description.php?id=${encodeURIComponent(t.id)}`,
    size: Number(t.size) || 0,
    files: Number(t.num_files) || null,
    seeders: Number(t.seeders) || 0,
    leechers: Number(t.leechers) || 0,
    added: added ? new Date(added * 1000).toISOString() : null,
    uploader: t.username || null,
    trusted: t.status === 'vip' || t.status === 'trusted',
    category: categoryLabel(t.category),
    imdb: t.imdb || null,
  };
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'transmission-stack-portal', Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`The Pirate Bay a répondu HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export default {
  id: 'piratebay',
  name: 'The Pirate Bay',
  categories: CATEGORIES,

  async search(query, category = '0') {
    const cat = CATEGORIES.some((c) => c.id === category) ? category : '0';
    const rows = await getJson(`${API}/q.php?q=${encodeURIComponent(query)}&cat=${cat}`);
    return rows.map(normalize).filter(Boolean);
  },

  async top(category = '0') {
    const cat = CATEGORIES.some((c) => c.id === category) && category !== '0' ? category : 'all';
    const rows = await getJson(`${API}/precompiled/data_top100_${cat}.json`);
    return rows.map(normalize).filter(Boolean);
  },
};
