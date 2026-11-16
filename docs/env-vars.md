# Переменные окружения

В этом обновлении **новых переменных нет**. На Render ничего добавлять или менять не нужно.

| Переменная | Обязательна | Откуда берётся |
|---|---|---|
| `NODE_ENV` | да | `production` (задано в `render.yaml`) |
| `NODE_VERSION` | да (Render) | `22.18.0` (задано в `render.yaml`) |
| `ENCRYPTION_KEY` | да | генерирует Render; **не менять** — иначе токены ботов не расшифруются |
| `SESSION_SECRET` | да | генерирует Render |
| `ADMIN_SETUP_TOKEN` | да | генерирует Render; нужен только для создания первого владельца |
| `FIREBASE_SERVICE_ACCOUNT` | да | JSON сервисного аккаунта Firebase — вставляется вручную в Render, в архив и чат не попадает |
| `LOG_LEVEL` | нет | `info` |
| `PUBLIC_URL` | нет | адрес сервиса; без него берётся `RENDER_EXTERNAL_URL` |
| `CORS_ORIGINS` | нет | дополнительные разрешённые адреса через запятую |
| `ENCRYPTION_KEY_ID`, `ENCRYPTION_KEY_PREVIOUS` | нет | только при смене ключа шифрования |
| `STORAGE_DRIVER`, `HOST`, `PORT`, `TRUST_PROXY`, `WEB_DIST_DIR` | нет | служебные; на Render не задавать |

Для локального запуска секреты создаются командой `npm run gen:secrets > .env` на вашем компьютере. Файл `.env` в git и архив не попадает.
