#!/usr/bin/env bash
while getopts ':u:p:h:i' flag; do
  case "${flag}" in
    h)
        echo "Add a new user to samba"
        echo " "
        echo "options:"
        echo "-h,                       show brief help"
        echo "-u USERNAME               the username to use"
        echo "-p PASSWORD               the password to use"
        exit 0
        ;;
    u) USERNAME="${OPTARG}" ;;
    p) PASSWORD="${OPTARG}" ;;
    *) echo "Unexpected option ${flag}" ;;
  esac
done
(echo "$PASSWORD"; sleep 1; echo "$PASSWORD" ) | \
    pure-pw useradd $USERNAME -m -u ftpuser -d /home/ftpusers/$USERNAME
exit 0
