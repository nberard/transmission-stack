// Torrent search sources. To add one, write a module exporting
// { id, name, categories: [{id, label}], search(query, category), top(category) }
// whose results look like piratebay.js's normalize(), then list it here.
import piratebay from './piratebay.js';

const ALL = [piratebay];

const wanted = (process.env.PROVIDERS || ALL.map((p) => p.id).join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const providers = ALL.filter((p) => wanted.includes(p.id));

export function getProvider(id) {
  return providers.find((p) => p.id === id) || providers[0];
}

// Short cache: a search is often replayed (back button, other friend)
const cache = new Map();
const TTL_MS = 5 * 60 * 1000;

export async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return value;
}
