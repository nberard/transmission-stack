// Accounts live in clear-soken (role "pote"): we ask it whether a name/password is right.
// POST http://clearsoken:8080/api/comptes/verifier, Authorization: Bearer COMPTES_JETON
export class AccountError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function clearSokenAccounts({ url, token, timeoutMs = 10000 }) {
  const endpoint = url.replace(/\/+$/, '') + '/api/comptes/verifier';
  return async function verify(nom, motDePasse) {
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ nom, mot_de_passe: motDePasse }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new AccountError(`Clear Soken injoignable (${err.cause?.code || err.message})`, 502);
    }
    if (res.status === 401) throw new AccountError('Identifiant ou mot de passe incorrect', 401);
    if (res.status === 403) throw new AccountError('Jeton COMPTES_JETON refusé par Clear Soken', 502);
    if (res.status === 404) throw new AccountError('Vérification des comptes fermée dans Clear Soken (make compte-jeton)', 502);
    if (!res.ok) throw new AccountError(`Clear Soken a répondu HTTP ${res.status}`, 502);
    const body = await res.json();
    return { nom: String(body.nom), roles: Array.isArray(body.roles) ? body.roles.map(String) : [] };
  };
}
