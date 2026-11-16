# OPEN SIGNAL AI

Мультитенантная платформа Telegram Mini App: одна админка, один backend и неограниченное число персональных Telegram-ботов, без отдельного сервера на каждого бота.

> Самостоятельный продукт. Не использует код, данные, Firebase-проекты или брендинг других проектов.

## Состав

| Папка | Что это |
|---|---|
| `apps/api` | Backend: Node.js 22 + TypeScript, транспорт Fastify, Zod |
| `apps/admin` | Центральная админка: React + Vite + Tailwind CSS 4 |
| `apps/miniapp` | Telegram Mini App: React + Vite + Tailwind CSS 4 |
| `packages/shared` | Общие типы, Zod-схемы, справочник инструментов, торговый календарь Forex |
| `packages/ui` | Design system: CSS-переменные темы, компоненты, иконки |
| `packages/i18n` | Переводы RU / UK / EN (отдельные файлы), проверка полноты |
| `packages/indicators` | RSI, Stochastic, Bollinger Bands (чистые функции + тесты) |
| `firebase` | `firebase.json`, `firestore.rules`, `firestore.indexes.json` |
| `docs` | Архитектура, схема Firestore, миграция, Account Binding, инструкции |

## Статус: Этап 1

Готово и проверено тестами: ядро API (шифрование, initData, сессии, изоляция ботов, webhook, Account Binding + postback, лимиты запросов, логи), общие пакеты, интерфейсы Mini App и админки.

**Ещё не подключено (честно):** Firebase, реальные Telegram-боты, источник рыночных данных, вход в админку. Подробности — в `docs/stage-1-report.md`.

## Быстрый старт (локально)

Требуется Node.js 22.18 или новее.

```bash
npm install
cp .env.example apps/api/.env
npm run gen:key -w @open-signal/api     # скопируйте 3 строки в apps/api/.env
npm run seed:dev                         # создаёт локального тестового бота
npm run dev:api                          # API на http://localhost:8080
npm run dev:miniapp                      # Mini App на http://localhost:5173/?bot=<id из seed>
npm run dev:admin                        # Админка на http://localhost:5174
npm test                                 # все тесты
```

Подробная пошаговая инструкция — `docs/setup-from-scratch.md`.

## Главные правила проекта

- Секреты никогда не попадают в код, git, логи или чат. В базе токены ботов хранятся только в зашифрованном виде (AES-256-GCM).
- Браузер не обращается к Firestore напрямую: правила запрещают любой клиентский доступ, всё идёт через API.
- Никаких выдуманных котировок, результатов или статистики. Если данных нет, интерфейс так и пишет.
- OTC-котировки никогда не подменяются котировками Forex.
- Академия и демо-симулятор доступны без привязки аккаунта и без депозита.
