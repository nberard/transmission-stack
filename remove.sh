#!/usr/bin/env bash
WIPE_DATA=false
while getopts ':d:u:hw' flag; do
  case "${flag}" in
    h)
        echo "Remove a new transmission stack for a user"
        echo " "
        echo "options:"
        echo "-h, --help                show brief help"
        echo "-d USERSDIR               the directory where to store users"
        echo "-u USERNAME               the username to use"
        echo "-w                        wipe all downloads data"
        exit 0
        ;;
    d) USERS_DIR="${OPTARG}" ;;
    u) USERNAME="${OPTARG}" ;;
    w) WIPE_DATA=true ;;
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

if $WIPE_DATA; then
    if [[ $(whoami) != "root" ]]; then
        echo "the user removal needs root privileges, please use sudo (with -E to preserve env variables)"
        exit 3
    fi
fi

USER_LOCAL_DIR=$USERS_DIR/$USERNAME

FTP_ID=$(docker ps -f name=^/transmission_stack_ftpd_server$ -q)
if [ ! -z ${FTP_ID} ]; then
    docker exec -it transmission_stack_ftpd_server pure-pw list | grep $USERNAME && \
        echo "removing ftp config for user $USERNAME" && docker exec -it transmission_stack_ftpd_server /usr/local/bin/remove_user.sh -u $USERNAME
    FTP_USERS=$(docker exec -it transmission_stack_ftpd_server pure-pw list)
    if [ -z $FTP_USERS ]; then
        echo "removing ftp server as there are no more users"
        docker rm -f transmission_stack_ftpd_server
    fi
fi

SUBFINDER_ID=$(docker ps -f name=^/transmission_stack_subfinder_$USERNAME$ -q)
if [ ! -z ${SUBFINDER_ID} ]; then
    echo "removing subfinder config for user $USERNAME"
    docker rm -f $SUBFINDER_ID
fi

if $WIPE_DATA; then
    userdel $USERNAME
    rm -rf $USER_LOCAL_DIR
fi

echo "removing transmission config for user $USERNAME"
docker rm -f transmission_stack_transmission_$USERNAME > /dev/null

echo "user $USERNAME successfully removed"

exit 0