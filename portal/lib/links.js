// Link between a pote and their Transmission, when the two passwords differ.
// The Transmission password is encrypted (AES-256-GCM) with a key derived from the pote's own password
// (scrypt): the file alone is useless, and the portal can only read it while that pote is signing in.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const scrypt = (password, salt) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key))),
  );

export class LinkStore {
  constructor(file) {
    this.file = file;
  }

  async #read() {
    try {
      return JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return {};
      throw err;
    }
  }

  async #write(all) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  // Key for this sign-in: the stored salt when a link exists, a fresh one otherwise (used if a link is created)
  async keyFor(user, password) {
    const link = (await this.#read())[user];
    const salt = link ? Buffer.from(link.salt, 'base64') : crypto.randomBytes(16);
    return { link: link || null, salt, key: await scrypt(password, salt) };
  }

  // { transmission, password } or null (no link, or encrypted with a password the pote no longer has)
  static open(link, key) {
    if (!link) return null;
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(link.iv, 'base64'));
      d.setAuthTag(Buffer.from(link.tag, 'base64'));
      const password = Buffer.concat([d.update(Buffer.from(link.data, 'base64')), d.final()]).toString('utf8');
      return { transmission: link.transmission, password };
    } catch {
      return null;
    }
  }

  async save(user, { transmission, password }, { key, salt }) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([c.update(password, 'utf8'), c.final()]);
    const all = await this.#read();
    all[user] = {
      transmission,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: c.getAuthTag().toString('base64'),
      data: data.toString('base64'),
      updated: new Date().toISOString(),
    };
    await this.#write(all);
  }

  async remove(user) {
    const all = await this.#read();
    if (!(user in all)) return;
    delete all[user];
    await this.#write(all);
  }
}
