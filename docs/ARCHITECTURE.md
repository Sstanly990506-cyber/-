# 系統架構

## 後端

- `api/service.py`：共用 API 服務層，集中登入、權限、資料 API 與車趟最佳化驗證。
- `api/records.py`：單筆紀錄儲存、分頁搜尋、刪除標記、增量同步與後端報表。
- `api_server.py`：Flask 傳輸層；未安裝 Flask 時負責啟動內建伺服器。
- `api/http_server.py`：Python 內建 HTTP 傳輸層。
- `api/storage.py`：帳號、Session、舊版狀態與 PostgreSQL 基礎儲存。

傳輸層只負責讀取請求與輸出回應，登入、權限與業務驗證集中在 `api/service.py`，避免兩種伺服器行為不同。

正式環境的營運資料使用 PostgreSQL `app_records`，每筆資料以 `(entity, record_id)` 為主鍵獨立更新，並以 `updated_at` 索引支援增量同步。第一次啟動會自動將舊版整包狀態遷移為單筆紀錄。

## 資料 API

- `GET /api/bootstrap`：只載入輕量設定。
- `GET /api/data/<entity>`：分頁與搜尋，預設 100 筆、上限 500 筆。
- `PUT/DELETE /api/data/<entity>/<id>`：單筆新增、更新與刪除。
- `GET /api/changes`：只取得指定時間後的變更。
- `GET /api/reports/summary`：由後端計算摘要報表。

## 前端

- `js/main.js`：應用程式啟動、頁面導航與角色顯示。
- `js/store.js`：前端分頁狀態、單筆儲存與增量同步；`localStorage` 只保存介面設定。
- `js/shared.js`：共用格式化、設定合併與純文字清理。
- 其他 `js/*.js`：各功能模組。

所有可設定文字進入動態畫面前，必須經過 `sanitizePlainText()` 或使用 `textContent` 寫入。新增功能畫面應放在對應模組，避免繼續擴大 `index.html`。

## 測試

`tests/` 使用 Python 標準函式庫 `unittest`。CI 會執行 Python 編譯、共用服務測試、分頁紀錄測試與靜態架構檢查。容量說明請見 [CAPACITY.md](CAPACITY.md)。
