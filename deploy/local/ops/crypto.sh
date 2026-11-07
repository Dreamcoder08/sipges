# shellcheck shell=bash
# Sourced by backup.sh and restore.sh. OpenPGP symmetric encryption with an integrity check: a
# wrong passphrase or a changed byte makes `open` fail, and nothing downstream is trusted.
GNUPGHOME=$(mktemp -d)
export GNUPGHOME

gpg_base() {
  gpg --batch --yes --no-tty --quiet --pinentry-mode loopback --passphrase-fd 3 "$@" \
    3< <(printf '%s' "$SIPGES_BACKUP_PASSPHRASE")
}

seal() {
  gpg_base --symmetric --cipher-algo AES256 --compress-algo none \
    --s2k-mode 3 --s2k-digest-algo SHA512 --s2k-count 65011712 --force-mdc --output -
}

open_sealed() {
  gpg_base --decrypt --output - "$1"
}
