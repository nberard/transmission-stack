#!/usr/bin/env bash
NEED_SHARE=false
NEED_SUBTITLES=false
while getopts ':d:u:p:hst:' flag; do
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
        exit 0
        ;;
    d) USERS_DIR="${OPTARG}" ;;
    u) USERNAME="${OPTARG}" ;;
    p) PASSWORD="${OPTARG}" ;;
    s) NEED_SHARE=true ;;
    t) NEED_SUBTITLES=true; SUBTITLES_LANGUAGE="${OPTARG}" ;;
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

if [[ $(whoami) != "root" ]]; then
    echo "the user creation needs root privileges, please use sudo (with -E to preserve env variables)"
    exit 4
fi

USER_LOCAL_DIR=$USERS_DIR/$USERNAME
if [ -d $USER_LOCAL_DIR ]; then
    echo "user $USERNAME already exists in $USERS_DIR folder, we will keep his downloads"
fi

jq '.' transmission-settings.template.json >/dev/null 2>&1
if [ ! $? -eq 0 ]; then
    echo "missing jq extension, please install it first"
    exit 6
fi

openssl passwd -1 $PASSWORD >/dev/null 2>&1
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

USER_MISSING=$(id -u "$USERNAME" > /dev/null 2>&1; echo $?)
if [ $USER_MISSING -eq 1 ]; then
    LAST_UID=$(cat /etc/passwd |grep -v nologin|grep -v nobody|cut -d ":" -f 3 |sort -n | tail -1)
    NEXT_UID=`expr $LAST_UID + 1`
    echo " -> user $USERNAME is missing on your system, creating it"
    useradd -p $(openssl passwd -1 $PASSWORD) -u $NEXT_UID -d $USER_LOCAL_DIR -m $USERNAME
    mkdir $USER_LOCAL_DIR/Downloads && chown $USERNAME:$USERNAME $USER_LOCAL_DIR/Downloads
fi
USER_UID=$(grep "$USERNAME" /etc/passwd | cut -d : -f 3)
PORT=9091
while true; do
    netstat -tanpl | grep ":$PORT" > /dev/null
    if [ $? -eq 1 ]; then
        break
    else
        PORT=`expr $PORT + 1`
    fi
done
echo " -> using port number $PORT for new stack"

IMAGE_NAME="transmission_stack_transmission:$USERNAME"
SETTINGS_PATH="$USER_LOCAL_DIR/settings.json"
cp transmission-settings.template.json $SETTINGS_PATH
export DOWNLOAD_DIR="/home/$USERNAME/Downloads"
TEMP_FILE=settings.temp.json

jq --arg DOWNLOAD_DIR "$DOWNLOAD_DIR" '."download-dir" = $DOWNLOAD_DIR' transmission-settings.template.json | \
    jq --arg USERNAME "$USERNAME" '."rpc-username" = $USERNAME' | \
    jq --arg PASSWORD "$PASSWORD" '."rpc-password" = $PASSWORD' | \
    jq --arg DOWNLOAD_DIR "$DOWNLOAD_DIR" '."incomplete-dir" = $DOWNLOAD_DIR' > "$TEMP_FILE" && \
    mv "$TEMP_FILE" "$SETTINGS_PATH"

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
        --build-arg uid=$USER_UID \
        . > /dev/null

echo " --> deploying new transmission daemon"
docker run -d --name transmission_stack_transmission_$USERNAME \
        -p $PORT:9091 \
        -v $USER_LOCAL_DIR:/home/$USERNAME \
        $IMAGE_NAME

HOSTNAME=${TRANSMISSION_STACK_HOSTNAME:-$(hostname)}

echo
echo "==========================================="
echo "summary for creation of user $USERNAME"
echo "==========================================="
echo "username: $USERNAME"
echo "password: $PASSWORD"
echo "access to transmission: http://$HOSTNAME:$PORT"
echo "subtitles downloaded every minute for language $SUBTITLES_LANGUAGE"
echo "access to your downloads:"
echo "- FTP with : ftp://$USER:$PASSWORD@$HOSTNAME"
echo "- SSHFS"
echo "--> on windows (with https://github.com/billziss-gh/sshfs-win): net use z: \\sshfs\$USERNAME@$HOSTNAME\Downloads $PASSWORD"
echo "--> on linux: echo $PASSWORD | sshfs -o allow_other $USERNAME@$HOSTNAME:Downloads /target/downloads"
echo "==========================================="

exit 0

exit 0
