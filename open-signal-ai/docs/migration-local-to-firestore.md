# Переход с локального хранилища на Firestore

Бизнес-логика работает только через интерфейс `DocumentStore` (`apps/api/src/storage/types.ts`). Для перехода нужно реализовать `firestore-store.ts`; остальной код не меняется.

## Соответствие операций

| DocumentStore | Firebase Admin SDK |
|---|---|
| `get(c, id)` | `db.collection(c).doc(id).get()` |
| `query(c, {where, orderBy, limit})` | `.where(f, op, v)…orderBy(f, dir).limit(n).get()` |
| `create(c, id, data)` | `ref.create(data)`; ошибка `ALREADY_EXISTS` → `AppError('ALREADY_EXISTS')` |
| `set(c, id, data, {merge})` | `ref.set(data, { merge })` |
| `update(c, id, patch)` | `ref.update(patch)`; ошибка `NOT_FOUND` → `AppError('NOT_FOUND')` |
| `increment(n)` | `FieldValue.increment(n)` |
| `runTransaction(fn)` | `db.runTransaction(tx => …)`: `tx.get / create / set / update / delete` |
| поле `expireAt` | конвертировать ISO-строку в `Timestamp` (нужно для TTL) |

## Почему переход безопасен
- Локальный адаптер уже соблюдает правила Firestore: в транзакции все чтения идут до записей, `create` падает на существующем документе, `update` — на отсутствующем. Код, прошедший тесты, корректен и для Firestore.
- Транзакции Firestore автоматически повторяются при конфликте. Сервисы написаны так, чтобы повтор был безопасным: все решения принимаются внутри транзакции.

## Порядок перехода (этап 2/3)
1. Создать Firebase-проект, включить Firestore (native mode) и Authentication.
2. Реализовать `firestore-store.ts` и прогнать те же тесты против Firestore Emulator.
3. Развернуть правила и индексы: `firebase deploy --only firestore` (из папки `firebase`).
4. Перенести данные (если в локальном хранилище есть что-то нужное) скриптом `.data/local-store.json` → Firestore пакетами по 400 документов.
5. Переключить `STORAGE_DRIVER=firestore`.
