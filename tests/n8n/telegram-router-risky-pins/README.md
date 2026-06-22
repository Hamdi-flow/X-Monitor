# Telegram Router Risky Path Pin Data

These fixtures are for `XMonitor - Telegram Router Staging` (`oLwwjO05IcRjtF8E`).
They let regression tests reach risky branches without live X writes, SMM orders,
Supabase mutations, Telegram sends, or AI generation.

Use each `*.pinData.json` file as the `pinData` argument for n8n MCP
`test_workflow` against the staging router. The files intentionally pin:

- The `Telegram Trigger` input.
- External read/write nodes on the exercised path.
- HTTP Request nodes that would call X or SMM.
- Telegram output nodes that would notify real chats.
- AI/Supabase nodes on the comment-order path.

## Fixtures

- `hide-replies-success.pinData.json`: exercises `hide_replies:<POST_ID>` and
  pins `Hide Reply On X` as a successful X hide response.
- `order-likes-success.pinData.json`: exercises `/order_likes POST_ID AMOUNT`
  and pins the SMM add/status calls.
- `order-comments-confirm-success.pinData.json`: exercises `/order_comments`,
  pins generated counter replies, pins the send-and-wait confirmation as
  `Confirm`, then pins the SMM add/status calls.

## Expected Safety

These fixtures should be treated as safe regression tests only while all
credentialed and HTTP nodes listed in the file remain pinned. If a risky path
adds a new external node, add it to the relevant fixture before running the test.

