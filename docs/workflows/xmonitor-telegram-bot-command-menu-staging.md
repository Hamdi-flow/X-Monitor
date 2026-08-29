# XMonitor - Telegram Bot Command Menu Setup Staging

## Purpose

Manual staging utility that sets Telegram's bot command menu for the XMonitor Telegram router and verifies it with `getMyCommands`.

## Identity

- n8n ID: `Rwsu0hUtYA0Ithpl`
- Environment: staging utility
- Active: no
- Local script: `scripts/set-telegram-bot-commands.ps1`

## Command Menu

The menu mirrors the router parser and help text:

| Command | Description |
| --- | --- |
| `/start` | Open the XMonitor guide |
| `/help` | Show commands and examples |
| `/auth_x` | Connect the X account that owns posts |
| `/track` | Replace tracked X users. Usage: `/track user1 user2` |
| `/ignore` | Stop alerts for a post. Usage: `/ignore POST_ID` |
| `/snooze` | Choose a snooze duration. Usage: `/snooze POST_ID` |
| `/resume` | Resume monitoring. Usage: `/resume POST_ID` |
| `/hide_replies` | Hide stored negative replies. Usage: `/hide_replies POST_ID` |
| `/order_likes` | Order likes. Usage: `/order_likes POST_ID AMOUNT` |
| `/order_comments` | Generate supportive comments with an amount form. Usage: `/order_comments POST_ID` |

Telegram command menus only support slash command names plus descriptions, so callback payloads such as `snooze:<post_id>` and `snooze_duration:<post_id>:<duration>` remain inline button actions rather than menu entries.

## Setup Paths

The n8n workflow reads `STAGING_TELEGRAM_BOT_TOKEN` from the n8n environment and calls:

1. `setMyCommands`
2. `getMyCommands`

The local script does the same from ignored `keys.env` for both Telegram's default command scope and the `all_private_chats` scope. The private-chat scope matters because it overrides the default menu in direct bot chats. Add `STAGING_TELEGRAM_BOT_TOKEN` to `keys.env`, then run:

```powershell
.\scripts\set-telegram-bot-commands.ps1
```

The script prints only the bot username, whether the update succeeded, and the command names returned by Telegram. It does not print the bot token.

## Validation

- Confirm the command list matches `Parse Telegram Message`, `Send Help Manual`, and `Send Default Help` in the Telegram router.
- Run the manual staging workflow if `TELEGRAM_BOT_TOKEN` is configured in n8n, or run the local script if the token is configured in ignored `keys.env`.
- Verify Telegram returns all expected command names from `getMyCommands` for both default and `all_private_chats` scopes.

## Risk Boundaries

- Applying commands changes bot-level metadata for whichever bot token is used.
- Use the testing Telegram bot first. Apply the same list to production only after explicitly choosing the production token.
