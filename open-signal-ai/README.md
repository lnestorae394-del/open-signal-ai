# OPEN SIGNAL AI

Мультитенантная платформа Telegram Mini App: одна админка и один сервер обслуживают любое число ботов. У каждого бота свои название, аватар, тексты на трёх языках, тема, модули, пользователи, статистика, логи, привязка Trader ID и postback-источники.

Один веб-сервис отдаёт:

| Адрес | Что это |
|---|---|
| `/admin/` | Админка (владелец и менеджеры) |
| `/app/?bot=<id>` | Mini App, открывается кнопкой в Telegram |
| `/api/...` | API |
| `/tg/webhook/<id>` | Webhook Telegram (настраивается автоматически) |
| `/postback/<sourceId>` | Postback партнёрских программ |
| `/health` | Проверка состояния для Render |

## Возможности

- Неограниченное число ботов в одной админке; данные каждого бота изолированы по `botId`.
- Своя партнёрская ссылка у каждого бота: название кнопки на трёх языках, ID партнёра, проверка ссылки, личный `click_id` при каждом переходе.
- Автонастройка Telegram: webhook, кнопка меню «OPEN SIGNAL AI» с адресом Mini App, приветствие на /start на языке пользователя. Шаг отмечается выполненным только после подтверждения Telegram.
- Онбординг из трёх шагов (регистрация → Trader ID → проверка и депозит). Состояние хранится на сервере, повторно проходить не нужно. Академия и демо открыты без регистрации и депозита.
- Forex и OTC — независимые режимы со своими инструментами, периодами, графиком, RSI, демо-сигналами, историей и статистикой. Котировки пока не подключены, поэтому работает SIMULATION MODE с постоянной отметкой DEMO / SIMULATED.
- Postback готов к подключению: регистрация, FTD, redeposit, идемпотентность, журнал событий.
- Разделы админки: Обзор, Боты, Пользователи, Менеджеры (права по каждому боту), Настройки, Аккаунт.
- RU / UK / EN без смешивания языков.

## Развернуть

Пошаговая инструкция: **[docs/deploy-render.md](docs/deploy-render.md)**. Нужно: аккаунт GitHub, проект Firebase с Firestore и аккаунт Render. Всё остальное (ключи шифрования, индексы базы, webhook, кнопка Mini App, описание бота) делается автоматически.

## Команды

Требуется Node.js 22.18 или новее.

```bash
npm install          # зависимости
npm run typecheck    # строгая проверка TypeScript (сервер, админка, Mini App)
npm test             # сборка + все тесты (локальное хранилище)
npm run test:firestore  # те же тесты через Firestore REST-адаптер
npm run build        # production-сборка админки и Mini App в dist/web
npm start            # production-сервер (переменные окружения задаёт Render)
```

Локальная разработка:

```bash
npm run gen:secrets > .env   # секреты генерируются на вашем компьютере
npm run dev                  # http://localhost:8080/admin/
```

## Документация

- [docs/deploy-render.md](docs/deploy-render.md) — первое развёртывание на Render и Firebase
- [docs/update-render.md](docs/update-render.md) — обновление уже работающего сервиса
- [docs/github-first-push.md](docs/github-first-push.md) — первая загрузка в GitHub
- [docs/architecture.md](docs/architecture.md) — устройство платформы
- [docs/account-binding.md](docs/account-binding.md) — привязка Telegram ID ↔ Trader ID и postback
- [docs/firestore-schema.md](docs/firestore-schema.md) — коллекции базы данных
- [docs/dependency-audit.md](docs/dependency-audit.md) — зависимости и аудит
