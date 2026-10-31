#!/usr/bin/env bash
# Portail des téléchargements (dossier portal/) : https://downloads.<domaine>, derrière le Caddy de clear-soken.
# Connexion avec un compte clear-soken qui a le rôle « pote » (make compte NOM=… dans clear-soken).

SUBDOMAIN=downloads
REMOVE=false
while getopts ':d:H:n:K:rh' flag; do
  case "${flag}" in
    h)
        echo "Deploy the downloads portal (torrents, files, search) for every friend"
        echo " "
        echo "options:"
        echo "-h,                       show brief help"
        echo "-H DOMAIN                 publish on https://SUBDOMAIN.DOMAIN through Caddy (required)"
        echo "-n SUBDOMAIN              sub-domain (default: downloads)"
        echo "-K CLEARSOKEN_DIR         clone of clear-soken: Caddy sites and COMPTES_JETON (default: ~/docker/clear-soken of the sudo user)"
        echo "-d USERSDIR               the directory where users are stored"
        echo "-r                        remove the portal (container and Caddy site; links stay in portal-data/)"
        echo " "
        echo "Friends sign in with their clear-soken account (role pote). Their Transmission must be deployed with -H."
        echo "Example: sudo ./deploy-portal.sh -H touplitoui.me"
        exit 0
        ;;
    d) USERS_DIR="${OPTARG}" ;;
    H) DOMAIN="${OPTARG}" ;;
    n) SUBDOMAIN="${OPTARG}" ;;
    K) CLEARSOKEN_DIR="${OPTARG}" ;;
    r) REMOVE=true ;;
    *) echo "Unexpected option ${flag}" ;;
  esac
done

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
USERS_DIR=${USERS_DIR:-$SCRIPT_DIR/users}
SUDO_HOME=$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)
CLEARSOKEN_DIR=${CLEARSOKEN_DIR:-$SUDO_HOME/docker/clear-soken}
CADDY_SITES_DIR="$CLEARSOKEN_DIR/proxy/sites"
SITE_FILE="$CADDY_SITES_DIR/transmission-portal.caddy"
IMAGE_NAME=transmission_stack_portal
CONTAINER_NAME=transmission_stack_portal

if [[ $(whoami) != "root" ]]; then
    echo "the portal reads every friend's folder: please use sudo"
    exit 4
fi

reload_caddy() {
    docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile > /dev/null 2>&1
}

if $REMOVE; then
    docker rm -f "$CONTAINER_NAME" > /dev/null 2>&1 && echo " -> portal container removed"
    if [ -f "$SITE_FILE" ]; then
        rm -f "$SITE_FILE" && reload_caddy && echo " -> Caddy site removed"
    fi
    exit 0
fi

if [ -z "$DOMAIN" ]; then
    echo "missing domain, see usage with -h"
    exit 2
fi
if [ ! -d "$CADDY_SITES_DIR" ]; then
    echo "Caddy sites folder not found: $CADDY_SITES_DIR (clone of clear-soken: use -K)"
    exit 9
fi
if ! docker network inspect proxy >/dev/null 2>&1; then
    echo "Docker network 'proxy' not found (it is created by make proxy in clear-soken)"
    exit 9
fi
COMPTES_JETON=$(sed -n 's/^COMPTES_JETON=//p' "$CLEARSOKEN_DIR/.env" 2>/dev/null | tail -1)
if ! [[ "$COMPTES_JETON" =~ ^[A-Za-z0-9]{32,}$ ]]; then
    echo "no COMPTES_JETON in $CLEARSOKEN_DIR/.env: run 'make compte-jeton' in clear-soken first"
    exit 10
fi
if ! docker ps -q -f name='^/clearsoken$' | grep -q .; then
    echo "warning: the clearsoken container is not running, nobody will be able to sign in (make deploy in clear-soken)"
fi

echo " -> building portal image"
docker build -t "$IMAGE_NAME" "$SCRIPT_DIR/portal" > /dev/null || exit 11

# Links pote -> Transmission (passwords encrypted with each pote's own password)
DATA_DIR="$SCRIPT_DIR/portal-data"
mkdir -p "$DATA_DIR" && chmod 700 "$DATA_DIR"

docker rm -f "$CONTAINER_NAME" > /dev/null 2>&1
echo " -> starting portal"
# root without any capability except reading through file permissions (each friend's home is private),
# read-only filesystem, downloads mounted read-only: it can list and send files, never change them
docker run -d --name "$CONTAINER_NAME" --restart unless-stopped \
    --network proxy \
    --user 0:0 --cap-drop ALL --cap-add DAC_READ_SEARCH \
    --security-opt no-new-privileges --read-only \
    -e DOMAIN="$DOMAIN" \
    -e COMPTES_JETON="$COMPTES_JETON" \
    -e CLEARSOKEN_URL=http://clearsoken:8080 \
    -e DATA_DIR=/data \
    ${TPB_API_URL:+-e TPB_API_URL="$TPB_API_URL"} \
    -v "$USERS_DIR":/users:ro \
    -v "$DATA_DIR":/data \
    "$IMAGE_NAME" > /dev/null || exit 12

HOST="$SUBDOMAIN.$DOMAIN"
cat > "$SITE_FILE" << CADDY
# Portail des téléchargements (créé par transmission-stack/deploy-portal.sh)
$HOST {
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
		X-Robots-Tag "noindex, nofollow"
		-Server
	}
	request_body {
		max_size 1MB
	}
	reverse_proxy $CONTAINER_NAME:8080
}
CADDY
if reload_caddy; then
    echo " --> https://$HOST published through Caddy"
else
    rm -f "$SITE_FILE"
    reload_caddy
    echo " !! Caddy refused the new site, removed $SITE_FILE (check: docker logs caddy)"
    exit 13
fi

echo
echo "==========================================="
echo "downloads portal: https://$HOST"
echo "sign-in: clear-soken accounts with role pote"
echo "  (in clear-soken: make compte NOM=psycho ; make comptes)"
echo "a pote whose name and password match their Transmission is linked automatically,"
echo "the others link their Transmission once from the portal"
echo "==========================================="
exit 0
