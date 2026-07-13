# Factory Operations System

三青上光內部營運系統，用來管理工單、客戶、車趟、庫存、財務、稽核、通知與 LINE 查詢。

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
