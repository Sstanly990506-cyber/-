@echo off
setlocal
set "SANQING_PYTHON=%~dp0..\sanqing-local-ai\.runtime\python\python.exe"
if not exist "%SANQING_PYTHON%" (
  echo Local Python not found. Keep sanqing-local-ai beside this folder.
  exit /b 2
)
"%SANQING_PYTHON%" -B "%~dp0run_companion.py"
exit /b %errorlevel%
