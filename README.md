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
