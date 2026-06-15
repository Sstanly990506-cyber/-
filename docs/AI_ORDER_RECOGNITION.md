# AI 工單識別設定

AI 工單識別會讓管理員或作業人員拍照／上傳工單，將識別結果填入既有工單表單。結果不會自動儲存，使用者必須確認後手動儲存。

## 環境變數

- `OPENAI_API_KEY`：必要。只設定於伺服器或 Vercel，不可放入前端程式。
- `OPENAI_ORDER_MODEL`：選填。預設為 `gpt-5.4-mini`。

未設定 `OPENAI_API_KEY` 時，原本手動建立工單功能不受影響，AI 識別會顯示設定提示。

在 Vercel 的 Project Settings → Environment Variables 新增 `OPENAI_API_KEY` 後，必須重新部署正式站才會生效。

## 限制

- 支援 JPEG、PNG、WebP。
- 手機端會自動多次壓縮圖片，確保請求低於 Vercel 的 4.5 MB 上限。
- AI 識別最長允許執行 60 秒。
- AI 可能辨識錯誤，儲存前必須人工確認所有欄位。
