# 上光廠內部系統（前端原型）

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

在執行伺服器的終端機按：

```text
Ctrl + C
```
