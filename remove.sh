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
    echo && echo -e "\e[31mthe user removal needs root privileges, please use sudo\e[0m" && echo
    exit 3
fi
userdel $USERNAME
rm -rf $USER_LOCAL_DIR
docker rm -f transmission_$USERNAME > /dev/null
echo user $USERNAME successfully removed
exit 0