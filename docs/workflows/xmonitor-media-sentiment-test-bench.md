# XMonitor - Media Sentiment Test Bench

## Purpose

Read-only bench for validating **Option A** (describe-then-label) for reply media sentiment
before any change reaches the staging scheduler. It probes real production conversations for
reply media via X API expansions, describes each image with a vision call, then runs sentiment
**twice** — text-only baseline vs text + `mediaDescription` — and diffs the labels.

It exists because the scheduler cannot see media at all today: `Get Replies` requests only
`tweet.fields=created_at,conversation_id`, so an image-only reply reaches the model as an empty
string and is labelled Neutral.

## Identity

- n8n ID: `f1qYeYS5i8pvvKxH`
- Environment: test bench (neither staging nor production)
- Active: no, manual trigger only
- Local export: not yet exported - the bench will change again after a full passing run
- Credentials: `Bearer Auth account` (X), `OpenAi account 2` (vision + sentiment)

## Safety

No side effects by construction. There is **no** Supabase node, **no** Telegram node, and **no**
X write. The only external calls are X `search/all` reads and OpenAI completions.

## Flow

| Node | Role |
| --- | --- |
| `Start Test Bench` | Manual trigger. |
| `Build Probe Queries` | Emits one probe per conversation per mode: 5 `rate` probes (all replies, for an honest media rate) and 5 `media` probes (`has:media`, to guarantee vision samples). |
| `Fetch Replies With Media` | X `search/all` with `expansions=attachments.media_keys` and `media.fields`. Throttled to 1 request / 3s. |
| `Extract Reply Media` | Joins `includes.media` to replies by `media_key`; records `unresolved_media_keys` as an integrity check. |
| `Select Media To Describe` | Dedupes by `media_key`, caps at 12, picks `url` for photos and `preview_image_url` for video/GIF. |
| `Describe Media` | OpenAI `image:analyze`, `detail: low`. `onError: continueRegularOutput` so a failure degrades instead of dropping replies. |
| `Build Sentiment Payloads` | Builds `baselineText` and `enrichedText` in the scheduler's exact `{results:[{postId,postText,userId,replies:[]}]}` shape. Enriched replies gain `mediaDescription`. |
| `Analyze Sentiment Baseline` / `Analyze Sentiment With Media` | Same prompt; the enriched one adds a MEDIA HANDLING block. Both `json_object`. |
| `Merge Sentiment Runs` -> `Validation Report` | Diffs labels and emits T1-T8 PASS/FAIL checks. |

## Validation Checks

| Check | Meaning |
| --- | --- |
| T1 | Media expansion actually returns media. |
| T2 | Every declared `media_key` resolves from `includes` (no dangling keys). |
| T3 | Vision can describe `pbs.twimg.com` URLs directly. |
| T4 | Descriptions reach the sentiment payload. |
| T5 / T6 | Both sentiment responses parse as the expected JSON. |
| T7 | Enrichment drops no reply. |
| T8 | Text-only control replies keep their baseline label (no regression). |

## Findings

Six runs on 2026-08-24. Executions `14481` (X path only), `14490`, `14502`, `14508`, `14521`.

### Mechanically validated - T1 to T7 PASS, stable across three A/B runs

- **T1** `includes.media[]` populates and replies carry `attachments.media_keys`.
- **T2** Every declared `media_key` resolves. `unresolved_media_keys = 0` in every run.
- **T3** Vision described 13/13 media straight from `pbs.twimg.com` URLs - no download, no
  base64, no binary handling. Includes one **video**, described from `preview_image_url`.
- **T4** Descriptions reached the payload: 12 replies enriched.
- **T5/T6/T7** Both sentiment passes parsed; 52 labels in, 52 out, nothing dropped.
- **Graceful degradation** (execution `14481`, vision hard-failing): `replies_enriched` fell to
  0 and both payloads still carried every reply. A vision outage degrades to text-only.

### Media rate: 6.2% (12 of 195 replies, 5 conversations)

Per conversation: 3.0%, 11.6%, 5.6%, 6.7%, 10.0%. All photos plus one video. **Zero**
`alt_text` on any media across the whole sample - the free alt-text signal does not exist here.

Only 5 of 22 probed conversations returned replies at all; the rest returned
`result_count: 0`. The 6.2% is a sample, not a census.

### Accuracy: NOT validated

Across three A/B runs the flip set was **unstable**: 4, then 5, then 3 flips on the same 12
media replies. Two distinct defects were found and one was fixed.

**Fixed - vision judging tone was unstable and could corrupt correct labels.** The original
vision prompt asked whether the image "reads as mocking or supportive". That verdict was
non-deterministic (the same thumbs-up meme was called "supportive/praising" in run 4 and
"mocking/insulting" in run 5, inverting the label) and the classifier deferred to it - in run 5
a correctly-Negative reply (`القرف في صورة`, insulting text + a plain portrait) was **downgraded
to Neutral** because the description said the photo looked harmless. Fixing this took two
changes, both validated in run 6:

1. Vision now transcribes and describes **literally**, with no tone judgement.
2. The sentiment prompt treats media as **additive evidence only** - it may never downgrade a
   label the reply text alone justifies.

Run 6 descriptions are factual and stable, and the false-negative regression is gone.

**Not fixed - target attribution.** Of the 3 flips remaining in run 6, only **1 is correct**:

| Reply | Flip | Correct? |
| --- | --- | --- |
| `2091108649414340893` - bare mention + `دير الصليب` psychiatric-hospital joke + crude cartoon | Neutral -> Negative | **Yes.** Genuine image-only insult; exactly the gap media analysis exists to close. |
| `2091230438429765923` - `Kelmtayn ya helo ma fi 8ayron` (praises the author) + meme mocking Gebran Bassil | Neutral -> Negative | **No.** The meme attacks the third party the post itself criticises. |
| `2091229660768096706` - bare mention + meme reading `ما بيحكي بالسوء عنك الا يلي رح يموت قهر منك` | Neutral -> Negative | **No.** The meme is supportive of the author. Run 4 labelled it Positive. |

An explicit attribution rule in the prompt did **not** fix this. When a reply is a bare mention
plus an image, the classifier cannot reliably tell whether a Lebanese political meme targets the
author or the author's opponent - and OCR of colloquial Lebanese is imperfect
(`جبران` transcribed as `حيران`), which makes it harder.

### Noise floor: 2 to 8%

`T8` fails in every run: 2, then 1, then 3 of 40 text-only control replies changed label between
the two passes on **identical** input, even with `temperature: 0`. Any media effect smaller than
roughly 8% is indistinguishable from model non-determinism at this sample size. Production runs
without a pinned temperature, so it carries this churn today.

## Verdict

**Superseded by the [Media Sentiment Accuracy Benchmark](./xmonitor-media-sentiment-accuracy-benchmark.md).**

This bench proved the plumbing and surfaced the two real defects, but it can only show that a
label *changed*, never that it changed *correctly*. The "roughly 1-in-3 flip precision" recorded
here was eyeballed, and was measured with the pre-fix prompts. Once the vision prompt was reduced
to literal description and the classifier was told media is additive-only, the benchmark scored
**100% on 8 hand-labelled cases** across baseline, frozen and live passes.

Read this document for the mechanics and the failure modes. Read the benchmark for the numbers.

## Known Bench Limitations

- 44 X requests per run at 1 per 3s; a run takes about 3.5 minutes.
- Conversation IDs and post texts are hard-coded in `Build Probe Queries` from production
  `Posts`. Refresh them when the sample goes stale.
- `T8` is written as "zero control changes", which the model can never satisfy. Interpret it as
  a noise-floor reading, not a pass/fail gate.

## Unrelated Production Bug Found

The scheduler's reply query joins conversations with ` OR ` and one `max_results`. Execution
`14481` showed X returning **all 99 replies from a single conversation**, ordered by recency,
with `next_token` indicating more pages. Production joins up to ~20 conversations this way, so
**a single busy post can silently starve every other tracked post of reply coverage**. This is
independent of media and is not fixed here.
