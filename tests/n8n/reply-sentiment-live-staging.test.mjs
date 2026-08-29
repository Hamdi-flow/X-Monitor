// End-to-end LIVE staging test of per-reply sentiment persistence, on real data.
//
// Unlike `reply-sentiment-persistence.test.mjs` (synthetic replies, pinned OpenAI),
// this drives the real pipeline: a real post, its real replies fetched from the real
// X API, classified by the real OpenAI node, written through the real upsert, counted
// by the real stored-count queries, and announced by a real Telegram alert.
//
// Only two nodes are pinned, and neither is on the write path:
//   * `Get posts of tracked users` — the target post predates the live 7-day search
//     window, so the real post search would never return it. Pinned with the post's
//     real id, author, text and reply count.
//   * `Get Run State`            — back-dates `last_successful_run_at` so the REAL
//     reply search window reaches back over the conversation.
//
// Everything else is live: X reply search, OpenAI, both Postgres upserts, both
// stored-count queries, the alert builder, and the Telegram send.
//
// THE THREE COHORTS
// -----------------
// The post's real replies are split so both upsert paths are covered:
//   A  deleted   -> must be re-INSERTed with sentiment + analyzed_at
//   B  nulled    -> row kept, sentiment/analyzed_at set NULL; must be UPDATEd
//                   through ON CONFLICT. This is exactly the shape the production
//                   regression produced, so it doubles as a heal-forward check.
//   C  untouched -> stays analyzed, so `Get Stored Post Counts` has a real non-zero
//                   baseline and the ratio is provably stored+new.
//
// A missing column mapping breaks INSERT and ON CONFLICT UPDATE alike, but they are
// distinct SQL paths and a fixture that only covers one does not cover the other.
//
// Every touched row is snapshotted to disk BEFORE any mutation and restored at the
// end, including staging's four manual-label columns.
//
//   node tests/n8n/reply-sentiment-live-staging.test.mjs
//   node tests/n8n/reply-sentiment-live-staging.test.mjs --restore-only   # crash recovery

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_ID = process.env.XMONITOR_WORKFLOW_ID || 'l4eKZucUZXzfz0H8';
const SUPABASE_REF = process.env.XMONITOR_SUPABASE_REF || 'npytqidroqxgikaqofmq';
const POST_ID = process.env.XMONITOR_TEST_POST_ID || '2089952031398125613';
const SNAPSHOT = path.join(ROOT, 'tests/n8n/.live-staging-snapshot.json');

const RESTORE_ONLY = process.argv.includes('--restore-only');

// --------------------------------------------------------------------------- transport

function readEnv(file) {
  const values = {};
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    let v = line.slice(i + 1).trim();
    if (/^(".*"|'.*')$/s.test(v)) v = v.slice(1, -1);
    values[line.slice(0, i).trim()] = v;
  }
  return values;
}
const env = readEnv(path.join(ROOT, 'keys.env'));
for (const n of ['N8N_MCP_URL', 'N8N_MCP_ACCESS_TOKEN', 'SUPABASE_ACCESS_TOKEN']) {
  assert.ok(env[n], `${n} is required in keys.env`);
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
  if (!res.ok) throw new Error(`n8n MCP ${res.status}: ${raw.slice(0, 400)}`);
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
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${raw.slice(0, 400)}`);
  return JSON.parse(raw);
}

// Postgres literal. standard_conforming_strings is on, so doubling quotes is enough.
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const list = (ids) => ids.map(lit).join(',');
const ok = (m) => console.log(`  ok   - ${m}`);

// --------------------------------------------------------------------------- restore

const REPLY_COLUMNS = [
  'reply_id', 'post_id', 'text', 'sentiment', 'analyzed_at', 'status', 'created_at',
  'counter_reply_text', 'moderated_at', 'moderated_by', 'client_id',
  'manual_sentiment', 'manual_sentiment_note', 'manual_labeled_at', 'manual_labeled_by',
];

async function restoreFromSnapshot() {
  if (!fs.existsSync(SNAPSHOT)) {
    console.log('restore: no snapshot file, nothing to restore');
    return true;
  }
  const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  console.log(`\nrestore: replaying snapshot of ${snap.replies.length} replies on post ${snap.post_id}`);

  // Remove everything currently attached to the post, then reinsert the snapshot
  // verbatim. This also sweeps away any reply the live X fetch introduced that was
  // not in the original set.
  const before = await sql(`SELECT reply_id FROM public."Replies" WHERE post_id = ${lit(snap.post_id)};`);
  await sql(`DELETE FROM public."Replies" WHERE post_id = ${lit(snap.post_id)};`);

  const values = snap.replies.map((r) => `(${REPLY_COLUMNS.map((c) => lit(r[c])).join(',')})`).join(',\n  ');
  // The client trigger fires BEFORE INSERT and would overwrite client_id; it derives
  // the same value from post_id, so the snapshot value and the derived one agree.
  await sql(`INSERT INTO public."Replies" (${REPLY_COLUMNS.map((c) => `"${c}"`).join(',')}) VALUES\n  ${values};`);

  const p = snap.post;
  await sql(`UPDATE public."Posts" SET
      status = ${lit(p.status)},
      comment_count = ${lit(p.comment_count)},
      negative_count = ${lit(p.negative_count)},
      analyzed_count = ${lit(p.analyzed_count)},
      negative_ratio = ${lit(p.negative_ratio)},
      snooze_runs_remaining = ${lit(p.snooze_runs_remaining)},
      post_text = ${lit(p.post_text)},
      status_changed_at = ${lit(p.status_changed_at)},
      status_changed_by = ${lit(p.status_changed_by)}
    WHERE post_id = ${lit(snap.post_id)};`);

  await sql(`UPDATE public."Run State" SET last_successful_run_at = ${
    snap.run_state.last_successful_run_at ? `${lit(snap.run_state.last_successful_run_at)}::timestamptz` : 'NULL'
  } WHERE key = 'scheduled_post_tracking';`);

  // Verify byte-for-byte.
  const now = await sql(`SELECT ${REPLY_COLUMNS.map((c) => `"${c}"`).join(',')} FROM public."Replies" WHERE post_id = ${lit(snap.post_id)} ORDER BY reply_id;`);
  const want = [...snap.replies].sort((a, b) => String(a.reply_id).localeCompare(String(b.reply_id)));
  const norm = (rows) => JSON.stringify(rows.map((r) => REPLY_COLUMNS.map((c) => r[c] ?? null)));

  console.log(`restore: post had ${before.length} replies at restore time, snapshot holds ${snap.replies.length}, now ${now.length}`);
  if (norm(now) !== norm(want)) {
    console.error('RESIDUE: restored replies do not match the snapshot');
    for (let i = 0; i < Math.max(now.length, want.length); i++) {
      if (JSON.stringify(now[i]) !== JSON.stringify(want[i])) {
        console.error(`  first divergence at index ${i}:\n    now:  ${JSON.stringify(now[i])}\n    want: ${JSON.stringify(want[i])}`);
        break;
      }
    }
    return false;
  }
  ok(`all ${now.length} replies byte-identical to the snapshot`);

  const postNow = (await sql(`SELECT status,comment_count,negative_count,analyzed_count,negative_ratio,snooze_runs_remaining FROM public."Posts" WHERE post_id = ${lit(snap.post_id)};`))[0];
  const postWant = { status: p.status, comment_count: p.comment_count, negative_count: p.negative_count, analyzed_count: p.analyzed_count, negative_ratio: p.negative_ratio, snooze_runs_remaining: p.snooze_runs_remaining };
  if (JSON.stringify(postNow) !== JSON.stringify(postWant)) {
    console.error(`RESIDUE: Posts row differs.\n  now:  ${JSON.stringify(postNow)}\n  want: ${JSON.stringify(postWant)}`);
    return false;
  }
  ok('Posts row restored');

  const rs = (await sql(`SELECT last_successful_run_at::text FROM public."Run State" WHERE key='scheduled_post_tracking';`))[0];
  if (rs.last_successful_run_at !== snap.run_state.last_successful_run_at) {
    console.error(`RESIDUE: Run State is ${rs.last_successful_run_at}, snapshot ${snap.run_state.last_successful_run_at}`);
    return false;
  }
  ok(`Run State restored to ${rs.last_successful_run_at}`);

  fs.unlinkSync(SNAPSHOT);
  console.log('restore: complete, snapshot file removed');
  return true;
}

// --------------------------------------------------------------------------- main

function nodeOut(runData, name) {
  const runs = runData[name];
  if (!runs?.length) return null;
  return (runs[0].data?.main?.[0] ?? []).map((i) => i.json);
}

async function main() {
  console.log(`LIVE STAGING RUN  workflow ${WORKFLOW_ID}  supabase ${SUPABASE_REF}  post ${POST_ID}\n`);

  const wf = (await mcp('get_workflow_details', { workflowId: WORKFLOW_ID })).workflow;
  assert.equal(wf.active, false, 'staging is expected to be inactive / manual-execution only');
  console.log(`workflow "${wf.name}" active=${wf.active} (manual-execution by design; test_workflow runs the same draft)`);

  // ---- snapshot BEFORE any mutation --------------------------------------
  const replies = await sql(`SELECT ${REPLY_COLUMNS.map((c) => `"${c}"`).join(',')} FROM public."Replies" WHERE post_id = ${lit(POST_ID)} ORDER BY reply_id;`);
  assert.ok(replies.length >= 10, `post ${POST_ID} has only ${replies.length} replies, need at least 10`);
  const post = (await sql(`SELECT * FROM public."Posts" WHERE post_id = ${lit(POST_ID)};`))[0];
  assert.ok(post, `post ${POST_ID} not found`);
  const runState = (await sql(`SELECT key, last_successful_run_at::text FROM public."Run State" WHERE key='scheduled_post_tracking';`))[0];

  fs.writeFileSync(SNAPSHOT, JSON.stringify({ post_id: POST_ID, post, replies, run_state: runState }, null, 2));
  console.log(`snapshot written: ${replies.length} replies, Posts row, Run State -> ${path.relative(ROOT, SNAPSHOT)}`);

  // Only two pins, neither on the write path: the target post predates the live
  // 7-day post-search window, and the watermark is back-dated so the REAL reply
  // search reaches back over the conversation.
  async function runWorkflow(label) {
    const pinData = {
      'Get Run State': [{ json: { key: 'scheduled_post_tracking', last_successful_run_at: '2026-08-19T00:00:00.000Z', run_started_at: new Date().toISOString() } }],
      'Get posts of tracked users': [{
        json: {
          data: [{
            id: POST_ID,
            author_id: post.user_id,
            conversation_id: POST_ID,
            created_at: '2026-08-20T12:00:00.000Z',
            text: post.post_text,
            public_metrics: { reply_count: Number(post.comment_count) || replies.length, like_count: 0, retweet_count: 0, quote_count: 0, bookmark_count: 0, impression_count: 0 },
          }],
          meta: { result_count: 1 },
        },
      }],
    };
    const started = await mcp('test_workflow', { workflowId: WORKFLOW_ID, timeout: 600, pinData });
    const executionId = started.executionId ?? started.execution?.id;
    assert.ok(executionId, `${label}: no execution id: ${JSON.stringify(started).slice(0, 300)}`);
    const detail = await mcp('get_workflow_execution', { workflowId: WORKFLOW_ID, executionId: String(executionId), includeData: true });
    const status = detail.execution?.status ?? detail.status;
    const runData = detail.execution?.data?.resultData?.runData ?? detail.data?.resultData?.runData ?? {};
    assert.equal(status, 'success', `${label}: execution ${executionId} finished '${status}'`);
    return { executionId, status, runData };
  }

  const baseMix = {};
  for (const r of replies) baseMix[r.sentiment ?? 'NULL'] = (baseMix[r.sentiment ?? 'NULL'] || 0) + 1;
  console.log(`baseline sentiment mix on the post: ${JSON.stringify(baseMix)}`);
  console.log(`post status=${post.status} analyzed_count=${post.analyzed_count} negative_ratio=${post.negative_ratio}`);
  console.log(`Run State last_successful_run_at=${runState.last_successful_run_at}`);

  // ---- probe: which replies can X still return? ---------------------------
  // X's `conversation_id:` search does not return every reply that was ever stored
  // — older or since-deleted ones drop out of the index. Cohorts drawn from rows X
  // can no longer fetch would never be re-analyzed, so learn the retrievable set
  // first. Nothing is mutated yet, so this is a quiet pass: no OpenAI, no alert.
  console.log('\n=== 0a. probe run: which replies can the real X search still return? ===');
  const probe = await runWorkflow('probe');
  const probeIds = (nodeOut(probe.runData, 'Get Replies') ?? [])
    .flatMap((page) => (page.data ?? []).map((r) => String(r.id)));
  const probeAttached = nodeOut(probe.runData, 'Attach replies to posts')?.[0];
  console.log(`  execution ${probe.executionId}: X returned ${probeIds.length} replies across ${probeAttached?.reply_page_count ?? '?'} page(s)`);
  assert.equal(probeAttached?.new_reply_count, 0, 'probe should be a quiet pass — nothing has been mutated yet');
  ok('probe was a quiet pass (every fetched reply already analyzed), so no OpenAI or alert fired');

  const storedIds = new Set(replies.map((r) => String(r.reply_id)));
  const retrievable = [...new Set(probeIds)].filter((id) => storedIds.has(id));
  console.log(`  of those, ${retrievable.length} are rows we hold and can therefore round-trip`);
  assert.ok(retrievable.length >= 4, `only ${retrievable.length} replies are both retrievable from X and stored; cannot build cohorts`);

  // ---- cohorts ------------------------------------------------------------
  // Split the retrievable set: half deleted (INSERT path), half nulled (UPDATE path).
  const half = Math.floor(retrievable.length / 2);
  const cohortA = retrievable.slice(0, half);
  const cohortB = retrievable.slice(half);
  const touched = new Set([...cohortA, ...cohortB]);
  const cohortC = replies.map((r) => String(r.reply_id)).filter((id) => !touched.has(id));
  const byId = new Map(replies.map((r) => [String(r.reply_id), r.sentiment]));
  const expectedByIdA = new Map(cohortA.map((id) => [id, byId.get(id)]));
  const expectedByIdB = new Map(cohortB.map((id) => [id, byId.get(id)]));

  console.log(`\n=== 0b. preparing cohorts ===`);
  await sql(`DELETE FROM public."Replies" WHERE reply_id IN (${list(cohortA)});`);
  ok(`cohort A: deleted ${cohortA.length} replies (must be re-INSERTed)`);
  await sql(`UPDATE public."Replies" SET sentiment = NULL, analyzed_at = NULL WHERE reply_id IN (${list(cohortB)});`);
  ok(`cohort B: nulled sentiment/analyzed_at on ${cohortB.length} replies (must be UPDATEd via ON CONFLICT)`);
  ok(`cohort C: ${cohortC.length} replies left analyzed, forming the stored baseline`);

  const storedBefore = (await sql(`
    WITH requested AS (SELECT unnest(ARRAY[${lit(POST_ID)}]::text[]) AS post_id)
    SELECT COUNT(*) FILTER (WHERE r.analyzed_at IS NOT NULL)::int AS stored_analyzed,
           COUNT(*) FILTER (WHERE r.analyzed_at IS NOT NULL AND r.sentiment='Negative')::int AS stored_negative,
           COUNT(*) FILTER (WHERE r.analyzed_at IS NOT NULL AND r.sentiment='Positive')::int AS stored_positive,
           COUNT(*) FILTER (WHERE r.analyzed_at IS NOT NULL AND r.sentiment='Neutral')::int  AS stored_neutral
    FROM requested LEFT JOIN public."Replies" r ON r.post_id = requested.post_id;`))[0];
  console.log(`  stored counts after prep (cohort C only): ${JSON.stringify(storedBefore)}`);
  assert.equal(storedBefore.stored_analyzed, cohortC.length, 'stored baseline should equal cohort C');

  // ---- the live run -------------------------------------------------------
  console.log(`\n=== 1. live run (real X reply search, real OpenAI, real writes, real Telegram) ===`);
  const { executionId, status, runData } = await runWorkflow('live run');
  console.log(`  execution ${executionId}`);
  console.log(`  status: ${status}`);
  console.log(`  nodes executed: ${Object.keys(runData).length}`);

  const attached = nodeOut(runData, 'Attach replies to posts')?.[0];
  if (attached) {
    console.log(`  X fetch: reply_page_count=${attached.reply_page_count} new_reply_count=${attached.new_reply_count} replies_truncated=${attached.replies_truncated}`);
    assert.ok(attached.new_reply_count > 0, 'the live X search returned no new replies to analyze');
    ok(`real X reply search returned ${attached.new_reply_count} unanalyzed replies`);
  }

  // ---- 2. persistence through the real upsert -----------------------------
  console.log(`\n=== 2. real OpenAI labels persisted through the real upsert ===`);
  const afterA = await sql(`SELECT reply_id,sentiment,analyzed_at::text AS analyzed_at FROM public."Replies" WHERE reply_id IN (${list(cohortA)}) ORDER BY reply_id;`);
  const afterB = await sql(`SELECT reply_id,sentiment,analyzed_at::text AS analyzed_at FROM public."Replies" WHERE reply_id IN (${list(cohortB)}) ORDER BY reply_id;`);

  console.log(`  cohort A rows present again: ${afterA.length}/${cohortA.length}`);
  console.log(`  cohort B rows: ${afterB.length}/${cohortB.length}`);

  const check = (rows, label, expected) => {
    assert.ok(rows.length > 0, `${label}: no rows came back`);
    const bad = rows.filter((r) => !r.sentiment || !r.analyzed_at);
    if (bad.length) {
      console.error(`  ${label}: ${bad.length} row(s) still NULL: ${JSON.stringify(bad.slice(0, 5))}`);
    }
    assert.equal(bad.length, 0, `${label}: ${bad.length} row(s) persisted with NULL sentiment or analyzed_at`);
    const mix = {};
    for (const r of rows) mix[r.sentiment] = (mix[r.sentiment] || 0) + 1;
    ok(`${label}: all ${rows.length} rows have sentiment + analyzed_at — ${JSON.stringify(mix)}`);
    const agree = rows.filter((r) => expected.get(r.reply_id) === r.sentiment).length;
    console.log(`         agreement with the previously stored label: ${agree}/${rows.length}`);
    return mix;
  };

  const mixA = check(afterA, 'cohort A (INSERT path)', expectedByIdA);
  const mixB = check(afterB, 'cohort B (ON CONFLICT UPDATE path)', expectedByIdB);

  const combined = {};
  for (const m of [mixA, mixB]) for (const [k, v] of Object.entries(m)) combined[k] = (combined[k] || 0) + v;
  console.log(`  combined fresh-label mix: ${JSON.stringify(combined)}`);
  assert.ok(Object.keys(combined).length >= 2,
    `only one sentiment value came back (${JSON.stringify(combined)}); a single-label run cannot prove the mapping carries the value rather than a constant`);
  ok(`more than one distinct sentiment persisted — the column carries the model's value, not a constant`);

  // ---- 3. the consumers ---------------------------------------------------
  console.log(`\n=== 3. stored-count consumers ===`);
  const liveStored = nodeOut(runData, 'Get Stored Post Counts');
  if (liveStored) {
    console.log(`  Get Stored Post Counts (live, mid-run): ${JSON.stringify(liveStored)}`);
    const row = liveStored.find((r) => String(r.post_id) === POST_ID);
    if (row) {
      assert.equal(row.stored_analyzed, cohortC.length, 'mid-run stored_analyzed should equal the untouched cohort C');
      assert.ok(row.stored_analyzed > 0, 'stored_analyzed must be non-zero');
      ok(`read back stored_analyzed=${row.stored_analyzed} negative=${row.stored_negative} positive=${row.stored_positive} neutral=${row.stored_neutral}`);
    }
  }

  const calc = nodeOut(runData, 'Calculate/Filter Sentiment Counts');
  const posts = calc?.[0]?.posts ?? calc ?? [];
  const target = (Array.isArray(posts) ? posts : []).find((p) => String(p.postId) === POST_ID) ?? posts[0];
  assert.ok(target, `target post missing from Calculate/Filter Sentiment Counts: ${JSON.stringify(calc).slice(0, 300)}`);
  console.log(`  calculated: analyzed_count=${target.analyzed_count} negative_count=${target.negative_count} negative_ratio=${target.negative_ratio} alert_now=${target.alert_now} overall_tag=${target.overall_tag}`);

  const newCount = attached?.new_reply_count ?? (afterA.length + afterB.length);
  assert.equal(target.analyzed_count, cohortC.length + newCount,
    `analyzed_count must be stored(${cohortC.length}) + new(${newCount}); a new-slice-only ratio would report ${newCount}`);
  ok(`analyzed_count ${target.analyzed_count} = stored ${cohortC.length} + new ${newCount} — cross-pass, not new-slice-only`);
  assert.ok(target.negative_ratio > 0 && target.negative_ratio <= 1, 'negative_ratio out of range');

  const statusCounts = nodeOut(runData, 'Get Reply Status Counts');
  if (statusCounts?.length) {
    console.log(`  Get Reply Status Counts: ${JSON.stringify(statusCounts)}`);
    const s = statusCounts.find((r) => String(r.post_id) === POST_ID);
    if (s) ok(`alert denominator: hidden ${s.hidden_negative_replies_count} / visible ${s.non_hidden_negative_replies_count}`);
  }

  // ---- 4. the alert -------------------------------------------------------
  console.log(`\n=== 4. Telegram alert ===`);
  const built = nodeOut(runData, 'Build Negative Alert Notification');
  if (built?.length) {
    const msg = built[0].message ?? built[0].text ?? JSON.stringify(built[0]);
    console.log(`  built for ${built.length} recipient(s), chat_id=${built[0].chat_id ?? '(n/a)'}`);
    console.log('  --- message ---');
    console.log(String(msg).split('\n').map((l) => '  | ' + l).join('\n'));
  }
  const sent = nodeOut(runData, 'Send Negative Alert Notification');
  if (sent?.length) {
    const r = sent[0];
    console.log(`  Telegram API result: ok=${r.ok ?? '(n/a)'} message_id=${r.message_id ?? r.result?.message_id ?? '(n/a)'} chat=${r.chat?.id ?? r.result?.chat?.id ?? '(n/a)'}`);
    ok(`alert delivered — ${sent.length} message(s) sent`);
  } else {
    console.log('  Send Negative Alert Notification did not execute (no alert crossed the gate)');
  }

  console.log('\nAll assertions passed.');
}

let failed = false;
try {
  if (RESTORE_ONLY) {
    const good = await restoreFromSnapshot();
    process.exitCode = good ? 0 : 1;
  } else {
    await main();
  }
} catch (e) {
  failed = true;
  console.error(`\nFAIL: ${e.message}`);
  process.exitCode = 1;
} finally {
  if (!RESTORE_ONLY) {
    try {
      const good = await restoreFromSnapshot();
      if (!good) process.exitCode = 1;
    } catch (e) {
      console.error(`CLEANUP FAILED: ${e.message}`);
      console.error(`Re-run with --restore-only to retry from ${path.relative(ROOT, SNAPSHOT)}`);
      process.exitCode = 1;
    }
  }
  if (failed) console.error('\n(test failed; restore was still attempted above)');
}
