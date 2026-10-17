# Changelog — X-Monitor

[workflows/manifest.json](workflows/manifest.json) is the index of workflows and exports;
[docs/workflows/](docs/workflows/) holds the per-workflow reference. Entries are newest-first
and name the workflow and environment they apply to. Mirrors the format of the sibling
FB Monitor and Insta-Monitor changelogs.

---

## [Unreleased]

- **Shared classifier prompt table, staging, 2026-10-18 (MINOR).** New migration
  `db/migrations/2026-10-18-sentiment-prompts.sql` creates `public."Sentiment Prompts"` (key PK,
  `system_prompt`, `user_template`, `model`, `temperature`, `categories`, `notes`,
  `updated_at` + trigger, RLS on). It seeds three rows:
  - `target_stance_rules`, written once;
  - `comment_text`, which includes the rules and holds `{{cheat_sheet_block}}`;
  - `comment_image`, which also includes the rules.

  This repo owns the file because it owns the other cross-product tables. **Applied to staging
  `npytqidroqxgikaqofmq` only**; production waits for sign-off.
  - **XMonitor - Scheduled Post Tracking Staging** `l4eKZucUZXzfz0H8`, saved draft `8521396d`
    (still inactive by design):
    - added `Get Sentiment Prompts` → `Resolve Sentiment Prompts` between `Schedule Trigger` and
      `Get Run State`;
    - added `Build Sentiment Prompt Warning` → `Build Scheduler Developer Alert`;
    - `Classify Sentiment` system prompt, `OpenAI Sentiment Model` model + temperature, and
      `Build Analysis Plan`'s classifier input now come from the table.

    The shared text is platform-neutral, so the prompt now says "comment" and "a Lebanese public
    account". The input says "Post:" / "Comment" instead of "Post text:" / "Reply". The
    `<caption>` / `<comment>` tags are unchanged. See the staging doc.
  - Evidence:
    - pinned suite **21/21 green**, executions `49307`–`49333`. This includes both cheat-sheet
      fixtures (`CANARY_ALPHA` / `CANARY_BRAVO` reach the prompt), with `Get Sentiment Prompts`
      reading the real staging table.
    - real manual run **`49338`**: 201 new replies classified on the table prompt, 34 Positive /
      13 Neutral / 154 Negative / 0 failed. The system message sent to OpenAI contained the table
      wording ("Lebanese public account") and the client cheat sheet, with no leaked
      `[[CHEAT_SHEET_BLOCK]]` marker, and none of the old "Lebanese X (Twitter) account"
      wording. Staging replies were stored and one staging alert was sent, as on any manual pass.
  - The drift auditor compared live with the export: in sync, 62 nodes.

- **Re-exported three PRODUCTION workflows from live n8n, 2026-10-16** (read-only
  `get_workflow_details`; nothing in n8n was changed). Each export had fallen behind the latest
  saved version, and all three now match it node for node and edge for edge. The one exception
  is the SMMWiz `apiKey` in the router, which stays `REDACTED_SMM_API_KEY_MOVE_TO_N8N_CREDENTIAL`
  as it has been since 2026-10-03.
  - **XMonitor - Telegram Router** `cWczsttyDbTBbRAC`: export `e707cbed` (2026-08-29, 127
    nodes) → live `92d6b099` (2026-10-03 10:08 UTC, 155 nodes, published). The gap covers T5
    (2026-08-30, six MCP versions `1b8658b0`…`3057a599`: client-scoped `/track`, staff
    `/clients` / `/client_new` / `/client_attach`, `client_id` through `/auth_x` and onto
    `Moderation Queue`), then `9c8b0bae` (all ten Postgres nodes on one credential). It also
    covers **hide replies by percentage, promoted to production 2026-10-03 by tarek ismail via
    MCP** from staging `d4b403b4`, without the staging SMM credential change. That promotion
    also put the switch fallback on `Send Default Help`. n8n's diff `9c8b0bae` → `92d6b099`
    shows it carried more than its "hide-percentage change only" description. It also reworked
    the post-status path: `Prepare Post Status Change`; `Update Post Status`, now a Postgres
    query; `If Status Origin Is Callback`; `If Edit Resume Button`; `Edit Status Alert` and
    `Edit Status Alert With Resume`. It changed `Clear Telegram User Links` (`filterType`
    dropped) and `Resolve Caller Authorization` (`onError: stopWorkflow` dropped, which is the
    default). Four of those nodes are the ones the todolist had flagged as an unpublished
    production draft. See `docs/workflows/xmonitor-telegram-router.md`.
  - **XMonitor - X OAuth Callback** `JQ9KM3l1kRJQhWxb`: export `5685e01f` (2026-07-07, 16
    nodes) → live `08616485` (2026-10-14 23:06 UTC, 21 nodes, published). It gained T5's
    `Stamp Auth Account Client` (2026-08-30). It gained `Console authorization?` plus a username
    check in `Prepare Account Row` for `console.<username>.<nonce>` states ("Support
    account-bound Jess Console OAuth sessions", tarek ismail via MCP, 2026-09-16). Two **n8n
    editor saves** by tarek ismail on 2026-10-14 then added a `PolyJess callback?` branch. It
    sends `polyjess.<43 chars>` states to the `jess-workspace-gateway/oauth/polyjess` edge
    function on Supabase project `npytqidroqxgikaqofmq` (XMonitor Staging) and relays that
    function's response (`71562351`). The second save raised that call's timeout from 20 s to
    60 s (`08616485`). See the doc's "PolyJess Forwarding" section.
  - **XMonitor - Moderation Queue Drain** `vm4UNW7OIx2zEGb4`: the export now carries
    `versionId` `b25fd601`, an **unpublished n8n editor autosave** by tarek ismail
    (2026-09-02 22:13 UTC). Production still runs `f19a65a0` (2026-08-27), which the export
    keeps under `activeVersion`. The autosave changes no nodes or wiring: it moves 32 nodes on
    the canvas, adds `binaryMode: separate`, and drops three parameters. Two of them equal
    their defaults (`resource: message`, `responseMode: onReceived`). The third is
    `appendAttribution: false` on an `editMessageText` node, which does not offer that option.
    See the drain doc.
  - `workflows/manifest.json` `updatedAt` refreshed for all three.

- **Scheduled Post Tracking — per-reply sentiment classification. Published to PRODUCTION
  2026-10-10** (`Emb26wP77eFXgnVi`, `activeVersionId` `8669273d-0fac-44cf-8e35-053df306a956`,
  confirmed equal to `versionId` by re-read) after validation on **STAGING** the same day
  (`l4eKZucUZXzfz0H8`, draft `1a3baa1f-b081-47d8-a04c-ab09837f6a5c`; inactive by design,
  manual execution only, so no publish step there). The production edit was generated from
  the staging graph with production credentials (`Supabase Account`, `OpenAi account 2`),
  asserted node-for-node equal to staging on re-read, simulated with four pinned fixtures
  against the production draft (`44801`–`44804`, all green), then published. Production
  also gained `Get Active Cheat Sheets` (read-only, `Build Analysis Plan` depends on it);
  reply media sentiment stays staging-only. Export `workflows/active/...` re-synced from
  the published version.
  Replaces `Build Analyzer Batches` + `Analyze Sentiment with ChatGPT` (one OpenAI call per
  client carrying every post and reply, parsed back from a `{"results":[...]}` blob) with the
  shape IG - Monitor uses: `Build Analysis Plan` (one item per new reply with a
  `classifier_input` of owner + post text + reply) → `Classify Sentiment` (Sentiment Analysis
  node, `gpt-5.4-mini` at temperature 0 via `OpenAI Sentiment Model`, IG's prompt adapted to X
  posts/replies with the per-client cheat sheet injected, auto-fixing, batches of 5, retry ×3,
  error output) → `Tag Positive` / `Tag Neutral` / `Tag Negative` / `Tag Failed` →
  `Merge Sentiment Results` → `Collect Sentiment Labels`, which regroups the labels by post
  so counts, thresholds, alerts, upserts and the watermark are untouched downstream.
  - A reply that fails classification is not stored and not counted; `If Any Classification
    Failed` sends the existing probe → `Build Sentiment Failure Alert` path (now with
    planned/classified/failed counts), and `If Safe To Advance Watermark (Analyzed)` holds
    the watermark on `classification_failed_count > 0` so the reply is re-scored next pass.
  - `Get Replies` requests `author_id`; `Attach replies to posts` carries it so a reply by the
    account owner is marked in the prompt. `Build Media Classify Requests` only classifies
    images on replies that got a text label. `Apply Media Sentiment` reads
    `Collect Sentiment Labels`.
  - Validation: all 21 pinned fixtures green (`44761`–`44784`; 12 converted to the
    `Classify Sentiment` + `Merge Sentiment Results` pins, new
    `watermark-classification-failed-holds`). Live `44787`: 104 real replies, 0 failures,
    persisted, ratio 0.806, alert delivered, everything restored. Old-vs-new agreement 77/104.
  - Cost: about 1,030 tokens per reply versus about 180 batched (one call per reply instead
    of one per client); roughly $0.00085 vs $0.00025 per reply at list price.
  - Export re-synced from live (it had drifted: `Build Post Metrics Refresh` /
    `Refresh Post Metrics` and three parameter diffs were live-only). `workflows/manifest.json`
    updated. Tests: `reply-sentiment-persistence.test.mjs` and `t3-alert-routing*.test.mjs`
    made aware of the staging/production shape split.
  - Promotion to production is pending and needs the staging-only nodes production also
    lacks (media sentiment, cheat sheets), production credentials and error workflow, and a
    publish; see the staging doc's "Not yet done".
