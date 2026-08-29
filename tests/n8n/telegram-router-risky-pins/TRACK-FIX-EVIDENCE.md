# /track soft-delete fix — validation evidence

Staging router `XMonitor - Telegram Router Staging` (`oLwwjO05IcRjtF8E`),
staging Supabase `npytqidroqxgikaqofmq`. All runs 2026-08-24.

Both fixtures are registered in `manifest.json`. They are the only ones covering
the `/track` branch.

## Fixtures

- `track-users-soft-delete.pinData.json` — `/track @lynnharfoush` happy path.
  Pins the trigger, the X user lookup, both Supabase writes, and every Telegram
  send. Asserts the route reaches `Deactivate Tracked Users For Chat` (an update,
  not a delete) and ends at `Send Tracking Success`.
- `track-users-invalid-input.pinData.json` — `/track ?????`. Asserts
  `Parse Users To Track` returns `users_valid: false`, the branch ends at
  `Send Track Users Input Error`, and neither destructive node runs.

## Pinned runs

| Execution | Input | Result |
| --- | --- | --- |
| `14482` | `/track @lynnharfoush` | Route output 6, reached `Send Tracking Success`. Against the pre-fix graph. |
| `14499` | `/track ?????` | **Exposed a bug** — both destructive nodes ran before `If Track Users Input Valid`, `Upsert Tracked X User` never ran. |
| `14519` | `hide_replies:2060604129798496702` | Existing `hide-replies-success` fixture still passes — no regression from the rewiring. |
| `14520` | `/track @lynnharfoush` | Final graph. `Parse Users To Track` → validation → deactivate → `Restore Track User List` → split → upsert → success. |

## Live runs (Supabase nodes unpinned)

Only the trigger, X lookup, and Telegram sends were pinned; all database nodes
executed live. This is what the pinned runs cannot prove, because pinning a
Supabase node means the scoped PostgREST call never happens.

Fixture data: chat A = `8677383067` owning `1062472974`; seeded chat B =
`555000222` owning `999000111`. Chat B was removed afterwards.

| Execution | Scenario | Outcome |
| --- | --- | --- |
| `14504` | `/track` from chat A | **Exposed a bug** — `Upsert Tracked X User` was a Supabase *create*, not an upsert, and failed on `Tracked Users_pkey`. It had only ever worked because the old node deleted every row first. Isolation itself was proven here: only chat A's rows changed, chat B untouched, Posts/Replies unchanged. |
| `14507` | `/track` from chat A | **Exposed a bug** — reported `status: success` while doing nothing. `Split Users To Track` received a Supabase row instead of the handle list and emitted zero items. Fixed by `Restore Track User List`. |
| `14509` | `/track` from chat A | Correct. `1062472974` reactivated (`is_active` false → true), Telegram link re-created, chat B untouched, Posts/Replies unchanged at 1/73. |
| `14512` | `/track ?????` from chat A | Non-destructive. No row changed at all. |
| `14515` | `/track @lynnharfoush` from chat **B** | Ownership steal blocked — `1062472974` kept `telegram_chat_id = 8677383067` and stayed active. |

Row counts were `Posts = 1`, `Replies = 73` before and after every run. The
`ON DELETE RESTRICT` change means a cascade would have been impossible anyway,
but the counts were checked each time regardless.

## Production promotion (2026-08-24)

Promoted after the staging runs above. Order mattered: the migration had to land
first, because the router now writes `telegram_chat_id` and `is_active`.

| Step | Target | Result |
| --- | --- | --- |
| Migration | `jxnzdxyhoakpfmkbjdeq` | Applied via Supabase `apply_migration` as `tracked_users_soft_delete`. FK became `ON UPDATE CASCADE ON DELETE RESTRICT`; all 3 handles backfilled to chat `8372903693`, 0 unowned. |
| Router | `cWczsttyDbTBbRAC` | 15 operations, published `268c0f65`. Zero `"condition":"neq"` filters remain. |
| Scheduler | `Emb26wP77eFXgnVi` | `is_active` filter added, published `f5ed183e`. |
| Pinned check | execution `14529` | `/track` with all three prod handles: parse → validate → deactivate → `Restore Track User List` → split → upsert → `Send Tracking Success`. No live writes. |

Before/after production row counts identical: Tracked 3, Posts 22, Replies 927,
Telegram Users 1. All three handles `is_active = true`, owner `8372903693`.

Promotion checks that were verified rather than assumed:

- **Credential binding.** The new `Upsert Tracked X User` is a Postgres node; the
  router had none before. It is bound to the production `Postgres account`
  (`eJASCkyhwd9Hiqvb`), the same credential the hourly `Advance Post Suppression
  State` node already uses. `autoAssignedCredentials` was empty, so nothing was
  guessed. Note production carries two Postgres credentials — `Postgres account`
  and `Supabase Account` (`Usl8p3UJw2s7aMMe`) — and the scheduler uses both.
- **Pre-existing draft.** Production had an unpublished autosaved draft from
  2026-07-22 by tarek ismail. Publishing would have shipped it, so it was
  compared against the live version first: node ids, node types, credentials,
  jsCode count and the entire connections object were identical. The only
  difference was one node's canvas position (`Send Snooze Duration Menu`) plus
  editor key re-ordering. Nothing unintended shipped.
- **Settings preserved.** Activation, `errorWorkflow` (`UmKr9JkZ3ec3GDH5`), tags,
  and `availableInMCP` unchanged. The router's settings never contained
  `timeSavedMode`/`callerPolicy`, unlike the scheduler's — checked against the
  pre-change capture rather than assumed.

## Known gaps

- **False success on a blocked steal.** In `14515` chat B was still told
  "Successfully tracking the following users: - lynnharfoush". The Postgres node
  returns `{"success": true}` for a zero-row query, so the chain continues to
  `Send Tracking Success`. Data is safe; the message is a lie. Needs an explicit
  "already tracked by another chat" branch before multi-tenant onboarding.
- **A failed X lookup still leaves the caller deactivated.** Validation now
  precedes the deactivate, but the X lookup does not. `/track @nonexistenthandle`
  deactivates the chat's accounts and then fails. Moving the deactivate past
  `If X User Lookup Successful` needs a merge, because the deactivate is
  once-per-chat while the lookup is per-handle.
- **`Telegram Users.id` churns on every `/track`.** `Clear Telegram User Links`
  deletes the row and `Link Telegram User To X User` re-inserts it, and `id` is
  `GENERATED ALWAYS AS IDENTITY`. Harmless today since only `chat_id` is read.
  Deleting the node entirely would be cleaner — the insert already upserts the
  chat.
