# transmission-stack

Un Transmission par ami, dans son propre conteneur, avec ses téléchargements dans `users/<nom>/`.

```bash
sudo ./deploy.sh -u psycho -p 'mot-de-passe' -H touplitoui.me   # nouvel ami, en HTTPS
sudo ./deploy.sh -u psycho -H touplitoui.me                      # ami existant : passage en HTTPS
sudo ./remove.sh -u psycho [-w]                                  # retirer (-w : efface aussi ses fichiers)
./deploy.sh -h                                                   # toutes les options
```

## Accès

| Quoi | Comment |
|---|---|
| Interface Transmission | `https://<nom>.touplitoui.me/` (option `-H`) : Caddy de clear-soken, certificat automatique, aucun port ouvert. Identifiant et mot de passe de Transmission |
| Téléchargements | SFTP / SSHFS avec le compte du serveur : FileZilla, WinSCP, `sshfs` (sshfs-win sous Windows). SSH limite ces comptes au SFTP (`Match Group transmission-users` + `ForceCommand internal-sftp`) |
| FTP (option `-s`) | En clair, déconseillé : à garder seulement pour un appareil qui ne sait faire que du FTP |

Avec `-H`, `deploy.sh` :
1. lance le conteneur sur le réseau Docker `proxy` (celui de Caddy), sans publier de port, avec `--restart unless-stopped` ;
2. règle `rpc-host-whitelist` de Transmission sur `<nom>.<domaine>` ;
3. écrit `transmission-<nom>.caddy` dans `~/docker/clear-soken/proxy/sites` (ou `-C`) et recharge Caddy.

Le sous-domaine est couvert par l'enregistrement DNS joker `*.touplitoui.me`. Relancer `deploy.sh` pour un ami
existant recrée son conteneur : téléchargements et réglages sont conservés, le mot de passe n'est demandé que
pour créer le compte, les réglages ou l'accès FTP.

## Portail des téléchargements

`https://downloads.touplitoui.me` : chaque pote voit **ses torrents** (pause, reprise, suppression, ajout par lien
magnet), **ses fichiers** (navigation dans `Downloads`, téléchargement, lecture des vidéos dans le navigateur) et
**cherche des torrents** sur The Pirate Bay pour les ajouter à son Transmission en un clic.

```bash
# dans clear-soken (une seule fois) : jeton du portail, puis un compte par pote
make compte-jeton
make compte NOM=psycho            # rôle « pote » par défaut

# ici
sudo ./deploy-portal.sh -H touplitoui.me     # (re)construit et publie le portail
sudo ./deploy-portal.sh -r                   # le retire
```

- **Connexion** : compte clear-soken avec le rôle `pote` (`make comptes` les liste). Le portail demande à clear-soken
  si le mot de passe est bon (`/api/comptes/verifier`, jeton `COMPTES_JETON`, fermé à Internet par Caddy).
- **Lien avec Transmission** : si le pote a le même nom et le même mot de passe que son Transmission, rien à faire.
  Sinon, il donne une fois son identifiant et son mot de passe Transmission dans le portail : ils sont gardés dans
  `portal-data/liens.json`, chiffrés avec son mot de passe de pote (illisibles sans lui).
- **Prérequis** : le Transmission du pote est déployé avec `-H` (conteneur sur le réseau `proxy`).
- **Sécurité** : le conteneur lit `users/` en lecture seule (droit de lecture seul, système de fichiers en lecture
  seule). Les fichiers HTML, SVG… sont toujours téléchargés, jamais affichés.
- **Recherche** : `portal/lib/providers/`. The Pirate Bay passe par `apibay.org`, l'API JSON du site ; si elle change
  d'adresse, relancer avec `TPB_API_URL=https://… sudo -E ./deploy-portal.sh -H touplitoui.me`. Pour ajouter une
  source, un module de plus dans ce dossier (voir `index.js`).
- **En local** : `cd portal && USERS_DIR=../users SECURE_COOKIE=false node server.js` (sans `COMPTES_JETON`, on se
  connecte avec l'identifiant Transmission ; `TRANSMISSION_HOST=127.0.0.1` pour un Transmission local).
