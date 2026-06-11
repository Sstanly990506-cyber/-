# 安全設定

## 正式環境必要設定

請設定以下環境變數，不要提交到 GitHub：

- `APP_SESSION_SECRET`：長度至少 32 bytes 的隨機值。
- `INIT_ADMIN_PASSWORD`：首次建立管理員時使用的強密碼。
- `INIT_OPS_PASSWORD`、`INIT_FINANCE_PASSWORD`、`INIT_AUDIT_PASSWORD`：各角色首次密碼。
- `FINANCE_MODULE_PASSWORD`：財務模組的額外密碼。
- `DATABASE_URL`：正式環境 PostgreSQL 連線字串。

## 網路

- 僅在可信任的內部網路使用 LAN 模式。
- 對外部署時必須使用 HTTPS。
- `/api/health` 僅公開基本狀態，不應公開資料路徑或密鑰來源。

## 帳號

- 首次啟動後立即確認內建帳號密碼。
- 不共用帳號。
- 定期檢查稽核與登入失敗紀錄。
