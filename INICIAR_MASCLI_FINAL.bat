@echo off
title MASCLI - Proyecto Sechura
cd /d "%~dp0"
echo ==============================================
echo   MASCLI - PAGINA WEB FINAL DE TESIS
echo   Proyecto Sechura
 echo ==============================================
python -m uvicorn app:app --host 127.0.0.1 --port 8000
pause
