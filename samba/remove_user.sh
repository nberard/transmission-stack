#!/usr/bin/env bash
while getopts ':u:p:h:i' flag; do
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
    p) PASSWORD="${OPTARG}" ;;
    *) echo "Unexpected option ${flag}" ;;
  esac
done
cp /etc/samba/smb.conf /etc/samba/smb.conf.new
sed "/start_config_$USERNAME/,/end_config_$USERNAME/d" /etc/samba/smb.conf.new > /etc/samba/smb.conf
deluser $USERNAME
exit 0
