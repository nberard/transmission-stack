#!/usr/bin/env bash
while getopts ':u:h:i' flag; do
  case "${flag}" in
    h)
        echo "Add a new user to samba"
        echo " "
        echo "options:"
        echo "-h,                       show brief help"
        echo "-u USERNAME               the username to use"
        exit 0
        ;;
    u) USERNAME="${OPTARG}" ;;
    *) echo "Unexpected option ${flag}" ;;
  esac
done
pure-pw userdel $USERNAME -m
exit 0
