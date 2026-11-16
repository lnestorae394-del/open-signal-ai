# Изменения относительно архива OPEN-SIGNAL-AI-TELEGRAM-ONBOARDING-FIX.zip

## Что сделано
- Онбординг обязателен: убраны гостевой режим и кнопка «посмотреть обучение и демо». Шаг 2 проверяет Trader ID по postback регистрации и `click_id`; при ошибке — понятный текст и «Попробовать ещё раз». Шаг 3 — статусы депозита только из postback, порог $10.
- Глобальный postback: маршрутизация по `click_id`, проверка принадлежности боту, защита от повторов без ID события, конфликт сумм, финансовый журнал, вкладки «История» и «Ошибки интеграции».
- DEMO-интерфейс удалён целиком: симулятор цен, свечи, RSI, графики, пакет `packages/indicators`, `apps/api/src/market`.
- Новые сигналы: выбор пары (Forex / OTC, поиск, избранное), 9 вариантов времени, подготовка, BUY / SELL, отсчёт, «Следующий сигнал». Честная пометка «учебный сигнал».
- Академия: общий каталог, категории, уроки (текст, видео, PDF), прогресс; редактор в админке.
- Профиль: Telegram ID, имя, бот, Trader ID, регистрация, FTD, сумма, прогресс обучения.
- Админка: разделы «Postback и депозиты», «Академия», «Сигналы»; в списке пользователей — проверка Trader ID, причина отказа, статус депозита.
- Индексы Firestore для новых запросов; правила Firestore не изменены (клиентский доступ запрещён).
- Тесты: онбординг, проверка Trader ID, FTD / redeposit, повторная доставка, конфликт сумм, изоляция по botId, сигналы, академия.

Данные Firestore не удаляются; старые поля и коллекции просто не используются.

## Дополнительная техническая проверка
- Повторные депозиты без ID события больше не объединяются по сумме: засчитываются все, похожие помечаются, администратор может исключить событие с причиной (журнал).
- FTD — один на Trader ID; сумма FTD только из события `ftd`.
- click_id нового формата (32 hex), регистр не важен; старые коды работают.
- Проверка партнёрской ссылки проходит цепочку редиректов.
- Точные версии зависимостей, `.npmrc`, команда `npm run lock:check`.
- Подробно: docs/TECH-CHECK-REPORT.md.

## Файлы (A — добавлен, M — изменён, D — удалён)
```
M README.md
M apps/admin/src/App.tsx
M apps/admin/src/components/BotForm.tsx
M apps/admin/src/components/UsersTable.tsx
M apps/admin/src/components/layout.tsx
A apps/admin/src/pages/AcademyAdmin.tsx
M apps/admin/src/pages/BotDetail.tsx
M apps/admin/src/pages/BotTabs.tsx
A apps/admin/src/pages/Postback.tsx
M apps/admin/src/pages/Sections.tsx
A apps/admin/src/pages/SignalsAdmin.tsx
M apps/api/package.json
A apps/api/src/academy/builtin.ts
A apps/api/src/academy/service.ts
M apps/api/src/admin/bots-admin.ts
M apps/api/src/admin/insights.ts
M apps/api/src/app.ts
D apps/api/src/binding/access.ts
M apps/api/src/binding/onboarding.ts
M apps/api/src/binding/postback.ts
M apps/api/src/binding/service.ts
M apps/api/src/domain/bots.ts
M apps/api/src/domain/records.ts
M apps/api/src/http/admin-routes.ts
M apps/api/src/http/routes.ts
M apps/api/src/http/static.ts
M apps/api/src/lib/errors.ts
D apps/api/src/market/signals.ts
D apps/api/src/market/simulator.ts
D apps/api/src/market/source.ts
A apps/api/src/platform/settings.ts
A apps/api/src/signals/engine.ts
A apps/api/src/signals/service.ts
M apps/api/src/storage/collections.ts
M apps/api/test/admin.test.ts
M apps/api/test/binding.test.ts
M apps/api/test/helpers.ts
M apps/api/test/http-tenancy.test.ts
M apps/api/test/platform.test.ts
M apps/miniapp/src/App.tsx
M apps/miniapp/src/components/chrome.tsx
D apps/miniapp/src/components/market.tsx
M apps/miniapp/src/index.css
M apps/miniapp/src/lib/api.ts
A apps/miniapp/src/screens/Academy.tsx
D apps/miniapp/src/screens/HistoryAcademy.tsx
M apps/miniapp/src/screens/Onboarding.tsx
D apps/miniapp/src/screens/Pairs.tsx
M apps/miniapp/src/screens/Profile.tsx
M apps/miniapp/src/screens/Signals.tsx
M apps/miniapp/src/state.tsx
D docs/CHANGES-2026-11-16.txt
M docs/account-binding.md
M docs/architecture.md
M docs/deploy-render.md
A docs/env-vars.md
M docs/firestore-schema.md
M docs/global-pocket-partners-postback.md
D docs/telegram-auth-onboarding-fix.txt
M docs/update-render.md
M firebase/firestore.indexes.json
M packages/i18n/src/locales/en.json
M packages/i18n/src/locales/ru.json
M packages/i18n/src/locales/uk.json
M packages/i18n/test/i18n.test.ts
D packages/indicators/package.json
D packages/indicators/src/index.ts
D packages/indicators/test/indicators.test.ts
M packages/shared/src/constants.ts
M packages/shared/src/index.ts
A packages/shared/src/platform.ts
M packages/shared/src/schemas.ts
M packages/shared/test/shared.test.ts
M packages/ui/src/components/icons.tsx
M tsconfig.json
```
