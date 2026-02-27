# 上光廠內部系統（前端原型）

codex/develop-a-web-based-internal-system
這個版本是前端原型（`index.html + app.js + styles.css`），
你說得沒錯：**要先把網站開起來，才能在瀏覽器使用**。

## 1) 啟動方式（最簡單）

在專案資料夾執行：

```bash
python -m http.server 4173 --bind 0.0.0.0
```

看到這行代表啟動成功：

```text
Serving HTTP on 0.0.0.0 port 4173
```

## 2) 打開網站

在瀏覽器開：

```text
http://localhost:4173
```

## 3) 登入與測試

- 登入頁：帳號/密碼先輸入任意內容即可進入（目前是原型版）。
- 財經系統二次密碼（預設）：

```text
finance123
```

## 4) 常見問題

### Q1. 點按鈕沒反應
- 先確認你是用 `http://localhost:4173` 開啟，
  不要直接雙擊 `index.html`（有些瀏覽器對本機檔案模式限制較多）。

### Q2. 想重置資料
- 目前資料存在瀏覽器 `localStorage`。
- 在瀏覽器開發者工具清除該站點儲存資料，或直接換無痕視窗測試。

### Q3. 關掉終端機網站就不能用
- 是正常的，因為 `python -m http.server` 關掉後服務就停止。

## 5) 停止網站
=======
你遇到的 `ERR_CONNECTION_REFUSED` 代表：
**瀏覽器連到 `localhost`，但網站伺服器沒有成功啟動**。

這版已改成「可自動檢查 Python」的啟動方式，請直接照下面步驟。

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
python3 -m http.server 4173 --bind 127.0.0.1
```

（若你的系統是 `python` 指令，就把 `python3` 改成 `python`）

---

## 還是開不了時（快速排查）

### 1) 看啟動視窗有沒有錯誤
- 最常見：沒有 Python。
- 或是 `4173` 埠被占用。

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

---

## 登入與測試資料

- 登入頁：帳號/密碼目前可輸入任意內容（原型版）。
- 財經系統二次密碼（預設）：

```text
finance123
```

---

## 停止網站
 main

在執行伺服器的終端機按：

```text
Ctrl + C
```
