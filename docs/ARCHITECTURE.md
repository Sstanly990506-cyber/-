# 系統架構

## 前端載入流程

- `index.html`: 只保留網站外殼與必要資源。
- `js/view-loader.js`: 載入 `views/app-shell.html`。
- `views/app-shell.html`: 放主要畫面結構。
- `js/main.js`: 啟動應用、登入、同步資料、權限與模組切換。

各功能拆在 `js/` 目錄：

- `orders.js`: 工單新增、列表、狀態與 AI 識別入口。
- `orders-export.js`: 工單列印與輸出 HTML。
- `orders-pricing.js` / `pricing.js`: 報價規則與價格計算。
- `customers.js`: 客戶與廠商資料。
- `finance.js`: 應收、應付、報表、發票與財務提醒。
- `trips.js` 與 `js/trips/`: 車趟與路線。
- `inventory.js`: 庫存。
- `audit.js`: 稽核紀錄。
- `notifications.js`: 通知與 LINE 設定狀態。
- `settings.js`: 系統設定、帳號權限與容量檢測。

## 後端流程

- `api_server.py`: 本機 Flask 入口。
- `api/index.py`: Vercel 入口，重用同一個 Flask app。
- `api/routes.py`: API 路由。
- `api/service.py`: 登入、權限、資料 API、報表與設定邏輯。
- `api/records.py`: 統一資料讀寫介面。
- `api/storage.py`: PostgreSQL 與本機 JSON 儲存實作。
- `api/line_bot.py`: LINE webhook、推播、綁定與查詢回覆。
- `api/openai_client.py`: AI 工單辨識。

所有資料讀寫應集中經過 `api/records.py` / `api/service.py`，避免前端、本機伺服器與 Vercel 各自維護一份邏輯。

## 儲存模式

正式環境建議設定 `DATABASE_URL` 使用 PostgreSQL。若沒有設定，系統會使用本機 JSON 檔，適合開發與測試，但不適合正式部署。

## 安全原則

- 使用者輸入或資料庫資料要放進 HTML 時，必須先使用 `escapeHtml()`，或改用 `textContent`。
- 不要在前端硬編敏感金鑰。
- 正式環境必須設定 `APP_SESSION_SECRET`。
- LINE 群組查詢可用 `LINE_ALLOWED_USER_IDS` 限制可查詢的人。

## 測試

主要測試位於 `tests/`，使用 Python `unittest`。執行：

```bash
python -m unittest discover -s tests -v
```
