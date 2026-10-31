// Read-only access to a user's Downloads folder, without ever leaving it (.., symlinks)
import fs from 'node:fs/promises';
import path from 'node:path';

export class FileError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Resolves `rel` (e.g. "Films/a.mkv") inside `base`; symlinks pointing outside are refused
export async function resolveInside(base, rel = '') {
  if (rel.includes('\0')) throw new FileError('Chemin invalide', 400);
  const realBase = await fs.realpath(base).catch(() => {
    throw new FileError('Dossier de téléchargements introuvable', 404);
  });
  const target = path.resolve(realBase, '.' + path.sep + rel);
  const real = await fs.realpath(target).catch(() => {
    throw new FileError('Fichier introuvable', 404);
  });
  if (real !== realBase && !real.startsWith(realBase + path.sep)) throw new FileError('Accès refusé', 403);
  return real;
}

export async function listDir(base, rel) {
  const dir = await resolveInside(base, rel);
  const stat = await fs.stat(dir);
  if (!stat.isDirectory()) throw new FileError("Ce n'est pas un dossier", 400);
  const names = await fs.readdir(dir);
  const entries = await Promise.all(
    names.map(async (name) => {
      try {
        const full = path.join(dir, name);
        // Symlinks are only listed when they stay inside Downloads
        if ((await fs.lstat(full)).isSymbolicLink()) await resolveInside(base, path.relative(await fs.realpath(base), full));
        const s = await fs.stat(full);
        return { name, type: s.isDirectory() ? 'dir' : 'file', size: s.isDirectory() ? null : s.size, mtime: s.mtime.toISOString() };
      } catch {
        return null; // broken symlink or unreadable entry
      }
    }),
  );
  return entries
    .filter(Boolean)
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'fr', { numeric: true }) : a.type === 'dir' ? -1 : 1));
}

// Types the browser may display/play directly. Anything else (html, svg...) is always downloaded.
const INLINE_TYPES = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.srt': 'text/plain; charset=utf-8',
  '.nfo': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
};

export function contentType(file) {
  return INLINE_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

// Single "bytes=a-b" range (what video players send); returns null when absent or unusable
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return { invalid: true };
  return { start, end };
}
