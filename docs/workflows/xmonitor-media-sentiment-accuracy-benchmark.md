# XMonitor - Media Sentiment Accuracy Benchmark

## Purpose

Scores candidate reply-media sentiment architectures against **hand-labelled cases** instead of
eyeballed diffs, and measures how **reproducible** each one is. It exists because the exploratory
[Media Sentiment Test Bench](./xmonitor-media-sentiment-test-bench.md) could show that labels
*changed* when media was added, but not whether they changed *correctly* or *repeatably*.

It now compares two architectures head to head: **Option A** (describe the image, then classify
the description) and **Option C** (send the image straight to the classifier with the reply).

## Identity

- n8n ID: `F7VkkER6k85DGkmG`
- Environment: test bench (neither staging nor production)
- Active: no, manual trigger only
- Case set: `tests/n8n/media-sentiment-accuracy-cases.json`
- Credentials: `OpenAi account 2` only. **No X calls, no Supabase, no Telegram.**

## Case Set

12 cases, all **real** replies harvested from production conversations - real Lebanese political
discourse rather than synthetic examples. Each case carries `expectedLabel`,
`expectedBaselineLabel` (what text-only *should* return), a `phenomenon` tag, and a `rationale`.

All **12 are scored** (`labelConfidence: high`). Four began as REVIEW cases and were adjudicated
on 2026-08-24 by viewing the images:

- Both Bassil memes are **pro-Bassil**, so they dismiss the post author who had just criticised
  him. Negative. An earlier reading that one of them mocked Bassil, and the other supported the
  author, was wrong on both counts.
- The Beirut-port screenshot targets **Joseph Aoun**, not the post author, so it must stay
  Neutral. This is the one case the classifier still gets wrong.
- The quoted-tweet reply is already Negative on its text alone; media changes nothing.

Two are **lift** cases (text-only Neutral, media makes them Negative); ten are **harm** cases
where media must not change the answer.

`expectedBaselineLabel` is what makes the benchmark meaningful: it separates cases where media
*should* change the label (**lift**) from cases where it must *not* (**harm**).

> The JSON file is the human-editable source of truth. The workflow embeds a copy in
> `Load Benchmark Cases`. **Change one, change the other**, or the two will drift.

## Four Passes

The bench proved the failure modes live in different layers, so the benchmark measures them
separately:

| Pass | Architecture | What it isolates |
| --- | --- | --- |
| **Baseline** | text only | Confirms `expectedBaselineLabel` is right and gives the "without media" reference. |
| **Frozen** | fixed descriptions, run **3x** | Deterministic input, so any variation is classifier non-determinism, not vision noise. |
| **Live** | Option A, end to end | Fresh vision on the real `pbs.twimg.com` URLs, then one batched classify. Includes description drift. |
| **Hybrid** | Option C, run **3x** | Skips the description step. One multimodal call per media reply carrying the post text, the reply text, and the images themselves. |

The hybrid request body is built in a Code node rather than by the OpenAI node, because a reply
may carry one or two images and the node's message collection is fixed at design time. It posts
to `chat/completions` with `predefinedCredentialType`, the same pattern the production scheduler
uses for its OpenAI probe.

## Checks

| Check | Meaning |
| --- | --- |
| B0 | All three passes produced parseable labels (guards the silent all-empty failure below). |
| B1 | Baseline reproduces the expected text-only labels. |
| B2 | **Flagship** - the image-only `دير الصليب` insult flips Neutral to Negative. |
| B3 | Media never downgrades a correct Negative. |
| B4 | A video thumbnail with no legible text does not invent a label. |
| B5 | Frozen classifier is deterministic across its 3 repeats. |
| B6 | Live is no worse than frozen. |
| B7 | **Hybrid is deterministic across its 3 repeats.** |
| B8 | Hybrid is no worse than live. |

B2, B3 and B4 read the **hybrid** column, since that is now the candidate architecture.

## Results - 2026-08-24, executions 14532 / 14545 / 14548 / 14550

All 12 cases are scored; no REVIEW cases remain. The headline finding is not an accuracy
number, it is **where the variance lives**.

| Pass | 14545 | 14548 | 14550 |
| --- | --- | --- | --- |
| Baseline (text only) | 91.7% | **100%** | **100%** |
| Frozen (fixed descriptions) | 66.7% | **91.7%** | **91.7%** |
| Live (fresh vision each run) | **100%** | 75% | 75% |

### The classifier is steady. The vision step is not.

With faithful descriptions the classifier holds at **91.7%** across runs, with one known
failure (`media-only-counterargument-screenshot`). B1-B4 pass: the flagship lift works, media
never downgrades a correct Negative, and the video thumbnail never invents a label.

The **live** pass, on identical inputs, swings **75-100%** and fails a *different set of cases
each time*:

- `14545` - no failures.
- `14548` - both Bassil memes to Positive, plus the counter-argument screenshot.
- `14550` - both Bassil memes to Positive, plus **the flagship** to Neutral.

Nothing changes between these runs except the freshly generated descriptions. That is the
measurement the frozen/live split exists to produce: **the description step, not the
classifier, is the dominant source of error.**

### Three vision prompts were tried; none stabilised it

1. **Judge tone** ("does it read as mocking or supportive") - unstable and actively harmful: the
   same meme was called supportive in one run and mocking in the next, and a harmless-photo
   description downgraded a correctly-Negative reply to Neutral.
2. **Describe only, judge nothing** - fixed the downgrade, but suppressed naming the person
   shown, so the classifier could not attribute the jab. Both Bassil memes read as encouragement.
3. **Describe and name public figures, judge nothing** - did not recover them either, and the
   flagship regressed instead.

Prompt engineering at this layer has not converged in three attempts.

### The frozen descriptions must come from real output

Execution `14532` scored frozen at 66.7% against live at 100%. The cause was not the
classifier: the `frozenDescription` values were hand-typed paraphrases that flattened the
transcribed Arabic - `صااااار يسعبل الجميع!!!` became `صار بيساوي الجميع`, which reads like an
ordinary public-service advert. **Frozen descriptions must be copied verbatim from a live run**,
or the frozen pass grades the transcription rather than the classifier. Refreshing them moved
frozen from 66.7% to 91.7%.

## Option C beats Option A - executions 14567 and 14571

The hybrid pass was added to test whether removing the description step removes the variance.
It does.

| Pass | 14567 | 14571 | Rows identical across the two runs? |
| --- | --- | --- | --- |
| Baseline | 100% | 91.7% | no |
| Frozen | 100% | 100% | no - the Aoun case wobbles |
| Live (Option A) | 100% | **75%** | **no - three cases flipped to Positive** |
| **Hybrid (Option C)** | **91.7%** | **91.7%** | **yes - every row identical** |

**Hybrid is the only reproducible pass.** 72 multimodal calls across the two executions returned
the same label for every case, every time: `B7 PASS`, all 12 cases stable 3/3, in both runs. Live
lost the flagship *and* both Bassil memes in 14571; hybrid caught all three in both runs.

- Hybrid Negative precision **90.9%**, recall **100%** (10 TP, 1 FP, 0 FN).
- Both **lift** cases captured, including the flagship.
- One **harm** case broken, the same one every time.

### The one remaining defect

`media-only-counterargument-screenshot` - the Beirut-port screenshot targeting Joseph Aoun -
is labelled Negative when it should be Neutral. Hybrid gets this wrong **consistently**
(3/3 in both runs). That is a far better failure mode than live's: a stable, characterised
false positive on the hardest attribution case can be prompted against or simply accepted and
measured, whereas a label that changes between hourly passes cannot.

## Verdict

**Option C is the architecture to take to staging. Option A should not be promoted.**

Removing the description step removed both the information loss and the variance, exactly as
predicted. The remaining error is bounded, reproducible, and known.

Cost is not the objection it appeared to be: at a **6.2% media rate** only about one reply in
sixteen needs a multimodal call, and the observed prompt cost is ~1,450 tokens per call with two
low-detail images attached. The three repeats exist only for the benchmark; production would
make one call per media reply.

Before staging:

1. Try one attribution-focused iteration on the hybrid prompt for the Aoun case, re-running the
   benchmark to confirm nothing else regresses. Skip it if a stable false positive on
   third-party political screenshots is acceptable.
2. Grow the case set - two lift cases and one video is thin, and every post comes from three
   accounts.
3. Cache by `media_key` regardless, so a reply analysed once keeps its label.

The benchmark is the reason any of this is knowable. Six ad-hoc bench runs did not surface the
variance; the scored runs did, and then measured the fix.
## How To Read This Honestly

The variance finding is solid - it reproduced across three runs and is the kind of result a
small sample *can* establish, because it compares a pipeline against itself. The **accuracy
percentages are not**:

- **n = 12.** One case moves any figure by 8.3 points, so treat 91.7% and 75% as "roughly nine
  in twelve" and "roughly three in four", not as precise rates.
- **Only 2 lift cases.** The entire measured *benefit* of the feature rests on two examples.
  More image-only insults are by far the highest-value cases to add.
- **One video, no GIF.** The video limit is asserted on a single thumbnail.
- **Mild overfitting risk.** The prompts were tuned against the same discourse these cases were
  drawn from, and all five posts come from three accounts.

## Agent Change Guidance

- Grow the case set before trusting the percentages - especially **lift** cases (image-only
  insults) and any video or GIF beyond the single thumbnail case.
- Keep the JSON file and the embedded copy in `Load Benchmark Cases` in sync.
- **Never hand-write a `frozenDescription`.** Copy it verbatim from a live run, or the frozen
  pass grades the transcription instead of the classifier - see the 66.7% result above.
- Run the live pass **at least twice** before believing any live number. A single live run has
  produced anything from 75% to 100% on this same set.
- When the classifier or vision prompt changes anywhere, re-run this before the exploratory bench
  - it is cheaper (no X calls, about 60 seconds) and gives a number instead of a diff.

## Known Trap

With `json_object` output, n8n delivers `content[0].text` as an **already-parsed object**, not a
string. The first run of this benchmark returned empty labels for all 12 cases and scored 0%
across the board while every node reported success. `B0` exists so that failure can never again
be mistaken for a real result.
