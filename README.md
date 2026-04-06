# 上光廠內部系統（前端原型）

你遇到的 `ERR_CONNECTION_REFUSED` 代表：
**瀏覽器連到 `localhost`，但網站伺服器沒有成功啟動**。

這版已改成「可自動檢查 Python」的啟動方式，請直接照下面步驟。

---

## 你說你沒有安裝 Python（可直接用）

如果你是 Windows，可以**不用安裝 Python**，直接：

1. 雙擊 `start-no-python.bat`
2. 瀏覽器會開 `http://127.0.0.1:4173`
3. 黑色視窗不要關掉（關掉網站就停止）

這個模式是用系統內建的 PowerShell 啟動。  
⚠️ 但這是「純前端靜態模式」，資料仍會落在各裝置瀏覽器，不會跨手機/電腦共用。

---

## Windows（建議）

1. 進入專案資料夾，雙擊 `start.bat`
2. 會自動：
   - 檢查 Python（`py -3` 或 `python`）
   - 開啟瀏覽器到 `http://127.0.0.1:4173`
3. 命令視窗不要關掉（關掉就會停止網站）

如果看到 `找不到 Python`，請先安裝 Python 3：
https://www.python.org/downloads/

---

## Mac / Linux（建議）

```bash
./start.sh
```

然後打開：

```text
http://127.0.0.1:4173
```

`start.sh` 會自動檢查 `python3` / `python` 是否存在。

---

## 手動啟動（備用）

```bash
python3 api_server.py --port 4173 --host 127.0.0.1
```

（若你的系統是 `python` 指令，就把 `python3` 改成 `python`）

這個模式會啟動 Python API。
- 如果有設定環境變數 `DATABASE_URL`，會使用 PostgreSQL（例如 Neon）。
- 如果**沒有**設定 `DATABASE_URL`，現在會**自動改用本機 `../.gloss-app-data/app_state.json`**，網站仍可正常打開與儲存資料。
- 如果你的電腦**沒有安裝 Flask**，現在也會**自動改用 Python 內建伺服器**，不用先另外裝 Flask 才能開網站。

---

## 還是開不了時（快速排查）

### 1) 看啟動視窗有沒有錯誤
- 最常見：沒有 Python。
- 或是 `4173` 埠被占用。
- 如果以前看到 `No module named 'flask'`，新版會自動切到 Python 內建伺服器，不會再因為沒裝 Flask 而完全打不開。
- 如果本機 `../.gloss-app-data/app_state.json` 損壞或內容不是合法 JSON，系統現在會自動備份壞檔並重建新的狀態檔，避免前端一直顯示 HTTP 500。

### 2) 改埠再試（Mac/Linux）

```bash
./start.sh 5180
```

再開：

```text
http://127.0.0.1:5180
```

### 3) 直接測試伺服器是否有起來
在命令列輸入：

```bash
curl -I http://127.0.0.1:4173
```

若看到 `HTTP/1.0 200 OK` 代表網站已正常啟動。

### 4) 有開起來但畫面「看起來沒更新」
- 先確認網址列是 `http://127.0.0.1:4173`（不是 `file://`）。
- 按 `Ctrl + F5` 強制重新整理。
- 登入頁左下會顯示版本號（例如 `版本：2026-02-27-sync-check-1`），如果沒看到新版本，代表你還在舊資料夾。
- 建議關掉舊的 PowerShell 視窗後重開一次伺服器。

---


## 重要：如果你是用手機打開

你截圖裡是 `127.0.0.1`，這個位址只代表「當前這台裝置自己」。

- 在**手機**輸入 `127.0.0.1`，會連到手機自己，不會連到你的電腦。
- 所以會出現 `ERR_CONNECTION_REFUSED`（這是正常結果）。

### 手機要連線請這樣做

1. 在電腦啟動 LAN 模式：
   - Windows：雙擊 `start-lan.bat`
   - Mac/Linux：`./start-lan.sh`
2. 手機和電腦連同一個 Wi‑Fi
3. 手機瀏覽器輸入：`http://你的電腦IP:4173`
   - 例：`http://192.168.1.23:4173`
   - 啟動 `start-lan` 後，終端機會直接列出可用網址，可直接照打


### 為什麼右上角會從「集中式資料庫」變成「本機儲存」？
常見原因：
1. 你是用 `start-no-python.bat` 或 `file://` 直接開檔（這會是本機模式）。
2. 伺服器暫時斷線，系統會顯示重試中；連回後會再顯示集中式同步。

### 工單與財經沒連動怎麼排查
1. 工單要設成「已完成」或「已送出」。
2. 工單要有總價（總價是 0 的話，應收未收會是 0）。
3. 到財經主頁看「應收未收」是否更新。

### 手機還是連不到時（最常見）
1. 請確認你啟動的是 `start-lan.bat`（不是 `start-no-python.bat`）。
2. 確認電腦防火牆已允許 Python 對私有網路連線。
   - Windows 第一次啟動時若跳出防火牆提示，請勾選「私人網路」。
3. 先在電腦瀏覽器打開 `http://127.0.0.1:4173/api/health`，看到 `{"ok": true ...}` 才是正確啟動。
4. 手機和電腦一定要同一個 Wi‑Fi（不要一個用 5G 一個用 Wi‑Fi）。


## 資料現在存在哪裡？（白話）

- 目前已支援兩種 Python 啟動模式：
  - 有 `DATABASE_URL`：使用 `api_server.py + PostgreSQL`。
  - 沒有 `DATABASE_URL`：自動改用本機 `../.gloss-app-data/app_state.json`。
- 在這兩種模式下，只要手機和電腦都連同一台主機網址，就會看到同一份資料（差別只在資料是存在雲端 PostgreSQL 還是這台電腦本機 JSON）。
- 如果你用 `start-no-python.bat`（PowerShell 靜態模式），資料會回到各裝置瀏覽器本機，不共用。

## 跨裝置帳號同步行為（新）

- 帳號資料已從 `state` 拆分，改走獨立 `users` 儲存與 `/api/users` API（登入/註冊不再寫入 `state.users`）。
- 只要是透過同一台伺服器（同一個 `http://主機:埠`）登入，手機與電腦會共用同一批帳號。
- 若是 `DATABASE_URL` 模式，帳號與營運資料都會集中在 PostgreSQL。
- 若是本機 JSON 模式，營運資料在 `app_state.json`，帳號會獨立在 `users.json`；兩者都放在同一台主機，仍可跨裝置共用。
- 首次升級啟動時，系統會自動把舊版 `app_state.json` / `app_state.state_json` 裡的 `users` 一次性搬移到新帳號儲存。


### 只用磁碟也能跨電腦同步嗎？
可以，但要有「一台中央主機」：
- 資料庫存這台主機的磁碟（地端，不上雲）
- 所有電腦都連這台主機網址
- 這樣大家看到的就是同一份資料

## 登入與測試資料

- 登入頁改為「帳號 API 驗證」：
  - 登入只接受既有帳號（不存在或密碼錯誤會被拒絕）。
  - 註冊會呼叫 `/api/users` 建立 `viewer` 帳號。
- 內建測試帳號：
  - `admin / admin123`
  - `ops / ops123`
  - `finance / finance123`
  - `audit / audit123`
- 若帳號已存在，就必須輸入原本密碼；輸錯時系統會拒絕登入。
- 財經系統二次密碼（預設）：

```text
finance123
```

---

## 停止網站

在執行伺服器的終端機按：

```text
Ctrl + C
```
