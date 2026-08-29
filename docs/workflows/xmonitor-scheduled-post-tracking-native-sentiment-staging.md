# XMonitor - Scheduled Post Tracking Native Sentiment Staging

## Purpose

Inactive staging variant of scheduled post tracking for per-reply sentiment experiments. It keeps the deduplicated per-reply analysis path, but the broken native LangChain sentiment parser was replaced on 2026-07-05 with n8n's OpenAI JSON-mode node plus a small metadata adapter so the path returns parseable labels before prompt tuning begins.

## Identity

- n8n ID: `f2eFqB2wO91HAYMJ`
- Environment: staging
- Active: no
- MCP availability: no, based on current workflow card settings
- Local export: `workflows/staging/xmonitor-scheduled-post-tracking-native-sentiment-staging.json`
- Last observed export update: `2026-07-05T13:30:12.682Z`

## Important Variables

| Variable | Location | Current value | Meaning |
| --- | --- | --- | --- |
| Schedule cadence | `Schedule Trigger` | every `30` minutes | More frequent than the standard scheduler copies. |
| Lookback window | `Build X API Query`, `DAYS_AGO` | `7` days | X search start time. |
| Minimum replies | `Keep Posts With 10+ Replies` | `>= 10` | Minimum reply count before analysis. |
| Negative threshold | `Calculate/Filter Sentiment Counts` | `negative_ratio >= 0.5` | Minimum negative reply ratio for alerts. |
| Sentiment engine | `Analyze Reply Sentiment` | `@n8n/n8n-nodes-langchain.openAi` JSON mode | Replaces the native sentiment parser that failed on LLM output parsing. |
| Sentiment labels | `Analyze Reply Sentiment`, `Attach Sentiment Metadata` | `Positive`, `Neutral`, `Negative` | Labels accepted by downstream counting. |
| Sentiment model | `Analyze Reply Sentiment` | `gpt-4o-mini` | Model used by the JSON-mode OpenAI node. |
| Analysis retries | `Analyze Reply Sentiment` | `retryOnFail=true`, `maxTries=6`, `waitBetweenTries=60000` | Adds an artificial 60-second backoff between retry attempts for OpenAI throttling. |

## Main Differences From Standard Staging Scheduler

- `Build Deduplicated Reply Items` deduplicates replies by normalized text before analysis, then expands duplicate groups back into per-reply results.
- `Analyze Reply Sentiment` uses n8n's OpenAI node in JSON mode and returns a single sentiment label per representative reply.
- `Attach Sentiment Metadata` parses the JSON-mode output, restores the original reply/post metadata from `Build Deduplicated Reply Items`, normalizes the label into `sentimentAnalysis.category`, and preserves the downstream shape.
- `Calculate/Filter Sentiment Counts` still reads `sentimentAnalysis.category` and expands duplicated replies into the final counts.
- It still writes to `Posts` and `Replies`, sends Telegram alerts, and uses the same alert callback payloads as the standard scheduler.

## Agent Change Guidance

- Use this workflow when testing sentiment quality, duplicate handling, JSON parsing stability, or per-reply analysis behavior.
- Use [the synthetic native sentiment accuracy benchmark](./xmonitor-scheduled-post-tracking-native-sentiment-accuracy.md) to measure the live sentiment analysis path against hand-labeled examples without calling X, Telegram, Supabase, or production workflows.
- MCP is currently disabled for this workflow, so local export inspection, REST, or temporary MCP-enabled benchmark workflows may be needed unless MCP access is enabled in n8n.
- If this variant becomes the preferred scheduler, update the standard scheduler docs and staging/production exports together.
- Because it can still call X/OpenAI, write staging data, and send Telegram messages, use pinned tests for safe validation.
