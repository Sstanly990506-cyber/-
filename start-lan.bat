@echo off
set PORT=4173
set HOST=0.0.0.0

echo [INFO] LAN 模式啟動中（可給同網路其他裝置連線）...

echo [INFO] 本機測試：http://127.0.0.1:%PORT%
echo [INFO] 手機/平板請改用你電腦的區網 IP（啟動後會列出可用網址）

echo [INFO] 關閉伺服器請按 Ctrl + C

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 api_server.py --port %PORT% --host %HOST%
  goto end
)

where python >nul 2>nul
if %errorlevel%==0 (
  python api_server.py --port %PORT% --host %HOST%
  goto end
)

echo [ERROR] 找不到 Python，請先安裝 Python 3：https://www.python.org/downloads/
pause
exit /b 1

:end
