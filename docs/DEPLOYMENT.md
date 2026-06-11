# 部署

## 本機集中式模式

```bash
python api_server.py --host 127.0.0.1 --port 4173
```

未設定 `DATABASE_URL` 時，資料會儲存在 `APP_DATA_DIR` 或預設資料目錄。

## 區域網路模式

只在可信任的內部網路中使用：

```bash
python api_server.py --host 0.0.0.0 --port 4173
```

手機與電腦必須連接同一個 Wi-Fi，並使用主機的區域網路 IP。

## Vercel / PostgreSQL

1. 建立 PostgreSQL 資料庫。
2. 設定 `DATABASE_URL` 與 `APP_SESSION_SECRET`。
3. 設定各初始化帳號密碼。
4. 部署後檢查 `/api/health`。

完整安全設定請閱讀 [SECURITY.md](SECURITY.md)。
