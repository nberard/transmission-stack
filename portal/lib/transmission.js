// Minimal client for the Transmission RPC API (https://github.com/transmission/transmission/blob/main/docs/rpc-spec.md)
import http from 'node:http';

export class RpcError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

export class TransmissionClient {
  constructor({ host, port = 9091, hostHeader, username, password, timeoutMs = 10000 }) {
    this.host = host;
    this.port = port;
    this.hostHeader = hostHeader || `${host}:${port}`;
    this.auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    this.timeoutMs = timeoutMs;
    this.sessionId = null;
  }

  async call(method, args = {}) {
    const body = JSON.stringify({ method, arguments: args });
    // Transmission answers 409 with a fresh X-Transmission-Session-Id (CSRF protection): retry once with it
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.#post(body);
      if (res.status === 409) {
        this.sessionId = res.headers['x-transmission-session-id'] || null;
        continue;
      }
      if (res.status === 401) throw new RpcError('Identifiant ou mot de passe incorrect', 401);
      if (res.status !== 200) throw new RpcError(`Transmission a répondu HTTP ${res.status}`);
      let parsed;
      try {
        parsed = JSON.parse(res.body);
      } catch {
        throw new RpcError('Réponse illisible de Transmission');
      }
      if (parsed.result !== 'success') throw new RpcError(parsed.result || 'Erreur Transmission', 400);
      return parsed.arguments || {};
    }
    throw new RpcError('Transmission refuse la session');
  }

  #post(body) {
    return new Promise((resolve, reject) => {
      const headers = {
        Host: this.hostHeader,
        Authorization: this.auth,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      };
      if (this.sessionId) headers['X-Transmission-Session-Id'] = this.sessionId;
      const req = http.request(
        { host: this.host, port: this.port, path: '/transmission/rpc', method: 'POST', headers, timeout: this.timeoutMs },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (err) => reject(new RpcError(`Transmission injoignable (${err.code || err.message})`, 502)));
      req.end(body);
    });
  }
}

export const TORRENT_FIELDS = [
  'id', 'hashString', 'name', 'status', 'error', 'errorString', 'percentDone', 'metadataPercentComplete',
  'rateDownload', 'rateUpload', 'eta', 'totalSize', 'sizeWhenDone', 'leftUntilDone', 'uploadRatio',
  'peersConnected', 'addedDate', 'doneDate', 'downloadDir', 'isFinished',
];
