# One global Pocket Partners postback

OPEN SIGNAL AI supports one global partner source (`botId: "*"`). The source is shared by every Telegram bot. Each bot still stores its own registration URL; every registration URL must pass the generated per-user `{click_id}` through a Pocket Partners tracking parameter.

## Event routing

All three partner events call the same endpoint:

`https://YOUR-OPEN-SIGNAL-DOMAIN/postback/SOURCE_ID`

The event is identified by the configured `event` parameter. The global handler resolves the tenant from the click token, checks that it belongs to the same bot as the event, and then matches the Trader ID binding.

Recommended parameter mapping for the Pocket Partners source:

| Platform field | Query parameter |
|---|---|
| shared secret | `key` |
| event type | `event` |
| Trader ID | `trader_id` |
| click token | `click_id` |
| partner event ID | `event_id` |
| event timestamp (alternative to event_id) | `event_time` |
| deposit amount | `sumdep` |
| currency | `currency` |

Map raw event values to platform event types:

- `registration` → `registration`
- `ftd` → `ftd`
- `redeposit` → `redeposit`

Example callback shapes (replace placeholders with the exact macros supported by Pocket Partners):

- Registration: `?key=SECRET&event=registration&trader_id={trader_id}&click_id={click_id}&event_id={event_id}`
- First deposit: `?key=SECRET&event=ftd&trader_id={trader_id}&click_id={click_id}&sumdep={sumdep}&currency={currency}&event_id={event_id}`
- Repeat deposit: `?key=SECRET&event=redeposit&trader_id={trader_id}&click_id={click_id}&sumdep={sumdep}&currency={currency}&event_id={event_id}`

Do not activate the source until Pocket Partners confirms the exact macros for `click_id` and a unique event ID (or event timestamp). Without a unique ID/timestamp, safe retry deduplication of repeated deposits is impossible. The app intentionally rejects financial events that cannot be deduplicated.

The secret is displayed once when the source is created. Keep it private. Do not reuse Academy callback URLs or secrets.
