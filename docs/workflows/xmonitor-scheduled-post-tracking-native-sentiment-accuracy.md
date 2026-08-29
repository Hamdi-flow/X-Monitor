# XMonitor - Native Sentiment Accuracy Benchmark

## Purpose

Synthetic benchmark for the staging native sentiment tracker. It uses hand-labeled examples covering English, Arabic, Lebanese Arabic, Arabizi, French, code-switching, sarcasm, insults, praise, questions, factual comments, and mixed or ambiguous replies.

## Benchmark Files

- Cases: `tests/n8n/native-sentiment-accuracy-cases.json`
- Runner: `tests/n8n/native-sentiment-accuracy.integration.test.mjs`

## Method

The runner reads the live `XMonitor - Scheduled Post Tracking Native Sentiment Staging` workflow (`f2eFqB2wO91HAYMJ`), copies the current sentiment analysis settings into a temporary MCP-enabled workflow, runs the labeled examples through the selected sentiment engine, scores the predictions, prints the confusion matrix, and deletes the temporary workflow.

The benchmark does not call X, Telegram, SMM, Supabase, or the production scheduler. It does call the configured OpenAI model through n8n, so each run may consume OpenAI API quota.

Run from the repository root:

```powershell
node tests/n8n/native-sentiment-accuracy.integration.test.mjs
```

To test the minimal parser-compatible prompt candidate in the temporary benchmark workflow only:

```powershell
node tests/n8n/native-sentiment-accuracy.integration.test.mjs --prompt-variant=parser-compatible
```

To also test native-node output auto-fixing in the temporary benchmark workflow only:

```powershell
node tests/n8n/native-sentiment-accuracy.integration.test.mjs --prompt-variant=parser-compatible --enable-auto-fixing
```

Useful probe flags:

- `--engine=openai-json` uses the fixed JSON-mode OpenAI path.
- `--pin-analysis-output` pins the analysis node to the expected labels, proving the graph and adapter without calling OpenAI.
- `--delay-before-run-ms=<ms>` waits before starting the temporary benchmark workflow, useful after a rate-limit response.
- `--retry-tries=<n>` and `--retry-wait-ms=<ms>` override the temporary benchmark analysis-node retry settings.
- `--execution-timeout-ms=<ms>` allows long-running retry/backoff validation to complete.
- `--case-id=<id>` restricts the run to one or more comma-separated benchmark case IDs.
- `--max-cases=<n>` restricts the run to the first `n` cases.
- `--model=<model>` overrides the model in the temporary workflow only.

## Current Synthetic Set

- Total cases: `36`
- Expected labels: `12` Positive, `12` Neutral, `12` Negative
- Alert-risk emphasis: the highest-risk mistakes are false negatives for hostile replies and false positives for factual or mixed replies, because the tracker alerts when at least half of analyzed replies are labeled negative.

## Latest Result

Accuracy score: still pending a non-throttled live OpenAI run. The parser error is fixed in the staging workflow path; the remaining live probe blocker on 2026-07-05 was OpenAI rate limiting.

The staging workflow now uses artificial retry backoff on the OpenAI JSON-mode node: `retryOnFail=true`, `maxTries=6`, `waitBetweenTries=60000`. The benchmark runner uses the same defaults and can add a pre-run delay with `--delay-before-run-ms`.

| Execution | Cases | Variant | Result |
| --- | --- | --- | --- |
| `3708` | all 36 | current live settings, `gpt-4o-mini` | Failed before scoring: `Error during parsing of LLM output` |
| `3709` | all 36 | parser-compatible prompt, `gpt-4o-mini` | Failed before scoring: same parser error |
| `3710` | all 36 | parser-compatible prompt + auto-fixing, `gpt-4o-mini` | Failed before scoring: same parser error |
| `3711` | `neg-en-direct-insult` | current live settings, `gpt-4o-mini` | Failed before scoring: same parser error |
| `3712` | `neg-en-direct-insult` | parser-compatible prompt + auto-fixing, `gpt-4o-mini` | Failed before scoring: same parser error |
| `3713` | `neg-en-direct-insult` | current prompt, model override `gpt-4o` | Failed before scoring: same parser error |
| `3714` | `neg-en-direct-insult` | parser-compatible prompt + auto-fixing, model override `gpt-4o` | Failed before scoring: same parser error |
| `3719` | `neg-en-direct-insult` | native node, current prompt, max tokens `500` | Failed before scoring: same parser error |
| `3721` | `neg-en-direct-insult` | native node, lower-case categories | Failed before scoring: same parser error |
| `3722` | `neg-en-direct-insult` | native node, OpenAI Responses API enabled | Failed before scoring: same parser error |
| `3723`-`3725` | `neg-en-direct-insult` | JSON-mode OpenAI candidate | Reached OpenAI node but failed with provider rate limit: `The service is receiving too many requests from you` |
| `3726`, `3728` | all 36 | JSON-mode OpenAI path with `Analyze Reply Sentiment` pinned to expected labels | Passed graph/adapter validation: `36/36`, `100%`, no mismatches |
| `3727` | `neg-en-direct-insult` | fixed JSON-mode OpenAI path with live OpenAI call | Reached OpenAI node but failed with provider rate limit |
| `3730` | `neg-en-direct-insult` | fixed JSON-mode OpenAI path, 60-second pre-run delay, default `gpt-4o-mini` | Failed with provider rate limit |
| `3733` | `neg-en-direct-insult` | fixed JSON-mode OpenAI path, 5-minute pre-run delay, default `gpt-4o-mini` | Failed with provider rate limit |
| `3734` | `neg-en-direct-insult` | fixed JSON-mode OpenAI path, model override `gpt-4.1-mini` | Failed with provider rate limit |

Cleanup checks after these runs, including after latest pinned execution `3728`, found `0` temporary benchmark workflows remaining in n8n.

Conclusion: the old native sentiment node path was blocked at output parsing, not at classification quality. The staging workflow now bypasses that parser with JSON-mode OpenAI output and an adapter that restores `sentimentAnalysis.category`. Artificial timing/backoff is in place, but live probes still fail at the OpenAI credential/project level even for one request after a five-minute wait. Prompt-quality work should wait until a different OpenAI credential/project is configured or the current account's rate/quota limit recovers.
