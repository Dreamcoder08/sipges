#!/usr/bin/env bash
cd "$(dirname "$0")"
echo "MASCLI - Pagina Web Final de Tesis | Proyecto Sechura"
python3 -m uvicorn app:app --host 127.0.0.1 --port 8000
