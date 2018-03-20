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


USER_MISSING=$(id -u "$USERNAME" > /dev/null 2>&1; echo $?)
if [ $USER_MISSING -eq 1 ]; then
    LAST_UID=$(cat /etc/passwd |grep -v nologin|cut -d ":" -f 3 |sort -n | tail -1)
    NEXT_UID=`expr $LAST_UID + 1`
    echo "user $USERNAME is missing on your system, creating it..."
    if [[ $(whoami) != "root" ]]; then
        echo && echo -e "\e[31mthe user creation needs root privileges, please use sudo\e[0m" && echo
        exit 4
    fi
    useradd -p $PASSWORD -u $NEXT_UID -d $USERS_DIR/$USERNAME -m $USERNAME
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
echo $PORT
docker build -f Dockerfile.transmission -t transmission_$USERNAME \
        --build-arg username=$USERNAME \
        --build-arg password=$PASSWORD \
        --build-arg uid=$USER_UID \
        .
exit 0