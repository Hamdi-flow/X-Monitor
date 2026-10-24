#!/usr/bin/env bash
# Run the scheduled-tracking pinned fixtures against the staging workflow.
#
#   ./run-pins.sh                     # run every fixture
#   ./run-pins.sh ratio-from-stored   # run fixtures whose name matches a substring
#   ./run-pins.sh watermark           # run just the watermark fixtures
#
# Talks to the n8n MCP endpoint over HTTP using N8N_MCP_URL / N8N_MCP_ACCESS_TOKEN
# from keys.env, because this machine has no node/python/jq to drive a richer client.
#
# Most fixtures pin the trigger, all credentialed nodes and all HTTP nodes, so a run
# touches no live X, OpenAI, Supabase or Telegram surface.
#
# The `watermark-*` fixtures are the deliberate exception. They leave the two watermark
# writers UNPINNED, because the whole question is whether the UPDATE runs at all —
# pinning them is precisely why the 2026-08-25 defect survived staging validation. They
# therefore write `Run State` for real. This script snapshots that row before each such
# fixture, asserts the resulting value, and restores it afterwards, using the Supabase
# management API with SUPABASE_ACCESS_TOKEN from keys.env.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
ENV_FILE="$ROOT/keys.env"
WORKFLOW_ID="${XMONITOR_WORKFLOW_ID:-l4eKZucUZXzfz0H8}"   # override to run against production Emb26wP77eFXgnVi

# Supabase project holding Run State for the workflow above.
if [ "$WORKFLOW_ID" = "Emb26wP77eFXgnVi" ]; then
  SUPABASE_REF="${XMONITOR_SUPABASE_REF:-jxnzdxyhoakpfmkbjdeq}"   # production
else
  SUPABASE_REF="${XMONITOR_SUPABASE_REF:-npytqidroqxgikaqofmq}"   # staging
fi

[ -f "$ENV_FILE" ] || { echo "keys.env not found at $ENV_FILE" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
: "${N8N_MCP_URL:?N8N_MCP_URL missing}"; : "${N8N_MCP_ACCESS_TOKEN:?N8N_MCP_ACCESS_TOKEN missing}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mcp() { # mcp <tool> <json-args-file>
  local tool="$1" argfile="$2"
  { printf '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"%s","arguments":' "$tool"
    cat "$argfile"
    printf '}}'
  } > "$TMP/req.json"
  curl -s -X POST "$N8N_MCP_URL" \
    -H "Authorization: Bearer $N8N_MCP_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    --data-binary "@$TMP/req.json" | sed 's/^data: //' | grep -v '^event:' | grep -v '^$'
}

sql() { # sql <statement, already escaped for a JSON string literal>
  [ -n "${SUPABASE_ACCESS_TOKEN:-}" ] || { echo "SUPABASE_ACCESS_TOKEN missing" >&2; return 1; }
  printf '{"query":"%s"}' "$1" > "$TMP/sql.json"
  curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary "@$TMP/sql.json"
}

# The backslash-quote below is literal: that is how the double quotes around the
# "Run State" identifier survive into the JSON request body.
RS_TABLE='public.\"Run State\"'
RS_KEY="where key = 'scheduled_post_tracking';"

read_watermark() {
  sql "select last_successful_run_at from $RS_TABLE $RS_KEY" \
    | grep -oE '"last_successful_run_at":(null|"[^"]*")' | cut -d: -f2-
}

restore_watermark() { # restore_watermark <value as printed by read_watermark>
  local v="$1" expr
  if [ "$v" = "null" ]; then
    expr="null"
  else
    expr="'$(printf '%s' "$v" | tr -d '"')'::timestamptz"
  fi
  sql "update $RS_TABLE set last_successful_run_at = $expr $RS_KEY" > /dev/null
}

# Expected signals per fixture: "<label>|<regex that must appear in execution data>"
expectations() {
  case "$1" in
    chunking-25-conversations)
      echo 'chunk_count is 2|"chunk_count":2'
      echo 'first chunk holds 15|"conversation_count":15'
      echo 'second chunk holds 10|"conversation_count":10'
      echo 'no new replies, OpenAI skipped|"has_new_replies":false'
      ;;
    quiet-pass-no-new-replies)
      echo 'no new replies|"new_reply_count":0'
      echo 'ends on the quiet-pass watermark|Advance Run State \(Quiet Pass\)'
      ;;
    no-post-crosses-threshold)
      echo 'both replies stored|"reply_id":"7002"'
      echo 'ratio stays below the alert gate|"alert_now":false'
      echo 'ratio is stored plus new|"negative_ratio":0.1'
      ;;
    backfill-new-post-full-window)
      # A post is invisible to the reply fetcher until its X reply_count crosses
      # min_replies. By then every reply it already has is older than the watermark
      # window, so searching from the watermark skips them and never asks again.
      # This post was created at 10:00 and the watermark is 14:00, so the window
      # must start from the post itself, not from 13:50.
      echo 'first-time post takes the backfill window|"is_backfill":true'
      echo 'window starts at the post, not the watermark|"start_time":"2026-08-24T09:59:00.000Z"'
      echo 'all four replies are new, three of them pre-watermark|"new_reply_count":4'
      echo 'a pre-watermark reply reaches storage|"reply_id":"B1001"'
      echo 'denominator is the full fetched set|"analyzed_count":4'
      echo 'alert fires on the complete sample|"alert_now":true'
      ;;
    ratio-from-stored-rows)
      echo 'already-scored reply skipped|"new_reply_count":4'
      echo 'post A denominator is stored plus new|"analyzed_count":12'
      echo 'post A ratio is 7 over 12|"negative_ratio":0.5833333333333334'
      echo 'post A alerts|"alert_now":true'
      echo 'post B stored but not alerted|"negative_ratio":0.1'
      echo 'non-negative sentiment persisted|"sentiment":"Positive"'
      ;;
    pagination-multi-page-complete)
      echo 'three pages consumed|"reply_page_count":3'
      echo 'not treated as truncated|"replies_truncated":false'
      echo 'all pages contributed|"new_reply_count":3'
      ;;
    pagination-page-cap-truncated)
      echo 'truncation detected|"replies_truncated":true'
      echo 'fetch flagged|"fetch_truncated":true'
      echo 'developer alert raised|SEARCH_PAGE_CAP_REACHED'
      echo 'main branch still completes|"new_reply_count":3'
      ;;
    watermark-all-posts-discarded)
      echo 'posts did reach the filter and were all discarded|"2092579307088490998"'
      echo 'no post cleared the 10-reply filter|"quiet_reason":"NO_QUALIFYING_POSTS"'
      echo 'posts search was complete|"posts_truncated":false'
      echo 'no replies were fetched|"has_new_replies":false'
      ;;
    watermark-no-qualifying-posts)
      echo 'no post cleared the 10-reply filter|"quiet_reason":"NO_QUALIFYING_POSTS"'
      echo 'posts search was complete|"posts_truncated":false'
      ;;
    watermark-no-tracked-users)
      echo 'no active tracked users|"quiet_reason":"NO_TRACKED_USERS"'
      ;;
    watermark-quiet-replies-advances)
      echo 'nothing new to score|"has_new_replies":false'
      echo 'not truncated|"fetch_truncated":false'
      ;;
    watermark-analyzed-advances)
      echo 'a new reply was scored|"new_reply_count":1'
      echo 'not truncated|"fetch_truncated":false'
      ;;
    watermark-truncated-posts-holds)
      echo 'posts search hit the page cap|"posts_truncated":true'
      echo 'flagged as truncated|"fetch_truncated":true'
      ;;
    watermark-truncated-replies-quiet-holds)
      echo 'replies search hit the page cap|"replies_truncated":true'
      echo 'developer alert raised|SEARCH_PAGE_CAP_REACHED'
      echo 'nothing new to score|"has_new_replies":false'
      ;;
    watermark-classification-failed-holds)
      # One of two new replies came back on Classify Sentiment's error output. The
      # labelled reply is still stored; the failed one is not, so the marker must not
      # move past it or it is never re-scored.
      echo 'one reply failed classification|"classification_failed_count":1'
      echo 'the failed reply is named|"failed_reply_ids":\["9003"\]'
      echo 'the labelled reply is still stored|"reply_id":"9002"'
      echo 'developer alert raised|SENTIMENT_API_FAILED'
      ;;
    watermark-truncated-replies-analyzed-holds)
      echo 'replies search hit the page cap|"replies_truncated":true'
      echo 'developer alert raised|SEARCH_PAGE_CAP_REACHED'
      echo 'replies still scored and stored|"new_reply_count":1'
      ;;
    cheat-sheet-per-client-isolation)
      # The two client_id+version pairings below ARE the isolation proof. If the
      # batcher merged clients, or handed a client the wrong sheet, neither
      # contiguous pairing could appear.
      echo 'client A batched with its own sheet|"client_id":"f7317adc-eea5-49db-81bf-8b2393a93c89","cheat_sheet_version":3'
      echo 'client B batched with its own sheet|"client_id":"11111111-2222-3333-4444-555555555555","cheat_sheet_version":5'
      echo "client A's rules reached the prompt|CANARY_ALPHA"
      echo "client B's rules reached the prompt|CANARY_BRAVO"
      echo 'one classification item per reply, none merged across clients|"planned_reply_count":2'
      ;;
    cheat-sheet-client-stance)
      # Each block is matched whole, from its opening quote to the "reply_id" key that
      # follows it, so these are exact-text checks (the [^"]{1,4} is the escaped newline).
      # Client B has a sheet and no stance: its block must be exactly the pre-stance text.
      echo 'client A: stance first, then its sheet, braces doubled|"cheat_sheet_version":3,"cheat_sheet_block":"About this client \(stance v2\)\. Use it to judge whether a comment is for or against the account owner:[^"]{1,4}STANCE_ALPHA the owner backs reform; a \{\{brace\}\} must be doubled\.[^"]{2,8}Client-specific labelling rules \(cheat sheet v3\)\. Apply these over your general judgement whenever they match:[^"]{1,4}CANARY_ALPHA rules for client A only\.","reply_id"'
      echo 'client B without a stance: block unchanged|"cheat_sheet_version":5,"cheat_sheet_block":"Client-specific labelling rules \(cheat sheet v5\)\. Apply these over your general judgement whenever they match:[^"]{1,4}CANARY_BRAVO rules for client B only\.","reply_id"'
      echo 'client C: stance only, no fallback text|"cheat_sheet_version":0,"cheat_sheet_block":"About this client \(stance v7\)\. Use it to judge whether a comment is for or against the account owner:[^"]{1,4}STANCE_CHARLIE stance only, no cheat sheet\.","reply_id"'
      echo 'one classification item per reply|"planned_reply_count":3'
      ;;
    cheat-sheet-absent-fallback)
      echo 'no active sheet degrades instead of stalling|"cheat_sheet_version":0'
      echo 'fallback text used|No client-specific labelling rules are configured'
      echo 'untracked author still analyzed, not dropped|"client_id":"unknown"'
      echo 'the run still reaches storage|"reply_id":"R_A_1"'
      ;;
  esac
}

# What each watermark fixture must do to Run State.
#   "advance <iso>" - must adopt the run_started_at that the fixture pins
#   "hold"          - an incomplete read; the marker must not move at all
watermark_expectation() {
  case "$1" in
    watermark-all-posts-discarded)              echo 'advance 2026-08-25 09:20:00+00' ;;
    watermark-no-qualifying-posts)              echo 'advance 2026-08-25 09:00:00+00' ;;
    watermark-no-tracked-users)                 echo 'advance 2026-08-25 09:10:00+00' ;;
    watermark-quiet-replies-advances)           echo 'advance 2026-08-25 09:35:00+00' ;;
    watermark-analyzed-advances)                echo 'advance 2026-08-25 09:55:00+00' ;;
    watermark-truncated-posts-holds)            echo 'hold' ;;
    watermark-truncated-replies-quiet-holds)    echo 'hold' ;;
    watermark-truncated-replies-analyzed-holds) echo 'hold' ;;
    watermark-classification-failed-holds)      echo 'hold' ;;
  esac
}

# ---------------------------------------------------------------------------
# Publish guard.
#
# test_workflow runs the DRAFT. A schedule trigger runs the separately PUBLISHED
# active version. When those differ on an active workflow every assertion below
# is evidence about code no scheduled run will ever execute. That is exactly how
# the 2026-08-25 watermark fix passed its production checks while production kept
# running the pre-fix graph for three days (see TASK_TODOLIST.md).
# ---------------------------------------------------------------------------
printf '{"workflowId":"%s"}' "$WORKFLOW_ID" > "$TMP/wf.json"
mcp get_workflow_details "$TMP/wf.json" > "$TMP/wf-details.json"
wf_active="$(grep -oE '"active":(true|false)' "$TMP/wf-details.json" | head -1 | cut -d: -f2)"
wf_version="$(grep -oE '"versionId":"[^"]*"' "$TMP/wf-details.json" | head -1 | cut -d'"' -f4)"
wf_active_version="$(grep -oE '"activeVersionId":"[^"]*"' "$TMP/wf-details.json" | head -1 | cut -d'"' -f4)"

# Fail CLOSED. If the read failed or the response shape changed, every variable
# above is empty and a naive check would compare "" against "" and sail through --
# silently skipping the one check that exists to stop silent failures.
if [ "$wf_active" != "true" ] && [ "$wf_active" != "false" ]; then
  echo "" >&2
  echo "REFUSING TO RUN: could not read the publish state of $WORKFLOW_ID." >&2
  echo "  Expected \"active\":true|false in the get_workflow_details response." >&2
  echo "  Check N8N_MCP_URL / N8N_MCP_ACCESS_TOKEN, or the response shape." >&2
  exit 1
fi

if [ "$wf_active" = "true" ]; then
  if [ -z "$wf_version" ] || [ -z "$wf_active_version" ]; then
    echo "" >&2
    echo "REFUSING TO RUN: $WORKFLOW_ID is active but its version ids are unreadable." >&2
    echo "  draft  versionId: ${wf_version:-<unreadable>}" >&2
    echo "  active version  : ${wf_active_version:-<none, never published>}" >&2
    echo "  An active workflow with no activeVersionId has never been published." >&2
    exit 1
  fi
  if [ "$wf_version" != "$wf_active_version" ]; then
    echo "" >&2
    echo "REFUSING TO RUN: $WORKFLOW_ID is active but its draft is NOT published." >&2
    echo "  draft  versionId: $wf_version" >&2
    echo "  active version  : $wf_active_version" >&2
    echo "" >&2
    echo "  test_workflow runs the draft, so these fixtures would pass against code" >&2
    echo "  that no scheduled run executes. Publish the workflow, then re-run." >&2
    exit 1
  fi
  echo "publish check: draft == active ($wf_version)"
else
  echo "publish check: $WORKFLOW_ID is inactive (manual-execution only) - not applicable"
fi

filter="${1:-}"
pass=0; fail=0; failed_names=""; skipped_names=""

for f in "$HERE"/*.pinData.json; do
  name="$(basename "$f" .pinData.json)"
  if [ -n "$filter" ]; then
    case "$name" in *"$filter"*) ;; *) continue ;; esac
  fi

  # Pin data naming a node the target workflow does not have is a hard error, not a
  # warning. Some fixtures pin staging-only nodes (reply media sentiment), so compare the
  # fixture's top-level keys against the live node list and skip on any miss.
  absent=""
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    grep -qF "\"name\":\"$key\"" "$TMP/wf-details.json" || absent="$absent [$key]"
  done < <(grep -oE '^  "[^"]+"' "$f" | sed 's/^  "//; s/"$//')
  if [ -n "$absent" ]; then
    printf '\n=== %s ===\n  SKIP: pins nodes absent from %s:%s\n' "$name" "$WORKFLOW_ID" "$absent"
    skipped_names="$skipped_names $name"
    continue
  fi

  printf '\n=== %s ===\n' "$name"

  wm_exp="$(watermark_expectation "$name")"
  wm_before=""
  if [ -n "$wm_exp" ]; then
    wm_before="$(read_watermark)"
    if [ -z "$wm_before" ]; then
      echo "  FAIL: could not read Run State before the run"
      fail=$((fail+1)); failed_names="$failed_names $name"; continue
    fi
    echo "  Run State before: $wm_before"
  fi

  { printf '{"workflowId":"%s","timeout":120,"pinData":' "$WORKFLOW_ID"; cat "$f"; printf '}'; } > "$TMP/args.json"
  exec_id="$(mcp test_workflow "$TMP/args.json" | grep -oE 'executionId[^0-9]*[0-9]+' | grep -oE '[0-9]+$' | head -1)"

  if [ -z "$exec_id" ]; then
    echo "  FAIL: no execution id returned"
    [ -n "$wm_exp" ] && restore_watermark "$wm_before"
    fail=$((fail+1)); failed_names="$failed_names $name"; continue
  fi
  echo "  execution $exec_id"

  printf '{"workflowId":"%s","executionId":"%s","includeData":true}' "$WORKFLOW_ID" "$exec_id" > "$TMP/get.json"
  mcp get_workflow_execution "$TMP/get.json" | sed 's/\\\\"/"/g; s/\\"/"/g' > "$TMP/data.json"

  status="$(grep -oE '"status":"[a-z]+"' "$TMP/data.json" | head -1 | cut -d'"' -f4)"
  echo "  status: $status"

  local_fail=0
  if [ "$status" != "success" ]; then
    echo "  FAIL: execution status was '$status'"
    local_fail=1
  fi

  exp_file="$TMP/exp.txt"
  expectations "$name" > "$exp_file"
  while IFS='|' read -r label regex; do
    [ -z "${label:-}" ] && continue
    if grep -qE -- "$regex" "$TMP/data.json"; then
      echo "  ok   - $label"
    else
      echo "  FAIL - $label  (no match for: $regex)"
      local_fail=1
    fi
  done < "$exp_file"

  # The assertion that actually matters for a watermark fixture: what is stored now.
  if [ -n "$wm_exp" ]; then
    wm_after="$(read_watermark)"
    echo "  Run State after:  $wm_after"
    if [ "$wm_exp" = "hold" ]; then
      if [ "$wm_after" = "$wm_before" ]; then
        echo "  ok   - watermark held: an incomplete read must never advance it"
      else
        echo "  FAIL - watermark MOVED on a truncated pass: $wm_before -> $wm_after"
        echo "         replies past the page cap would never be requested again"
        local_fail=1
      fi
    else
      want="${wm_exp#advance }"
      if printf '%s' "$wm_after" | grep -qF -- "$want"; then
        echo "  ok   - watermark advanced to the run's start time ($want)"
      else
        echo "  FAIL - watermark did not advance; wanted $want, stored $wm_after"
        local_fail=1
      fi
    fi

    restore_watermark "$wm_before"
    wm_restored="$(read_watermark)"
    if [ "$wm_restored" = "$wm_before" ]; then
      echo "  restored Run State to $wm_before"
    else
      echo "  FAIL - could not restore Run State (now $wm_restored, was $wm_before)"
      local_fail=1
    fi
  fi

  if [ "$local_fail" -eq 0 ]; then
    pass=$((pass+1))
  else
    fail=$((fail+1)); failed_names="$failed_names $name"
  fi
done

printf '\n---------------------------------------\n'
printf 'passed: %d   failed: %d\n' "$pass" "$fail"
[ -n "$skipped_names" ] && printf 'skipped:%s\n' "$skipped_names"
[ -n "$failed_names" ] && printf 'failing:%s\n' "$failed_names"
[ "$fail" -eq 0 ] || exit 1
exit 0
