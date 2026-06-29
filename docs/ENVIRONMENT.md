# Environment Variables

Production deployments should configure these values in Vercel Environment Variables.

| Name | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Shared PostgreSQL storage for orders, customers, finance data, audits, and settings. |
| `APP_SESSION_SECRET` | Yes | Stable session signing secret. Use a random value with at least 32 bytes. |
| `OPENAI_API_KEY` | Optional | Enables AI order recognition. Hide AI tools in settings if this is not configured. |
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
