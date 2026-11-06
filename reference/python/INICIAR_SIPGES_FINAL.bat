@echo off
title SIPGES - Proyecto Sechura
cd /d "%~dp0"
echo ==============================================
echo   SIPGES - PAGINA WEB FINAL DE TESIS
echo   Proyecto Sechura
 echo ==============================================
rem Python distinguishes missing from inherited empty values; cmd IF DEFINED does not.
rem Intentional loopback HTTP override, only when absent in the child environment.
python -c "import os,runpy,sys; os.environ.setdefault('SIPGES_COOKIE_SECURE','0'); sys.argv=['uvicorn','app:app','--host','127.0.0.1','--port','8000']; runpy.run_module('uvicorn',run_name='__main__')"
pause
