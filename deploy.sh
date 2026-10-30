#!/usr/bin/env bash

NEED_SHARE=false
NEED_SUBTITLES=false
while getopts ':d:u:p:hst:H:C:' flag; do
  case "${flag}" in
    h)
        echo "Deploy a new transmission stack for a user"
        echo " "
        echo "options:"
        echo "-h,                       show brief help"
        echo "-d USERSDIR               the directory where to store users"
        echo "-u USERNAME               the username to use"
        echo "-p PASSWORD               the password to use"
        echo "-s                        share downloads via ftp"
        echo "-t LANGUAGE               add subtitles finder for language"
        echo "-H DOMAIN                 HTTPS through Caddy on https://USERNAME.DOMAIN (no public port)"
        echo "-C CADDY_SITES_DIR        Caddy sites folder (default: ~/docker/clear-soken/proxy/sites of the sudo user)"
        echo " "
        echo "Running it again for an existing user recreates his container (downloads and settings are kept);"
        echo "the password is then only needed with -s. Example, to move a user to HTTPS:"
        echo "  sudo ./deploy.sh -u psycho -H touplitoui.me"
        exit 0
        ;;
    d) USERS_DIR="${OPTARG}" ;;
    u) USERNAME="${OPTARG}" ;;
    p) PASSWORD="${OPTARG}" ;;
    s) NEED_SHARE=true ;;
    t) NEED_SUBTITLES=true; SUBTITLES_LANGUAGE="${OPTARG}" ;;
    H) DOMAIN="${OPTARG}" ;;
    C) CADDY_SITES_DIR="${OPTARG}" ;;
    *) echo "Unexpected option ${flag}" ;;
  esac
done

if [ -z ${USERS_DIR+x} ]; then
    USERS_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )/users"
fi

if [ -z ${USERNAME+x} ]; then
    echo "missing username, see usage with -h"
    exit 2
fi


if [[ $(whoami) != "root" ]]; then
    echo "the user creation needs root privileges, please use sudo (with -E to preserve env variables)"
    exit 4
fi

USER_LOCAL_DIR=$USERS_DIR/$USERNAME
if [ -d $USER_LOCAL_DIR ]; then
    echo "user $USERNAME already exists in $USERS_DIR folder, we will keep his downloads"
fi

# The password is only needed to create the account, the Transmission settings or the FTP user
if [ -z "$PASSWORD" ] && { ! id -u "$USERNAME" >/dev/null 2>&1 || [ ! -f "$USER_LOCAL_DIR/settings.json" ] || $NEED_SHARE; }; then
    echo "missing password, see usage with -h"
    exit 3
fi

if [ -n "$DOMAIN" ]; then
    SUDO_HOME=$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)
    CADDY_SITES_DIR=${CADDY_SITES_DIR:-$SUDO_HOME/docker/clear-soken/proxy/sites}
    if [ ! -d "$CADDY_SITES_DIR" ]; then
        echo "Caddy sites folder not found: $CADDY_SITES_DIR (use -C)"
        exit 9
    fi
    if ! docker network inspect proxy >/dev/null 2>&1; then
        echo "Docker network 'proxy' not found (it is created by make proxy in clear-soken)"
        exit 9
    fi
fi

jq '.' transmission-settings.template.json >/dev/null 2>&1
if [ ! $? -eq 0 ]; then
    echo "missing jq extension, please install it first"
    exit 6
fi

openssl version >/dev/null 2>&1   # (openssl passwd sans mot de passe attendrait une saisie au clavier)
if [ ! $? -eq 0 ]; then
    echo "missing openssl extension, please install it first"
    exit 7
fi

if $NEED_SUBTITLES; then
    if [[ -z ${subfinder_login+x} ]] || [[ -z ${subfinder_password+x} ]] || [[ -z ${subfinder_user_agent+x} ]] ; then
        echo "missing environment variable subfinder_login or subfinder_password or subfinder_user_agent"
        exit 8
    fi
fi

GID=$(grep "transmission-users" /etc/group | cut -d':' -f3)
if [ -z ${GID} ]; then
    echo " -> creating group transmission-users"
    addgroup --system --gid 666 transmission-users
    GID=666
fi


USER_MISSING=$(id -u "$USERNAME" > /dev/null 2>&1; echo $?)
if [ $USER_MISSING -eq 1 ]; then
    # Plus grand UID utilisateur (comptes nologin compris, sinon deux comptes auraient le même UID)
    LAST_UID=$(awk -F: '$3 >= 1000 && $3 < 60000 {print $3}' /etc/passwd | sort -n | tail -1)
    LAST_UID=${LAST_UID:-999}
    NEXT_UID=`expr $LAST_UID + 1`
    echo " -> user $USERNAME is missing on your system, creating it"
    useradd -p $(openssl passwd -1 $PASSWORD) -u $NEXT_UID -d $USER_LOCAL_DIR -m -g $GID $USERNAME
    mkdir $USER_LOCAL_DIR/Downloads && chown $USERNAME:$GID $USER_LOCAL_DIR/Downloads
else
    NEXT_UID=$(id -u "$USERNAME")
fi
USER_UID=$(grep "$USERNAME" /etc/passwd | cut -d : -f 3)
PORT=9091
while [ -z "$DOMAIN" ]; do
    netstat -tanpl | grep ":$PORT" > /dev/null
    if [ $? -eq 1 ]; then
        break
    else
        PORT=`expr $PORT + 1`
    fi
done
[ -z "$DOMAIN" ] && echo " -> using port number $PORT for new stack"

IMAGE_NAME="transmission_stack_transmission:$USERNAME"
SETTINGS_PATH="$USER_LOCAL_DIR/settings.json"
if [ ! -f $SETTINGS_PATH ]; then
    cp transmission-settings.template.json $SETTINGS_PATH
    export DOWNLOAD_DIR="/home/$USERNAME/Downloads"
    TEMP_FILE=settings.temp.json

    jq --arg DOWNLOAD_DIR "$DOWNLOAD_DIR" '."download-dir" = $DOWNLOAD_DIR' transmission-settings.template.json | \
        jq --arg USERNAME "$USERNAME" '."rpc-username" = $USERNAME' | \
        jq --arg PASSWORD "$PASSWORD" '."rpc-password" = $PASSWORD' | \
        jq --arg DOWNLOAD_DIR "$DOWNLOAD_DIR" '."incomplete-dir" = $DOWNLOAD_DIR' > "$TEMP_FILE" && \
        mv "$TEMP_FILE" "$SETTINGS_PATH"
fi

if $NEED_SHARE; then
    FTP_IMAGE_NAME="transmission_stack_ftpd_server"
    FTP_CONTAINER_NAME=$FTP_IMAGE_NAME
    FTP_ID=$(docker ps -f name=^/$FTP_CONTAINER_NAME$ -q)
    if [ -z ${FTP_ID} ]; then
        echo " -> creating new global ftp server..."
        docker build -f Dockerfile.ftp -t $FTP_IMAGE_NAME .
        docker run -d --name $FTP_CONTAINER_NAME \
            -p 21:21 \
            -p 30000-30009:30000-30009 \
            -e PUBLICHOST=localhost \
            -v $USERS_DIR:/home/ftpusers \
            -v $PWD/ftp/pure-ftpd:/etc/pure-ftpd \
            $FTP_IMAGE_NAME
    fi
    echo " --> adding new user $USERNAME to global ftp server"
    docker exec -it $FTP_CONTAINER_NAME /usr/local/bin/add_user.sh -u $USERNAME -p $PASSWORD

fi

if $NEED_SUBTITLES; then
    echo " -> building subfinder docker image for user $USERNAME"
    if [ -d subfinder ]; then
        echo " --> updating subfinder project"
        pushd subfinder > /dev/null
        git pull
    else
        echo " --> cloning subfinder project"
        git clone git@github.com:nberard/subfinder.git
        pushd subfinder > /dev/null
    fi
    docker build -t transmission_stack_subfinder:$USERNAME --build-arg uid=$NEXT_UID . > /dev/null
    tee -a .env << EOF
subfinder_login=${subfinder_login}
subfinder_password=${subfinder_password}
subfinder_user_agent=${subfinder_user_agent}
subfinder_language=$SUBTITLES_LANGUAGE
EOF
    echo " --> adding subtitles finder plugin"
    docker run --name transmission_stack_subfinder_$USERNAME -d \
        --env-file=.env \
        -v $USER_LOCAL_DIR:/data \
        transmission_stack_subfinder:$USERNAME
    popd > /dev/null
fi

echo " -> building new transmission docker image for user $USERNAME"
docker build -f Dockerfile.transmission -t $IMAGE_NAME \
        --build-arg username=$USERNAME \
        --build-arg password=$PASSWORD \
        --build-arg gid=$GID \
        --build-arg uid=$USER_UID \
        . > /dev/null

CONTAINER_NAME=transmission_stack_transmission_$USERNAME
if docker ps -a -q -f name="^/$CONTAINER_NAME$" | grep -q .; then
    # Stopped first: Transmission rewrites settings.json when it exits
    echo " --> replacing existing transmission container (downloads and settings are kept)"
    docker rm -f "$CONTAINER_NAME" > /dev/null
fi

echo " --> deploying new transmission daemon"
if [ -n "$DOMAIN" ]; then
    HOST="$USERNAME.$DOMAIN"
    # Transmission refuses requests whose Host header it does not know (DNS rebinding protection)
    jq --arg HOST "$HOST" '."rpc-host-whitelist" = $HOST | ."rpc-host-whitelist-enabled" = true' \
        "$SETTINGS_PATH" > settings.temp.json && mv settings.temp.json "$SETTINGS_PATH"
    chown "$USERNAME:$GID" "$SETTINGS_PATH"
    docker run -d --name "$CONTAINER_NAME" --restart unless-stopped \
            --network proxy \
            -v $USER_LOCAL_DIR:/home/$USERNAME \
            $IMAGE_NAME > /dev/null

    SITE_FILE="$CADDY_SITES_DIR/transmission-$USERNAME.caddy"
    cat > "$SITE_FILE" << CADDY
# Transmission de $USERNAME (créé par transmission-stack/deploy.sh -H)
$HOST {
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
		X-Robots-Tag "noindex, nofollow"
		-Server
	}
	redir / /transmission/web/
	reverse_proxy $CONTAINER_NAME:9091
}
CADDY
    if docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile > /dev/null 2>&1; then
        echo " --> https://$HOST published through Caddy"
    else
        rm -f "$SITE_FILE"
        docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile > /dev/null 2>&1
        echo " !! Caddy refused the new site, removed $SITE_FILE (check: docker logs caddy)"
    fi
    TRANSMISSION_URL="https://$HOST/"
else
    docker run -d --name "$CONTAINER_NAME" --restart unless-stopped \
            -p $PORT:9091 \
            -v $USER_LOCAL_DIR:/home/$USERNAME \
            $IMAGE_NAME > /dev/null
    TRANSMISSION_URL="http://${TRANSMISSION_STACK_HOSTNAME:-$(hostname)}:$PORT (unencrypted: prefer -H DOMAIN)"
fi

HOSTNAME=${TRANSMISSION_STACK_HOSTNAME:-$(hostname)}

echo
echo "==========================================="
echo "summary for creation of user $USERNAME"
echo "==========================================="
echo "username: $USERNAME"
[ -n "$PASSWORD" ] && echo "password: $PASSWORD"
echo "access to transmission: $TRANSMISSION_URL"
$NEED_SUBTITLES && echo "subtitles downloaded every minute for language $SUBTITLES_LANGUAGE"
echo "access to your downloads:"
$NEED_SHARE && echo "- FTP (unencrypted) with : ftp://$USERNAME:$PASSWORD@$HOSTNAME"
echo "- SFTP (FileZilla, WinSCP) : sftp://$USERNAME@$HOSTNAME"
echo "- SSHFS"
echo "--> on windows (with https://github.com/billziss-gh/sshfs-win): net use z: \\\\sshfs\\$USERNAME@$HOSTNAME\Downloads $PASSWORD"
echo "--> on linux: echo $PASSWORD | sshfs -o allow_other $USERNAME@$HOSTNAME:Downloads /target/downloads"
echo "==========================================="

exit 0
