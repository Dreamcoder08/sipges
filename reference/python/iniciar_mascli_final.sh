#!/usr/bin/env bash
cd "$(dirname "$0")"
echo "MASCLI - Pagina Web Final de Tesis | Proyecto Sechura"
# Intentional loopback HTTP override; preserve even an explicitly empty value.
if [ "${MASCLI_COOKIE_SECURE+x}" != x ]; then
    export MASCLI_COOKIE_SECURE=0
fi
python3 -m uvicorn app:app --host 127.0.0.1 --port 8000
