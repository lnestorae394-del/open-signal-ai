# Структура Firestore

Все пользовательские документы содержат `botId`. Даты хранятся в ISO-8601 (UTC), кроме TTL-полей: адаптер Firestore записывает их как Timestamp.

| Коллекция | ID документа | Ключевые поля | Этап |
|---|---|---|---|
| `bots` | `botId` | status, telegramBotId, tokenEnc, tokenMasked, webhookSecretHash, devOnly, createdAt, archivedAt | 1 |
| `bot_configs` | `botId` | name, username, description{ru,uk,en}, miniAppTitle, defaultLanguage, theme{…}, modules{…}, accountBinding{…}, supportContact | 1 |
| `users` | `{botId}_{telegramId}` | telegramId, username, firstName, languageCode, createdAt, lastSeenAt, launches, bindingState, traderId, verifiedTraderIdHash, mismatchAttempts, lastRecheckAt | 1 |
| `user_settings` | `{botId}_{telegramId}` | language, favorites[], analysisMode | 1 |
| `partner_sources` | `sourceId` | botId, enabled, auth{method, secretEnc,…}, ipAllowlist[], mapping{…}, eventTypeMap{…} | 1 |
| `click_tokens` | `clickId` (128 бит) | botId, userDocId, createdAt, expiresAt | 1 |
| `postback_events` | `{sourceId}_{sha256(eventKey)}` | eventType, traderIdNorm, traderIdHash, clickId, deliveryCount, matchStatus, matchedUserDocId | 1 |
| `binding_claims` | `{userDocId}__{hash}` | traderIdNorm, traderIdHash, status (pending/matched/conflict/review/rejected) | 1 |
| `trader_bindings` | `{botId}_{sha256(traderId)}` | **замок уникальности:** userDocId, method, eventDocId, boundAt, boundBy | 1 |
| `audit_logs` | авто | botId, actor{type,id}, action, target, reason, before, after, at | 1 |
| `error_logs` | `{botId}_{fingerprint}` | module, code, message, count, firstSeenAt, lastSeenAt | 1 |
| `bot_stats_daily` | `{botId}_{YYYY-MM-DD}` | day, m_* счётчики | 1 |
| `webhook_updates` | `{botId}_{update_id}` | receivedAt, expireAt (TTL 3 дня) | 1 |
| `affiliate_stats_daily` | `{botId}_{date}` | агрегаты финансовых событий (только аналитика) | 2+ |
| `admin_users` | Firebase uid | email, role (owner/manager), active, botPermissions{botId: [права]} | 2 |
| `media` | авто | botId, kind, mime, size, data (сжатое изображение) | 2 |
| `market_data` | `{symbol}_{tf}` | общий кэш свечей: candles[], source, fetchedAt, marketState | 4 |
| `market_analyses` | авто | botId, userId/null, symbol, market, tf, method, params, result, explanation, sourceUrl, dataStatus | 4 |
| `simulation_sessions` / `simulation_history` | авто | botId, userId, symbol, intervalSec, startAt, endAt, startPrice, endPrice/null, dataVerified, userMark | 4 |
| `academy_courses` / `academy_lessons` / `academy_progress` | авто / `{botId}_{tg}_{lessonId}` | тексты {ru,uk,en}, blocks[], quiz, status draft/published; прогресс | 5 |
| `locks` | имя | блокировка планировщика | 4 |

Индексы описаны в `firebase/firestore.indexes.json`. Правила в `firebase/firestore.rules` запрещают любой клиентский доступ.

## Уникальность без гонок
- **Один Trader ID ↔ один Telegram ID:** ID документа `trader_bindings` — это хэш Trader ID, а создаётся он через `create` в транзакции. Второй такой документ создать невозможно.
- **Повторная доставка:** ID документов `postback_events` и `webhook_updates` детерминированы, поэтому повтор находит уже существующий документ.
