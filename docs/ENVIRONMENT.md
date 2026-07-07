# Environment Variables

Production deployments should configure these values in Vercel Environment Variables.

| Name | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Shared PostgreSQL storage for orders, customers, finance data, audits, and settings. |
| `APP_SESSION_SECRET` | Yes | Stable session signing secret. Use a random value with at least 32 bytes. |
| `OPENAI_API_KEY` | Optional | Enables AI order recognition. Hide AI tools in settings if this is not configured. |
| `LINE_CHANNEL_SECRET` | Optional | LINE Messaging API channel secret. Required for webhook signature verification. |
| `LINE_CHANNEL_ACCESS_TOKEN` | Optional | LINE Messaging API channel access token. Required for LINE replies and push notifications. |
| `INIT_ADMIN_PASSWORD` | First deploy | Initial admin password bootstrap. Change it after setup. |
| `FINANCE_MODULE_PASSWORD` | Optional | Initial finance module password bootstrap. |

Generate a session secret locally:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Do not commit secrets or API keys to this repository. If `DATABASE_URL` exists but
`APP_SESSION_SECRET` is missing, the app uses a database-derived fallback so all API
routes stay consistent, but an explicit `APP_SESSION_SECRET` is still the recommended
production setup.

## LINE Messaging API

Set the LINE Developers webhook URL to:

```text
https://www.sanqingco.com/api/line/webhook
```

After deployment, send `綁定` to the LINE official account. The system stores that
chat as a notification destination. Then the notification center and finance screen
can push reminders to LINE.

Supported LINE reply commands include:

- `綁定`
- `狀態`
- `提醒`
- `工單 115060162`
- `未完成工單`
- `客戶 三青`
- `應收 佳德`
- `應付 油墨`
- `庫存 紙`

LINE replies also include quick-reply buttons for common actions, so users can
tap `未完成工單`, `查工單`, `查客戶`, `查應收`, `查庫存`, `狀態`, `提醒`, or `說明`
without memorizing command words.
