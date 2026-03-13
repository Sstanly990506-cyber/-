#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-4173}"
HOST="127.0.0.1"
URL="http://${HOST}:${PORT}"

if command -v python3 >/dev/null 2>&1; then
  PYTHON_CMD="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_CMD="python"
else
  echo "[ERROR] 找不到 Python（python3/python）。"
  echo "請先安裝 Python 3 後再執行此腳本。"
  exit 1
fi

echo "[INFO] 使用 ${PYTHON_CMD} 啟動網站..."
echo "[INFO] URL: ${URL}"
echo "[INFO] 停止方式：Ctrl + C"

<<<<<< codex/develop-a-web-based-internal-system-jduqzj
"${PYTHON_CMD}" api_server.py --port "${PORT}" --host "${HOST}"
=======
"${PYTHON_CMD}" -m http.server "${PORT}" --bind "${HOST}"
>>>>>> main
