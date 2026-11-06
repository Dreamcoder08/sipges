#!/usr/bin/env bash
cd "$(dirname "$0")"
echo "SIPGES - Pagina Web Final de Tesis | Proyecto Sechura"
# Intentional loopback HTTP override; preserve even an explicitly empty value.
if [ "${SIPGES_COOKIE_SECURE+x}" != x ]; then
    export SIPGES_COOKIE_SECURE=0
fi
python3 -m uvicorn app:app --host 127.0.0.1 --port 8000
