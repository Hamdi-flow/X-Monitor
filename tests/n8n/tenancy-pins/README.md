# Tenancy pins — Phase T2 authorization

The isolation fixture class for [`docs/architecture/multi-tenant-and-web-ui.md`](../../../docs/architecture/multi-tenant-and-web-ui.md)
§12b. `manifest.json` records what each fixture proves; this file explains the shape so
T3 and T4 can extend it without re-deriving the reasoning.

## The hole these close

Before T2, `Get Post For Hide`, `Get Post For Status Change`, `Get Post For Comment Order`
and `Get Post For Likes Order` all filtered on `post_id` alone. Post ids are not secret —
they appear in every X URL. Any chat that could reach the bot could therefore hide replies
on, snooze, ignore, or **place paid SMM orders against** any post in the system, including
another client's. Decision #6 gives clients every action including paid orders, and SMMWiz
has no cancel, which makes that sharper rather than softer.

## Where the check lives

One shared resolver, not four separate joins — it is less to keep in step, and it
prefigures §6.3, where the Action Executor performs exactly this check for both Telegram
and the console.

```
Parse Telegram Message
  -> Resolve Caller Authorization   (Postgres: one query, both halves)
  -> Build Caller Authorization     (Code: { auth_client_ids, auth_is_staff, auth_is_known })
  -> If Caller Known                (unknown chat is refused before the route switch)
  -> Route Telegram Intent
```

```
caller chat_id -> { client_ids: [...], is_staff: bool }
   client_ids = active Client Members rows, on active Clients, for this chat
   is_staff   = an active Staff row for this chat
```

Each post lookup then gains a gate:

```
Get Post For X -> If X Authorized -> (true)  original downstream, unchanged
                                  -> (false) Build Access Refusal
```

A post is actionable when it **exists** and (`is_staff` **or** its `client_id` is in the
caller's `client_ids`). All six false branches — four post gates, the unknown-chat branch,
and the `/track` staff gate — converge on one `Build Access Refusal`.

## The rule that is easy to break

**"Post not found" and "post belongs to another client" return the same message.** Only the
post id differs, and the caller supplied that themselves. If those two ever diverge, the bot
becomes an oracle for probing which post ids exist inside other clients, and the security fix
is undone without any test going red unless you check for exactly this.

`missing-post-refusal` exists to catch that. Assert it against `cross-tenant-ignore` with the
post id normalised out; they must be byte-identical. The real reason lives in
`Build Access Refusal`'s `refusal_reason` (`cross_tenant_post` vs `post_not_found`) and in
the developer alert — never in the reply to the user.

## Fails closed

`Resolve Caller Authorization` has `alwaysOutputData`. If it returns nothing, the caller gets
no `client_ids` and `is_staff = false`, which refuses. There is no path where a failed lookup
grants access.

## Recording refusals

`Action Log` does not exist yet — it arrives with the Action Executor, after T4 — so refusals
are recorded in execution data by `Build Access Refusal` and escalated by
`Build Developer Alert - Access Denied`:

- **unknown chat** → always alerts, carrying chat id, name and type so it can be assigned
  (decision #7).
- **everything else** → alerts once a chat produces 3 refusals in a rolling hour, which is
  what probing looks like. The counter lives in workflow static data, which n8n persists for
  **production (trigger) executions only** — in a pinned run `denial_count` is always 1, so
  post denials never alert during testing. That is deliberate: it keeps these fixtures
  deterministic. Do not "fix" it by lowering the threshold.

## Why these fixtures are fully pinned

Every fixture pins `Resolve Caller Authorization` and the relevant `Get Post For *`. Two
consequences worth knowing:

1. They are **self-contained** — they survived the teardown of the synthetic staging tenants
   and will keep passing without any database rows.
2. They are **environment-agnostic** — the same file proves the same graph logic against
   staging `oLwwjO05IcRjtF8E` or production `cWczsttyDbTBbRAC`, because authorization is
   decided by pinned data rather than by that environment's own `Client Members` / `Staff`.

The trade-off is that they test the *gate*, not the *SQL*. The resolver query itself was
proved by a separate live run against real staging tenancy rows — `staging-fixtures.sql`
recreates those rows so T4 can re-prove it end to end.

## Actors

| Chat | Role |
| --- | --- |
| `9900000001` | chat A — client member of `tenancy-test-a`, **not** staff |
| `9900000002` | chat B — client member of `tenancy-test-b`, **not** staff |
| `8677383067` | staging operator — a `house` member **and** a `Staff` row, so it acts across every client |
| `9900000009` | unknown — in neither table |

Chat A and chat B are deliberately non-staff. The operator chat is staff, so it can never
prove the client path; that is what chat A is for.

## Safety

Same rules as [`../telegram-router-risky-pins/README.md`](../telegram-router-risky-pins/README.md):
pinned before live, and **never** run `/order_comments` or a valid `/order_likes` live. A
refusal test is safe by definition — it stops before the provider call. The authorized-path
controls are not: `same-tenant-order-likes-authorized` pins `Place Likes Order` to a provider
rejection and `same-tenant-order-comments-authorized` pins the confirmation to *Do nothing*,
so each proves its gate is open without creating or charging an order.

## The legacy suite must also pass unchanged

Every fixture in `tests/n8n/telegram-router-risky-pins/` still passes after T2, untouched.
They all run as chat `8677383067`, which is a `Staff` row, so `is_staff` short-circuits the
owner check — their pinned post rows were authored before T1 and carry no `client_id` at all,
and are never consulted. **If one of them starts failing, the resolver is rejecting something
it should allow.** Fix the resolver, not the fixture.

## Known gap, deliberate

`SNOOZE_MENU` (`snooze:<POST_ID>` and bare `/snooze <POST_ID>`) is **not** gated. It renders a
duration keyboard purely from the post id the caller typed and never touches the database, so
it is neither an oracle nor a side effect. Choosing a duration produces `SNOOZE_POST`, which
**is** gated and refuses. Unknown chats cannot reach it at all, since `If Caller Known` sits
before the route switch. Gating it would need a fifth post lookup to buy nothing.
