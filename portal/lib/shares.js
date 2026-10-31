// "Partagé": files or folders a pote makes visible to every pote.
// Nothing is copied: a share points to the file in its owner's Downloads (no extra disk space, and the
// portal keeps the downloads read-only). If the owner deletes the file, the share disappears with it.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export class ShareStore {
  constructor(file) {
    this.file = file;
    this.items = null;
  }

  async all() {
    if (!this.items) {
      try {
        this.items = JSON.parse(await fs.readFile(this.file, 'utf8'));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        this.items = [];
      }
    }
    return this.items;
  }

  async get(id) {
    return (await this.all()).find((s) => s.id === id) || null;
  }

  async #save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(this.items, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  // owner: Transmission account whose Downloads holds the file; by: pote who shared it
  async add({ owner, by, path: rel }) {
    const items = await this.all();
    const existing = items.find((s) => s.owner === owner && s.path === rel);
    if (existing) return existing;
    const share = { id: crypto.randomBytes(6).toString('hex'), owner, by, path: rel, sharedAt: new Date().toISOString() };
    items.push(share);
    await this.#save();
    return share;
  }

  async remove(id) {
    const items = await this.all();
    const i = items.findIndex((s) => s.id === id);
    if (i < 0) return false;
    items.splice(i, 1);
    await this.#save();
    return true;
  }
}
