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
- Своя партнёрская ссылка у каждого бота: текст кнопки на трёх языках, ID партнёра, проверка ссылки, личный `click_id` для каждого пользователя (в ссылке доступны `{click_id}`, `{bot_id}`, `{partner_id}`).
- Автонастройка Telegram: webhook, кнопка меню с адресом Mini App, приветствие на /start на языке пользователя.
- **Обязательный онбординг из трёх шагов** без обходов и гостевого режима: регистрация → Trader ID (проверяется по postback регистрации) → первый депозит от $10 (только из postback). Состояние хранится в Firestore и не зависит от устройства.
- **Один глобальный postback** `/postback/<sourceId>` для всех ботов: регистрация, FTD, повторный депозит; маршрутизация по `click_id`, защита от повторной доставки, конфликт сумм, финансовый журнал.
- **Сигналы:** выбор пары (Forex / OTC, поиск, избранное), время сделки 15 с – 30 мин, экран подготовки, BUY / SELL, отсчёт после «Открыл сделку», лимиты в админке. Сейчас сигналы **учебные** (направление случайное) — приложение прямо об этом пишет. Реальный движок подключается через интерфейс `SignalEngine`.
- **Академия:** общий каталог для всех ботов, категории, уроки с текстом, видео (YouTube / Vimeo / mp4) и PDF, прогресс пользователя.
- Разделы админки: Обзор, Боты, Пользователи, Postback и депозиты (источник, история, ошибки интеграции), Академия, Сигналы, Менеджеры, Настройки, Аккаунт.
- RU / UK / EN без смешивания языков.

## Развернуть

Пошаговая инструкция: **[docs/deploy-render.md](docs/deploy-render.md)**. Нужно: аккаунт GitHub, проект Firebase с Firestore и аккаунт Render. Всё остальное (ключи шифрования, индексы базы, webhook, кнопка Mini App, описание бота) делается автоматически.

## Команды

Требуется Node.js 22.18 или новее.

```bash
npm install          # зависимости; первый запуск создаёт package-lock.json — добавьте его в git
npm run lock:check   # lock-файл совпадает с package.json и установленными пакетами
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
- [docs/account-binding.md](docs/account-binding.md) — онбординг и привязка Telegram ID ↔ Trader ID
- [docs/manual-access.md](docs/manual-access.md) — карточка пользователя: ручной доступ к сигналам и восстановление онбординга
- [docs/global-pocket-partners-postback.md](docs/global-pocket-partners-postback.md) — подключение postback Pocket Partners
- [docs/env-vars.md](docs/env-vars.md) — переменные окружения
- [docs/TEST-REPORT.md](docs/TEST-REPORT.md) — что проверено и что нет
- [docs/CHANGES.md](docs/CHANGES.md) — список изменений
- [docs/TECH-CHECK-REPORT.md](docs/TECH-CHECK-REPORT.md) — отчёт дополнительной технической проверки
- [docs/firestore-schema.md](docs/firestore-schema.md) — коллекции базы данных
- [docs/dependency-audit.md](docs/dependency-audit.md) — зависимости и аудит
