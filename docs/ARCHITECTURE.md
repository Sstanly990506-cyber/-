# 系統架構

## 後端

- `api/service.py`：共用 API 服務層，集中登入、權限、狀態同步與車趟最佳化驗證。
- `api_server.py`：Flask 傳輸層；未安裝 Flask 時負責啟動內建伺服器。
- `api/http_server.py`：Python 內建 HTTP 傳輸層。
- `api/storage.py`：帳號、Session、JSON 與 PostgreSQL 儲存。

傳輸層只負責讀取請求與輸出回應，業務驗證應放在 `api/service.py`，避免兩種伺服器行為不同。

## 前端

- `js/main.js`：應用程式啟動、頁面導覽與角色顯示。
- `js/store.js`：前端狀態與伺服器同步。
- `js/shared.js`：共用格式化、設定合併與純文字清理。
- 其他 `js/*.js`：各功能模組。

所有可設定文字在進入動態畫面前，必須經過 `sanitizePlainText()` 或使用 `textContent` 寫入。

## 頁面元件化方向

新增或修改功能時，應將每個功能的畫面與事件留在對應模組，避免繼續擴大 `index.html`。頁面載入器與功能模板應保持無內嵌腳本，所有事件由模組初始化函式註冊。

## 測試

`tests/` 使用 Python 標準函式庫 `unittest`。CI 會執行：

1. Python 編譯檢查。
2. 共用服務層單元測試。
3. 後續可加入瀏覽器端元件與同步流程測試。
