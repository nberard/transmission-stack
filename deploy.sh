#!/usr/bin/env bash
while getopts ':d:u:p:h' flag; do
  case "${flag}" in
    h)
        echo "Deploy a new transmission stack for a user"
        echo " "
        echo "options:"
        echo "-h, --help                show brief help"
        echo "-d USERSDIR               the directory where to store users"
        echo "-u USERNAME               the username to use"
        echo "-p PASSWORD               the password to use"
        exit 0
        ;;
    d) USERS_DIR="${OPTARG}" ;;
    u) USERNAME="${OPTARG}" ;;
    p) PASSWORD="${OPTARG}" ;;
    *) echo "Unexpected option ${flag}" ;;
  esac
done

if [ -z ${USERS_DIR+x} ]; then
    echo "missing users dir, see usage with -h"
    exit 1
fi

if [ -z ${USERNAME+x} ]; then
    echo "missing username, see usage with -h"
    exit 2
fi

if [ -z ${PASSWORD+x} ]; then
    echo "missing password, see usage with -h"
    exit 3
fi

if [ ! -x jq ]; then
    echo "missing jq extension, please install it first"
    exit 4
fi

USER_LOCAL_DIR=$USERS_DIR/$USERNAME

USER_MISSING=$(id -u "$USERNAME" > /dev/null 2>&1; echo $?)
if [ $USER_MISSING -eq 1 ]; then
    LAST_UID=$(cat /etc/passwd |grep -v nologin|cut -d ":" -f 3 |sort -n | tail -1)
    NEXT_UID=`expr $LAST_UID + 1`
    echo "user $USERNAME is missing on your system, creating it..."
    if [[ $(whoami) != "root" ]]; then
        echo && echo -e "\e[31mthe user creation needs root privileges, please use sudo\e[0m" && echo
        exit 5
    fi
    useradd -p $PASSWORD -u $NEXT_UID -d $USER_LOCAL_DIR -m $USERNAME
fi
USER_UID=$(grep "$USERNAME" /etc/passwd | cut -d : -f 3)
PORT=9091
while true; do
    netstat -tanp | grep transmission | grep $PORT > /dev/null
    if [ $? -eq 1 ]; then
        break
    else
        PORT=`expr $PORT + 1`
    fi
done

IMAGE_NAME="transmission:$USERNAME"
SETTINGS_PATH="$USER_LOCAL_DIR/settings.json"
cp transmission-settings.template.json $SETTINGS_PATH
export DOWNLOAD_DIR="/home/$USERNAME/Downloads"
TEMP_FILE=settings.temp.json

jq --arg DOWNLOAD_DIR "$DOWNLOAD_DIR" '."download-dir" = $DOWNLOAD_DIR' transmission-settings.template.json | \
    jq --arg USERNAME "$USERNAME" '."rpc-username" = $USERNAME' | \
    jq --arg PASSWORD "$PASSWORD" '."rpc-password" = $PASSWORD' | \
    jq --arg DOWNLOAD_DIR "$DOWNLOAD_DIR" '."incomplete-dir" = $DOWNLOAD_DIR' > "$TEMP_FILE" && \
    mv "$TEMP_FILE" "$SETTINGS_PATH"

echo "building new docker image for user $USERNAME..."
docker build -f Dockerfile.transmission -t $IMAGE_NAME \
        --build-arg username=$USERNAME \
        --build-arg password=$PASSWORD \
        --build-arg uid=$USER_UID \
        .
CONTAINER_NAME=$IMAGE_NAME

docker run -d --name transmission_$USERNAME -p $PORT:9091 -v $USER_LOCAL_DIR:/home/$USERNAME  $IMAGE_NAME