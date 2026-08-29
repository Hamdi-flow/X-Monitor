// Proves that `Insert or update replies` actually persists `sentiment` and
// `analyzed_at`, and that the stored-count consumers downstream of it see those
// values.
//
// WHY THIS FILE EXISTS
// --------------------
// `tests/n8n/scheduled-tracking-pins/` pins every credentialed node, including
// `Insert or update replies`. That is the right default — it keeps a pinned run
// off every live surface — but it means the whole suite is blind to what the
// upsert's column mapping actually writes. On 2026-08-25 the production node lost
// its `sentiment` and `analyzed_at` mappings in the staging -> production copy and
// all six non-watermark fixtures stayed green for four days, including
// `ratio-from-stored-rows`, whose "non-negative sentiment persisted" assertion
// only greps the execution data for `"sentiment":"Positive"` — which `Prepare
// Reply Data` emits regardless of whether the upsert stores it.
//
// So this test leaves `Insert or update replies` UNPINNED on purpose, the same way
// the `watermark-*` fixtures leave the two Run State writers unpinned: the whole
// question is what reaches the table. Everything with an external side effect --
// X, OpenAI, Telegram, the Posts upsert and both watermark writers -- stays pinned.
//
// It writes three synthetic `TEST-SENT-*` rows to the real `Replies` table,
// snapshots the target post beforehand, and deletes them in a `finally` block.
//
// Run from the repository root:
//   node tests/n8n/reply-sentiment-persistence.test.mjs                  # production
//   XMONITOR_WORKFLOW_ID=l4eKZucUZXzfz0H8 node tests/n8n/reply-sentiment-persistence.test.mjs
//
// `--expect-broken` inverts the persistence assertions, so the test can be shown
// to actually catch the regression before the fix is applied.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXPECT_BROKEN = process.argv.includes('--expect-broken');

const WORKFLOW_ID = process.env.XMONITOR_WORKFLOW_ID || 'Emb26wP77eFXgnVi';
const SUPABASE_REF =
  process.env.XMONITOR_SUPABASE_REF ||
  (WORKFLOW_ID === 'Emb26wP77eFXgnVi' ? 'jxnzdxyhoakpfmkbjdeq' : 'npytqidroqxgikaqofmq');

// A real post, so the `Replies.post_id -> Posts.post_id` foreign key and the
// `replies_set_client` trigger (which derives the NOT NULL `client_id` from the
// post) are both satisfied without inventing a Posts row.
const POST_ID = process.env.XMONITOR_TEST_POST_ID || '2084580476883292402';
const AUTHOR_ID = process.env.XMONITOR_TEST_AUTHOR_ID || '1062472974';

const REPLIES = [
  { id: 'TEST-SENT-NEG-1', sentiment: 'Negative', text: 'test reply negative' },
  { id: 'TEST-SENT-POS-1', sentiment: 'Positive', text: 'test reply positive' },
  { id: 'TEST-SENT-NEU-1', sentiment: 'Neutral', text: 'test reply neutral' },
];
const TEST_REPLY_IDS = REPLIES.map((r) => r.id);

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

function readEnv(file) {
  const values = {};
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    let value = line.slice(i + 1).trim();
    if (/^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);
    values[line.slice(0, i).trim()] = value;
  }
  return values;
}

const env = readEnv(path.join(ROOT, 'keys.env'));
for (const name of ['N8N_MCP_URL', 'N8N_MCP_ACCESS_TOKEN', 'SUPABASE_ACCESS_TOKEN']) {
  assert.ok(env[name], `${name} is required in keys.env`);
}

async function mcp(tool, args) {
  const res = await fetch(env.N8N_MCP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.N8N_MCP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`n8n MCP ${res.status}: ${raw.slice(0, 500)}`);
  const frames = raw.split(/\r?\n/).filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
  const envelope = JSON.parse(frames.length ? frames.join('') : raw);
  if (envelope.error) throw new Error(`n8n MCP error: ${JSON.stringify(envelope.error)}`);
  const text = (envelope.result?.content ?? []).map((c) => c.text ?? '').join('');
  try { return JSON.parse(text); } catch { return text; }
}

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${raw.slice(0, 500)}`);
  return JSON.parse(raw);
}

const quoted = (ids) => ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(',');

// The exact query text from the `Get Stored Post Counts` node, so this asserts
// against the consumer's own SQL rather than a paraphrase of it.
const storedCountsSql = (postId) => `
WITH requested AS (SELECT unnest(ARRAY['${postId}']::text[]) AS post_id)
SELECT requested.post_id,
  COUNT(*) FILTER (WHERE r.analyzed_at IS NOT NULL)::int                              AS stored_analyzed,
  COUNT(*) FILTER (WHERE r.analyzed_at IS NOT NULL AND r.sentiment = 'Negative')::int AS stored_negative,
  COUNT(*) FILTER (WHERE r.analyzed_at IS NOT NULL AND r.sentiment = 'Positive')::int AS stored_positive,
  COUNT(*) FILTER (WHERE r.analyzed_at IS NOT NULL AND r.sentiment = 'Neutral')::int  AS stored_neutral
FROM requested LEFT JOIN public."Replies" r ON r.post_id = requested.post_id
GROUP BY requested.post_id;`;

// ---------------------------------------------------------------------------
// pin data
// ---------------------------------------------------------------------------

const RUN_AT = '2026-08-29T12:00:00.000Z';

function basePins({ storedCounts, pinReplyUpsert }) {
  const pins = {
    'Schedule Trigger': [{ json: { timestamp: RUN_AT, Timezone: 'UTC' } }],
    'Get Run State': [{
      json: {
        key: 'scheduled_post_tracking',
        last_successful_run_at: '2026-08-29T11:00:00.000Z',
        run_started_at: RUN_AT,
      },
    }],
    // Pinned: this is a Postgres write.
    'Advance Post Suppression State': [{ json: { blocked_post_ids: [] } }],
    'Get Tracked Users': [{
      json: { user_id: AUTHOR_ID, username: 'tracked_user', display_name: 'Tracked User', is_active: true },
    }],
    // Pinned: live X API call.
    'Get posts of tracked users': [{
      json: {
        data: [{
          id: POST_ID,
          author_id: AUTHOR_ID,
          conversation_id: POST_ID,
          created_at: '2026-08-28T10:00:00.000Z',
          text: 'sentiment persistence probe post',
          public_metrics: { reply_count: 40, like_count: 0, retweet_count: 0, quote_count: 0, bookmark_count: 0, impression_count: 0 },
        }],
        meta: { result_count: 1 },
      },
    }],
    // Pinned: live X API call.
    'Get Replies': [{
      json: {
        data: REPLIES.map((r, i) => ({
          id: r.id,
          conversation_id: POST_ID,
          created_at: `2026-08-29T11:${10 + i * 5}:00.000Z`,
          text: r.text,
        })),
        meta: { result_count: REPLIES.length },
      },
    }],
    'Get Analyzed Reply Ids': [{ json: { analyzed_reply_ids: [] } }],
    // Pinned: live OpenAI call. This is where the mixed sentiments come from --
    // a negatives-only fixture could not have caught the regression, because
    // every stored row already happened to be Negative.
    'Analyze Sentiment with ChatGPT': [{
      json: {
        text: JSON.stringify({
          results: [{
            postId: POST_ID,
            postText: 'sentiment persistence probe post',
            userId: AUTHOR_ID,
            replies: REPLIES.map((r) => ({ id: r.id, sentiment: r.sentiment, text: r.text })),
          }],
        }),
      },
    }],
    // Pinned: writes to Posts. Keeps the blast radius to the Replies table.
    'Insert or update posts': [{ json: { post_id: POST_ID, status: 'New' } }],
    // Pinned: both watermark writers, so the production Run State never moves.
    'Advance Run State': [{ json: { key: 'scheduled_post_tracking', last_successful_run_at: RUN_AT } }],
    'Advance Run State (Quiet Pass)': [{ json: { key: 'scheduled_post_tracking', last_successful_run_at: RUN_AT } }],
    'Get Telegram Users': [{ json: { id: 1, chat_id: '0000000000', created_at: '2026-06-01T00:00:00.000Z' } }],
    // Pinned: real Telegram sends.
    'Send Negative Alert Notification': [{ json: { ok: true } }],
    'Send Scheduler Developer Alert': [{ json: { ok: true } }],
  };
  if (storedCounts) pins['Get Stored Post Counts'] = [{ json: { post_id: POST_ID, ...storedCounts } }];
  if (pinReplyUpsert) pins['Insert or update replies'] = REPLIES.map((r) => ({ json: { reply_id: r.id } }));
  return pins;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function assertPublished() {
  const details = await mcp('get_workflow_details', { workflowId: WORKFLOW_ID });
  const wf = details.workflow ?? details;
  assert.ok(typeof wf.active === 'boolean', 'could not read the publish state of the workflow');
  if (!wf.active) {
    console.log(`publish check: ${WORKFLOW_ID} is inactive (manual-execution only) - not applicable`);
    return;
  }
  assert.ok(wf.versionId, 'active workflow has an unreadable draft versionId');
  assert.ok(wf.activeVersionId, 'active workflow has never been published (no activeVersionId)');
  assert.equal(
    wf.versionId,
    wf.activeVersionId,
    `${WORKFLOW_ID} is active but its draft is NOT published (draft ${wf.versionId} != active ${wf.activeVersionId}). ` +
      'test_workflow runs the draft, so these assertions would describe code no scheduled run executes.',
  );
  console.log(`publish check: draft == active (${wf.versionId})`);
}

async function runPinned(label, pinData) {
  const started = await mcp('test_workflow', { workflowId: WORKFLOW_ID, timeout: 180, pinData });
  const executionId = started.executionId ?? started.execution?.id;
  assert.ok(executionId, `${label}: no execution id returned (${JSON.stringify(started).slice(0, 300)})`);
  const detail = await mcp('get_workflow_execution', { workflowId: WORKFLOW_ID, executionId: String(executionId), includeData: true });
  const status = detail.execution?.status ?? detail.status;
  console.log(`  ${label}: execution ${executionId} status=${status}`);
  assert.equal(status, 'success', `${label}: execution ${executionId} finished '${status}'`);
  return { executionId, runData: detail.execution?.data?.resultData?.runData ?? detail.data?.resultData?.runData ?? {} };
}

function nodeOutput(runData, nodeName) {
  const runs = runData[nodeName];
  assert.ok(runs?.length, `node '${nodeName}' did not execute`);
  return (runs[0].data?.main?.[0] ?? []).map((item) => item.json);
}

const ok = (msg) => console.log(`  ok   - ${msg}`);

// ---------------------------------------------------------------------------
// the test
// ---------------------------------------------------------------------------

let snapshot = null;

async function main() {
  console.log(`workflow ${WORKFLOW_ID}  supabase ${SUPABASE_REF}  post ${POST_ID}`);
  if (EXPECT_BROKEN) console.log('MODE: --expect-broken (asserting the regression is still present)\n');
  await assertPublished();

  // -- snapshot -------------------------------------------------------------
  snapshot = await sql(`SELECT reply_id, sentiment, analyzed_at::text, status FROM public."Replies" WHERE post_id = '${POST_ID}' ORDER BY reply_id;`);
  const baseline = (await sql(storedCountsSql(POST_ID)))[0];
  console.log(`\nsnapshot: ${snapshot.length} existing replies on ${POST_ID}`);
  console.log(`baseline stored counts: ${JSON.stringify(baseline)}`);

  const preexisting = await sql(`SELECT reply_id FROM public."Replies" WHERE reply_id IN (${quoted(TEST_REPLY_IDS)});`);
  assert.equal(preexisting.length, 0, `synthetic reply ids already present before the run: ${JSON.stringify(preexisting)}`);

  // == 1. persistence =======================================================
  // `Insert or update replies` is UNPINNED here. This is the assertion the
  // pinned suite structurally cannot make.
  console.log('\n=== 1. mixed-sentiment replies persist through the real upsert ===');
  const first = await runPinned('persistence run', basePins({
    storedCounts: {
      stored_analyzed: baseline.stored_analyzed,
      stored_negative: baseline.stored_negative,
      stored_positive: baseline.stored_positive,
      stored_neutral: baseline.stored_neutral,
    },
    pinReplyUpsert: false,
  }));

  const prepared = nodeOutput(first.runData, 'Prepare Reply Data');
  assert.equal(prepared.length, REPLIES.length, 'Prepare Reply Data did not emit one item per reply');
  ok(`Prepare Reply Data produced sentiment + analyzed_at for ${prepared.length} replies`);

  const stored = await sql(`SELECT reply_id, sentiment, analyzed_at::text AS analyzed_at, status FROM public."Replies" WHERE reply_id IN (${quoted(TEST_REPLY_IDS)}) ORDER BY reply_id;`);
  console.log(`  rows now in Replies: ${JSON.stringify(stored)}`);
  assert.equal(stored.length, REPLIES.length, `expected ${REPLIES.length} rows written, found ${stored.length}`);
  ok('all three replies reached the Replies table');

  const byId = new Map(stored.map((r) => [r.reply_id, r]));
  for (const reply of REPLIES) {
    const row = byId.get(reply.id);
    assert.ok(row, `reply ${reply.id} was not written at all`);
    if (EXPECT_BROKEN) {
      assert.equal(row.sentiment, null, `EXPECTED-BROKEN: ${reply.id} stored a sentiment, so the regression is already fixed`);
      assert.equal(row.analyzed_at, null, `EXPECTED-BROKEN: ${reply.id} stored an analyzed_at`);
      ok(`${reply.id}: sentiment and analyzed_at are NULL, as the regression predicts`);
    } else {
      assert.equal(row.sentiment, reply.sentiment, `${reply.id}: expected sentiment '${reply.sentiment}', stored '${row.sentiment}'`);
      assert.notEqual(row.analyzed_at, null, `${reply.id}: analyzed_at is NULL`);
      ok(`${reply.id}: sentiment='${row.sentiment}' analyzed_at='${row.analyzed_at}'`);
    }
  }

  if (EXPECT_BROKEN) {
    console.log('\n--expect-broken run complete: the regression reproduces.');
    return;
  }

  // == 2. the consumer the bug broke ========================================
  console.log('\n=== 2. Get Stored Post Counts sees the persisted rows ===');
  const after = (await sql(storedCountsSql(POST_ID)))[0];
  console.log(`  stored counts now: ${JSON.stringify(after)}`);
  const expected = {
    stored_analyzed: baseline.stored_analyzed + 3,
    stored_negative: baseline.stored_negative + 1,
    stored_positive: baseline.stored_positive + 1,
    stored_neutral: baseline.stored_neutral + 1,
  };
  for (const [key, want] of Object.entries(expected)) {
    assert.equal(after[key], want, `${key}: expected ${want}, got ${after[key]}`);
  }
  assert.ok(after.stored_analyzed > 0 && after.stored_negative > 0 && after.stored_positive > 0 && after.stored_neutral > 0,
    'stored counts must be non-zero in every sentiment bucket');
  ok(`non-zero in every bucket: analyzed=${after.stored_analyzed} negative=${after.stored_negative} positive=${after.stored_positive} neutral=${after.stored_neutral}`);

  // == 3. cross-pass ratio ==================================================
  // `Get Stored Post Counts` is UNPINNED here, so the node reads the rows written
  // in step 1 for real. Two new Negative replies arrive on top. If the ratio came
  // from this run's slice alone it would be 2/2 = 1.0; stored+new gives
  // (stored_negative + 2) / (stored_analyzed + 2).
  console.log('\n=== 3. negative_ratio combines stored rows with the new slice ===');
  const crossReplies = [
    { id: 'TEST-XPASS-1', sentiment: 'Negative', text: 'cross-pass negative one' },
    { id: 'TEST-XPASS-2', sentiment: 'Negative', text: 'cross-pass negative two' },
  ];
  const crossPins = basePins({ storedCounts: null, pinReplyUpsert: false });
  // Nothing new should be written in this phase.
  crossPins['Insert or update replies'] = crossReplies.map((r) => ({ json: { reply_id: r.id } }));
  crossPins['Get Replies'] = [{
    json: {
      data: crossReplies.map((r, i) => ({ id: r.id, conversation_id: POST_ID, created_at: `2026-08-29T11:${40 + i * 5}:00.000Z`, text: r.text })),
      meta: { result_count: crossReplies.length },
    },
  }];
  crossPins['Analyze Sentiment with ChatGPT'] = [{
    json: {
      text: JSON.stringify({
        results: [{
          postId: POST_ID,
          postText: 'sentiment persistence probe post',
          userId: AUTHOR_ID,
          replies: crossReplies.map((r) => ({ id: r.id, sentiment: r.sentiment, text: r.text })),
        }],
      }),
    },
  }];

  const second = await runPinned('cross-pass run', crossPins);

  const liveStored = nodeOutput(second.runData, 'Get Stored Post Counts');
  console.log(`  Get Stored Post Counts (live read): ${JSON.stringify(liveStored)}`);
  const liveRow = liveStored.find((r) => String(r.post_id) === POST_ID);
  assert.ok(liveRow, 'Get Stored Post Counts returned no row for the target post');
  assert.equal(liveRow.stored_analyzed, expected.stored_analyzed, 'live stored_analyzed disagrees with the direct query');
  assert.equal(liveRow.stored_positive, expected.stored_positive, 'live stored_positive disagrees with the direct query');
  assert.equal(liveRow.stored_neutral, expected.stored_neutral, 'live stored_neutral disagrees with the direct query');
  ok('the node itself reads back non-zero stored counts in every bucket');

  const calculated = nodeOutput(second.runData, 'Calculate/Filter Sentiment Counts');
  const post = (calculated[0]?.posts ?? calculated).find?.((p) => String(p.postId) === POST_ID)
    ?? (calculated[0]?.posts ?? [])[0];
  assert.ok(post, `could not find the post in Calculate/Filter Sentiment Counts output: ${JSON.stringify(calculated).slice(0, 400)}`);
  console.log(`  calculated: analyzed_count=${post.analyzed_count} negative_count=${post.negative_count} negative_ratio=${post.negative_ratio} alert_now=${post.alert_now}`);

  const wantAnalyzed = expected.stored_analyzed + crossReplies.length;
  const wantNegative = expected.stored_negative + crossReplies.length;
  assert.equal(post.analyzed_count, wantAnalyzed,
    `analyzed_count must be stored(${expected.stored_analyzed}) + new(${crossReplies.length}); a new-slice-only ratio would report ${crossReplies.length}`);
  assert.equal(post.negative_count, wantNegative, 'negative_count must be stored + new');
  assert.equal(post.negative_ratio, wantNegative / wantAnalyzed, 'negative_ratio must be computed over stored + new');
  assert.notEqual(post.negative_ratio, 1, 'a ratio of exactly 1.0 here would mean the stored rows were ignored');
  ok(`negative_ratio ${post.negative_ratio} = ${wantNegative}/${wantAnalyzed} (stored+new), not ${crossReplies.length}/${crossReplies.length} (new alone)`);

  // `Get Reply Status Counts` shares the `sentiment='Negative' AND analyzed_at
  // IS NOT NULL` join, so it breaks and recovers with the same fix.
  const statusCounts = nodeOutput(second.runData, 'Get Reply Status Counts');
  console.log(`  Get Reply Status Counts: ${JSON.stringify(statusCounts)}`);
  const statusRow = statusCounts.find((r) => String(r.post_id) === POST_ID);
  if (statusRow) {
    const denominator = statusRow.hidden_negative_replies_count + statusRow.non_hidden_negative_replies_count;
    assert.equal(denominator, expected.stored_negative, 'hidden + visible must cover every stored analyzed negative reply');
    ok(`alert denominator is ${denominator} stored analyzed negative replies (hidden ${statusRow.hidden_negative_replies_count} / visible ${statusRow.non_hidden_negative_replies_count})`);
  }

  console.log('\nAll assertions passed.');
}

async function cleanup() {
  const ids = [...TEST_REPLY_IDS, 'TEST-XPASS-1', 'TEST-XPASS-2'];
  const deleted = await sql(`DELETE FROM public."Replies" WHERE reply_id IN (${quoted(ids)}) RETURNING reply_id;`);
  console.log(`\ncleanup: deleted ${deleted.length} synthetic row(s) ${JSON.stringify(deleted.map((r) => r.reply_id))}`);

  const residue = await sql(`SELECT reply_id FROM public."Replies" WHERE reply_id IN (${quoted(ids)}) OR reply_id LIKE 'TEST-%';`);
  if (residue.length) {
    console.error(`RESIDUE: ${residue.length} synthetic row(s) remain: ${JSON.stringify(residue)}`);
    process.exitCode = 1;
    return;
  }
  console.log('cleanup: no synthetic residue remains');

  if (snapshot) {
    const now = await sql(`SELECT reply_id, sentiment, analyzed_at::text, status FROM public."Replies" WHERE post_id = '${POST_ID}' ORDER BY reply_id;`);
    if (JSON.stringify(now) !== JSON.stringify(snapshot)) {
      console.error(`RESIDUE: pre-existing replies on ${POST_ID} changed.\n  before: ${JSON.stringify(snapshot)}\n  after:  ${JSON.stringify(now)}`);
      process.exitCode = 1;
      return;
    }
    console.log(`cleanup: the ${snapshot.length} pre-existing replies on ${POST_ID} are byte-identical to the snapshot`);
  }
}

try {
  await main();
} catch (error) {
  console.error(`\nFAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  try {
    await cleanup();
  } catch (error) {
    console.error(`CLEANUP FAILED: ${error.message}`);
    console.error(`Remove by hand: DELETE FROM public."Replies" WHERE reply_id LIKE 'TEST-%';`);
    process.exitCode = 1;
  }
}
