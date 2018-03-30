#!/usr/bin/env bash
while getopts ':u:p:h:i' flag; do
  case "${flag}" in
    h)
        echo "Deploy a new transmission stack for a user"
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
tee -a /etc/samba/smb.conf << EOF
[share_$USERNAME]
    guest ok = no
    comment = Samba share for user $USERNAME
    path = /home/users/$USERNAME/Downloads
    browsable = yes
    read only = no
    writeable = yes
    locking = no
EOF
adduser -D -H $USERNAME
(echo "$PASSWORD"; sleep 1; echo "$PASSWORD" ) | smbpasswd -s -a $USERNAME
exit 0
