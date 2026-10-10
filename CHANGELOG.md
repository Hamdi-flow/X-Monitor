# Changelog — X-Monitor

[workflows/manifest.json](workflows/manifest.json) is the index of workflows and exports;
[docs/workflows/](docs/workflows/) holds the per-workflow reference. Entries are newest-first
and name the workflow and environment they apply to. Mirrors the format of the sibling
FB Monitor and Insta-Monitor changelogs.

---

## [Unreleased]

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
