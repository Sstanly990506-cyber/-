@echo off
set PORT=4173
set URL=http://127.0.0.1:%PORT%

echo [INFO] 不需要 Python，改用 PowerShell 啟動...
start "" %URL%
powershell -ExecutionPolicy Bypass -File "%~dp0server.ps1" -Port %PORT% -Root "%~dp0"
if %errorlevel% neq 0 (
  echo [ERROR] 啟動失敗。請確認 Windows PowerShell 可用。
  pause
)
