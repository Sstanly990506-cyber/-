#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-4173}"
HOST="0.0.0.0"

if command -v python3 >/dev/null 2>&1; then
  PYTHON_CMD="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_CMD="python"
else
  echo "[ERROR] 找不到 Python（python3/python）。"
  echo "請先安裝 Python 3 後再執行此腳本。"
  exit 1
fi

echo "[INFO] LAN 模式啟動中（可給同網路其他裝置連線）..."
echo "[INFO] 本機測試： http://127.0.0.1:${PORT}"
echo "[INFO] 手機/平板：請改用電腦的區網 IP（啟動後會列出可用網址）"
echo "[INFO] 停止方式：Ctrl + C"

"${PYTHON_CMD}" api_server.py --port "${PORT}" --host "${HOST}"
