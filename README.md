# Factory Operations System

三青上光內部營運系統，用來管理工單、客戶、車趟、庫存、財務、稽核、通知與 LINE 查詢。

## 正式網站內使用本機 AI

在你的 Windows 電腦啟動 **`start-companion.cmd`**，到正式網站登入管理員帳號，按右下角「三青 AI 助理」→「連接這台電腦」，再到本機配對頁核對並同意。
這個流程不使用示範帳號，也不需要提供密碼給 AI。AI 運算在本機；網站資料沿用原本的登入權限。

[完整啟動、配對、停止、安全界線與記憶體說明](docs/PRODUCTION_AI.md)

## 新增：本機 AI 假資料整合版

這是獨立開發副本，尚未部署到正式網站。請使用 **`start-ai.cmd`** 啟動，開啟 `http://127.0.0.1:4173`，按「進入假資料示範」，再按右下角「三青 AI 助理」。

支援聊天、文件來源查詢、工單／客戶／庫存查詢，以及需預覽確認的庫存備註修改。
沒有連正式資料庫，不需要輸入真實帳密，不需安裝其他服務。模型需要至少 1.5 GiB 可用記憶體。

- 安全啟動：`./start-ai.cmd`
- 測試：`./start-ai.cmd --test`
- 停止：啟動視窗按 `Ctrl+C`，或助理內的「停止本機示範」
- [完整使用、安全界線與正式網站接入限制](docs/LOCAL_AI.md)

下方是原網站的使用方式；本次示範請使用上面的 `start-ai.cmd`，不要改用原來的啟動腳本。

## 快速啟動

Windows:

```bat
start.bat
```

Mac / Linux:

```bash
./start.sh
```

手動啟動:

```bash
python api_server.py --host 127.0.0.1 --port 4173
```

開啟 <http://127.0.0.1:4173>。

## 測試

```bash
python -m unittest discover -s tests -v
```

GitHub Actions 會在推送與 Pull Request 時執行同一組測試。

## 重要環境變數

- `DATABASE_URL`: 正式環境請使用 PostgreSQL，避免資料只存在暫存檔。
- `APP_SESSION_SECRET`: 登入 session 加密用，正式環境必填。
- `OPENAI_API_KEY`: 啟用 AI 工單辨識時使用。
- `LINE_CHANNEL_SECRET`: LINE Messaging API 簽章驗證。
- `LINE_CHANNEL_ACCESS_TOKEN`: LINE 主動推播與回覆。
- `LINE_ALLOWED_USER_IDS`: 選填。設定後，群組裡只有列入的 LINE userId 可以觸發查詢。

## 文件

- [部署說明](docs/DEPLOYMENT.md)
- [環境變數](docs/ENVIRONMENT.md)
- [容量與效能](docs/CAPACITY.md)
- [安全設定](docs/SECURITY.md)
- [故障排除](docs/TROUBLESHOOTING.md)
- [系統架構](docs/ARCHITECTURE.md)
