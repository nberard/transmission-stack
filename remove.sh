#!/usr/bin/env bash
while getopts ':d:u:h' flag; do
  case "${flag}" in
    h)
        echo "Remove a new transmission stack for a user"
        echo " "
        echo "options:"
        echo "-h, --help                show brief help"
        echo "-d USERSDIR               the directory where to store users"
        echo "-u USERNAME               the username to use"
        exit 0
        ;;
    d) USERS_DIR="${OPTARG}" ;;
    u) USERNAME="${OPTARG}" ;;
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

USER_LOCAL_DIR=$USERS_DIR/$USERNAME

if [[ $(whoami) != "root" ]]; then
    echo "the user removal needs root privileges, please use sudo (with -E to preserve env variables)"
    exit 3
fi

#@TODO remove ftp

SUBFINDER_ID=$(docker ps -f name=^/transmission_stack_subfinder_$USERNAME$ -q)
if [ ! -z ${SUBFINDER_ID} ]; then
    echo "removing subfinder config for user $USERNAME"
    docker rm -f $SUBFINDER_ID
fi
echo "removing transmission config for user $USERNAME"
userdel $USERNAME
rm -rf $USER_LOCAL_DIR
docker rm -f transmission_stack_transmission_$USERNAME > /dev/null

echo "user $USERNAME successfully removed"

exit 0