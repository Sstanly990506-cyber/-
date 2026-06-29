# Factory Operations System

三青實業內部營運系統，整合工單、客戶、車趟、庫存、通知、財務與稽核功能。

## 快速開始

### Windows

雙擊 `start.bat`，然後開啟啟動畫面顯示的網址。

### Mac / Linux

```bash
./start.sh
```

### 手動啟動

```bash
python api_server.py --host 127.0.0.1 --port 4173
```

預設網址為 <http://127.0.0.1:4173>。未設定 `DATABASE_URL` 時，系統會使用本機 JSON 儲存；設定後則使用 PostgreSQL。

## 測試

```bash
python -m unittest discover -s tests -v
```

每次推送與 Pull Request 都會由 GitHub Actions 執行編譯檢查與自動測試。

## 文件

- [部署與區域網路使用](docs/DEPLOYMENT.md)
- [正式環境變數](docs/ENVIRONMENT.md)
- [容量與效能](docs/CAPACITY.md)
- [安全設定](docs/SECURITY.md)
- [故障排除](docs/TROUBLESHOOTING.md)
- [系統架構](docs/ARCHITECTURE.md)

## 重要提醒

- 正式環境必須設定 `APP_SESSION_SECRET`、各角色初始化密碼與 PostgreSQL。
- 手機不可使用 `127.0.0.1` 連接電腦，請使用電腦的區域網路 IP。
- `start-no-python.bat` 是純前端模式，不支援伺服器同步與大量資料模式。
