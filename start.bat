@echo off
set HOST=127.0.0.1
set PORT=4173
set URL=http://%HOST%:%PORT%

echo [INFO] 啟動網站中...

where py >nul 2>nul
if %errorlevel%==0 (
  set PY=py -3
  goto run
)

where python >nul 2>nul
if %errorlevel%==0 (
  set PY=python
  goto run
)

echo [ERROR] 找不到 Python。
echo [ERROR] 請先安裝 Python 3：https://www.python.org/downloads/
pause
exit /b 1

:run
echo [INFO] 已使用 %PY%
echo [INFO] 網址：%URL%
echo [INFO] 關閉伺服器請按 Ctrl + C
start "" %URL%
%PY% -m http.server %PORT% --bind %HOST%
if %errorlevel% neq 0 (
  echo [ERROR] 伺服器啟動失敗，請確認 4173 埠是否被占用。
  pause
)
