// Pinned tests for "XMonitor - Moderation Queue Drain (Staging)" (xt8fLOmRvDvTdZT9).
//
// Every external surface is pinned: the webhook trigger, every Postgres node,
// every Telegram node, and — the one that matters — `Hide Reply On X`. The X
// hide endpoint is NEVER called. What actually executes is the drain's decision
// logic: `Plan Drain Pass`, `Ready To Claim`, `Prepare Hide Requests`,
// `Prepare Drain Hide Result`, `Build Progress Edits`, and the two alert
// builders. That is exactly the code these scenarios exist to pin.
//
// Scenarios, one fixture each:
//
//   quota-exhausted-mid-batch  Two tokens. One has 5 rows due but only 2 calls
//                              left in its window; it must claim 2, not 5. The
//                              other has 0 left and must be deferred to its
//                              reset without spending a single request.
//   rate-limit-429             A 429 mid-batch must NOT consume an attempt
//                              (attempts_delta -1), must push not_before to the
//                              window reset, must mark that token's remaining
//                              as 0, and must not raise a developer alert.
//   permanent-failures         400 deleted / 401 revoked / 403 non-owner /
//                              403 missing-scope must all go straight to
//                              `failed` and never be retried — section 2.2
//                              step 5.
//   attempts-exhausted         A retryable 503 at attempts >= 5 becomes
//                              `abandoned`; the same error below that threshold
//                              is requeued with backoff.
//   unauthorized-call          A call with a bad X-Drain-Secret is rejected
//                              before it reaches any X or database node.
//
// The trigger is a WEBHOOK, not a schedule. n8n bills per trigger firing, and a
// 5-minute schedule cost ~8,640 executions/month to discover an empty queue on
// nearly all of them. pg_cron in Supabase now does the polling for free and only
// calls this webhook when there is due work. `Verify Drain Secret` is a Postgres
// node that compares the header against vault.decrypted_secrets in SQL, so it is
// pinned in every fixture: authorized:true in the four scenario fixtures, and
// authorized:false in `unauthorized-call` to prove a denial actually stops the run.
//
//   node tests/n8n/moderation-queue-drain.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Staging by default; DRAIN_ENV=production validates the promoted copy. The
// fixtures are shared deliberately -- the two workflows must behave identically,
// and a fixture that only passes in one environment is a drift alarm.
const TARGETS = {
  staging:    { id: 'xt8fLOmRvDvTdZT9', name: 'XMonitor - Moderation Queue Drain (Staging)', path: 'moderation-queue-drain-staging' },
  production: { id: 'vm4UNW7OIx2zEGb4', name: 'XMonitor - Moderation Queue Drain',           path: 'moderation-queue-drain' },
};
const TARGET = TARGETS[process.env.DRAIN_ENV || 'staging'];
if (!TARGET) throw new Error('DRAIN_ENV must be staging or production');
const WORKFLOW_ID = TARGET.id;
const WORKFLOW_NAME = TARGET.name;
const PIN_DIR = 'tests/n8n/moderation-queue-drain-pins';

function readEnv(file) {
  const values = {};
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const separator = line.indexOf('=');
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
}

function parseMcpResponse(text) {
  const dataLine = text.split(/\r?\n/).find((line) => line.startsWith('data: '));
  return JSON.parse(dataLine ? dataLine.slice(6) : text);
}

let requestId = 0;

async function callMcp(url, token, name, args) {
  requestId += 1;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`n8n MCP ${response.status}: ${text}`);
  const envelope = parseMcpResponse(text);
  if (envelope.error) throw new Error(`n8n MCP error: ${JSON.stringify(envelope.error)}`);
  const content = envelope.result?.content?.find((item) => item.type === 'text')?.text;
  assert.ok(content, `n8n MCP ${name} returned no text result`);
  if (envelope.result?.isError) throw new Error(`${name} failed: ${content}`);
  return JSON.parse(content);
}

const env = readEnv('keys.env');
const mcpUrl = env.N8N_MCP_URL;
const mcpToken = env.N8N_MCP_ACCESS_TOKEN;
assert.ok(mcpUrl, 'N8N_MCP_URL is required in keys.env');
assert.ok(mcpToken, 'N8N_MCP_ACCESS_TOKEN is required in keys.env');

// ---------------------------------------------------------------------------
// Guard: shape assertions that must hold regardless of fixture — the trigger,
// the auth gate, and the node settings that keep the queue in charge of retry.
// ---------------------------------------------------------------------------

const details = await callMcp(mcpUrl, mcpToken, 'get_workflow_details', { workflowId: WORKFLOW_ID });
const live = details.workflow;
assert.equal(live.name, WORKFLOW_NAME, 'workflow name changed');
// Activation was approved on 2026-08-27, so "active" is now the expected state.
// What still needs guarding is the pg_cron job, which is the real dispatch
// switch: an active webhook workflow does nothing until something calls it.
assert.equal(
  live.active, true,
  'The drain is INACTIVE. An n8n production webhook only answers while its workflow is '
  + 'active, so pg_cron would collect 404s every minute and nothing would ever be hidden.',
);

// n8n keeps a DRAFT and a separately published ACTIVE version. `update_workflow`
// edits the draft; webhook and schedule executions run the ACTIVE one. Worse for
// us, `test_workflow` runs the DRAFT — so every fixture below can pass against
// code that is not the code actually handling live traffic.
//
// This was not theoretical: on 2026-08-27 a classifier fix passed the whole suite
// while production kept running the old version, and only a live run against real
// X responses exposed it. Publishing is what closes the gap.
assert.equal(
  live.activeVersion?.sameAsDraft, true,
  'The published version differs from the draft. Everything below tests the DRAFT, so this '
  + 'suite is green while live traffic runs older code. Call publish_workflow on '
  + `${WORKFLOW_ID} before trusting these results.`,
);

// The trigger must stay a webhook. A Schedule Trigger reintroduces the ~8,640
// executions/month this design exists to avoid, and it would fire regardless of
// whether the queue has anything in it.
assert.ok(
  !live.nodes.some((n) => n.type === 'n8n-nodes-base.scheduleTrigger'),
  'A Schedule Trigger is back on the drain. n8n bills per trigger firing, so a schedule costs '
  + 'an execution every tick whether or not the queue has work. The trigger must stay a webhook '
  + 'driven by the pg_cron job in db/migrations/2026-08-27-moderation-drain-cron.sql.',
);
const webhook = live.nodes.find((n) => n.type === 'n8n-nodes-base.webhook');
assert.ok(webhook, 'the Drain Webhook trigger is missing');
assert.equal(webhook.parameters.httpMethod, 'POST');
assert.equal(webhook.parameters.path, TARGET.path);

// The gate is the only thing standing in front of a publicly reachable URL.
const gate = live.nodes.find((n) => n.name === 'Verify Drain Secret');
assert.ok(gate, '"Verify Drain Secret" is missing — the webhook would be unauthenticated');
assert.equal(
  gate.type, 'n8n-nodes-base.postgres',
  'The gate must compare against Vault in SQL. It was briefly a Code node reading $env, which '
  + 'cannot work: n8n Cloud blocks env access inside Code nodes ("access to env vars denied"), '
  + 'so that gate rejected every call.',
);
const gateQuery = gate.parameters.query || '';
assert.ok(
  gateQuery.includes('vault.decrypted_secrets') && gateQuery.includes("'moderation_drain_secret'"),
  '"Verify Drain Secret" no longer reads the shared secret from Vault',
);
assert.ok(
  /select exists\s*\(/i.test(gateQuery) && gateQuery.includes('decrypted_secret = $1'),
  'The gate must COMPARE in SQL and return only a boolean. Selecting the secret out and '
  + 'comparing it in n8n would put it in execution data, where it is retained and visible.',
);
assert.equal(
  gate.parameters.options?.queryReplacement,
  "={{ [$json.headers['x-drain-secret'] || ''] }}",
  'The gate must read the x-drain-secret header and default to an empty string, so a missing '
  + 'header fails closed rather than throwing.',
);

for (const nodeName of ['Hide Reply On X', 'Refresh Drain X Token']) {
  const target = live.nodes.find((n) => n.name === nodeName);
  assert.ok(target, `node "${nodeName}" is missing`);
  assert.ok(
    Object.prototype.hasOwnProperty.call(target, 'retryOnFail'),
    `${nodeName}: retryOnFail is ABSENT. "Claim Due Hide Rows" budgets exactly the number of `
    + 'requests the live x-rate-limit-remaining header allows; an n8n retry spends one it never '
    + 'budgeted. It must be explicitly false, not left to the node default.',
  );
  assert.equal(target.retryOnFail, false, `${nodeName}: retryOnFail must be false`);
}

for (const nodeName of ['Persist Reply Statuses', 'Persist X Rate Limits', 'Defer Rate Limited Tokens', 'Read Batch Progress']) {
  const target = live.nodes.find((n) => n.name === nodeName);
  assert.ok(target, `node "${nodeName}" is missing`);
  assert.equal(
    target.executeOnce, true,
    `${nodeName}: executeOnce must be true. It sits downstream of a RETURNING that emits one item `
    + 'per updated row, and reads its own input from $("Prepare Drain Hide Result").first(), so '
    + 'without executeOnce it runs once per returned row.',
  );
}

// ---------------------------------------------------------------------------
// Fixture runner
// ---------------------------------------------------------------------------

async function runFixture(name) {
  const pinData = JSON.parse(fs.readFileSync(path.join(PIN_DIR, `${name}.pinData.json`), 'utf8'));
  const run = await callMcp(mcpUrl, mcpToken, 'test_workflow', { workflowId: WORKFLOW_ID, pinData, timeout: 120 });
  assert.equal(run.status, 'success', `${name}: execution status was ${run.status}`);
  const detail = await callMcp(mcpUrl, mcpToken, 'get_workflow_execution', {
    workflowId: WORKFLOW_ID,
    executionId: String(run.executionId),
    includeData: true,
  });
  const runData = detail.data?.resultData?.runData ?? {};
  const out = (nodeName) => (runData[nodeName]?.[0]?.data?.main?.[0] ?? []).map((item) => item.json);
  return { executionId: run.executionId, out, ran: (nodeName) => Boolean(runData[nodeName]) };
}

const evidence = [];

// --- 1. quota exhausted mid-batch ------------------------------------------
{
  const { executionId, out } = await runFixture('quota-exhausted-mid-batch');
  const plans = out('Plan Drain Pass');
  assert.equal(plans.length, 2, 'expected a plan row per token');

  const partial = plans.find((p) => p.x_user_id === 'TEST_DRAIN_PARTIAL');
  assert.equal(partial.mode, 'drain');
  assert.equal(
    partial.allowance, 2,
    'A token with 5 rows due but only 2 calls left must claim 2. Claiming due_count would '
    + 'overrun the 50-per-15-minute window and turn the tail of the batch into 429s.',
  );

  const spent = plans.find((p) => p.x_user_id === 'TEST_DRAIN_SPENT');
  assert.equal(spent.mode, 'defer', 'a token with no quota left must be deferred, not drained');
  assert.equal(spent.allowance, 0);
  assert.equal(spent.defer_code, 'x_rate_limited');
  assert.equal(
    spent.defer_until, '2099-01-01T00:00:00.000Z',
    'section 2.2 step 3: not_before must be set to the window reset',
  );

  // The spent token must never reach the HTTP node.
  const requests = out('Prepare Hide Requests');
  assert.ok(
    requests.every((r) => r.x_user_id !== 'TEST_DRAIN_SPENT'),
    'a token with zero quota reached "Hide Reply On X" — that is a burnt request',
  );

  const summary = out('Prepare Drain Hide Result')[0];
  assert.equal(summary.attempted, 2);
  assert.equal(summary.hidden, 2);
  const rateLimits = JSON.parse(summary.rate_limits_json);
  assert.equal(
    rateLimits[0].remaining, 0,
    'the x-rate-limit-remaining header must be written back to "X Rate Limits" — that write is '
    + 'what replaces the old workflow static-data cache',
  );

  assert.equal(out('Build Developer Alert - Drain Blocked').length, 0,
    'a routine quota deferral must not page a developer');

  evidence.push(`quota-exhausted-mid-batch: execution ${executionId} — claimed 2 of 5 due, spent token deferred to reset`);
}

// --- 2. 429 response --------------------------------------------------------
{
  const { executionId, out } = await runFixture('rate-limit-429');
  const summary = out('Prepare Drain Hide Result')[0];
  const outcomes = JSON.parse(summary.outcomes_json);

  const ok = outcomes.find((o) => o.id.endsWith('301'));
  assert.equal(ok.status, 'done', 'the reply hidden before the 429 must still commit');

  const limited = outcomes.find((o) => o.id.endsWith('302'));
  assert.equal(limited.status, 'queued', 'a 429 must requeue the row, not fail it');
  assert.equal(limited.last_error_code, 'x_rate_limited');
  assert.equal(
    limited.attempts_delta, -1,
    'a 429 must REFUND the attempt. It says nothing about whether the hide would succeed, and '
    + 'charging it would abandon a healthy row after five busy windows.',
  );
  assert.equal(
    limited.not_before, '2100-01-01T00:00:00.000Z',
    'not_before must be pushed to the x-rate-limit-reset value',
  );

  const deferTokens = JSON.parse(summary.defer_tokens_json);
  assert.equal(deferTokens.length, 1, 'the 429 must defer the rest of that token\'s queued rows');
  assert.equal(deferTokens[0].x_user_id, 'TEST_DRAIN_429');

  const rateLimits = JSON.parse(summary.rate_limits_json);
  assert.equal(rateLimits[0].remaining, 0, 'a 429 must record remaining=0 so the next pass claims nothing');

  assert.equal(summary.rate_limited, 1);
  assert.equal(summary.failed, 0, 'a 429 is not a failure');
  assert.equal(out('Build Developer Alert - Drain Failures').length, 0,
    'a plain 429 must not raise a developer alert — the queue handles it');

  evidence.push(`rate-limit-429: execution ${executionId} — attempt refunded, deferred to reset, no alert`);
}

// --- 3. permanent failure classification -----------------------------------
{
  const { executionId, out } = await runFixture('permanent-failures');
  const summary = out('Prepare Drain Hide Result')[0];
  const outcomes = JSON.parse(summary.outcomes_json);
  const results = summary.results;

  const expected = {
    '401': 'reply_not_found',   // id ...401 gets the real 400 invalid-request X sends for a deleted reply
    '402': 'x_auth_rejected',
    '403': 'not_post_owner_or_not_moderatable',
    '404': 'missing_moderation_permission',
  };

  for (const [suffix, code] of Object.entries(expected)) {
    const outcome = outcomes.find((o) => o.id.endsWith(suffix));
    assert.equal(outcome.last_error_code, code, `row ...${suffix} classified as ${outcome.last_error_code}, expected ${code}`);
    assert.equal(
      outcome.status, 'failed',
      `row ...${suffix} (${code}) must go straight to failed. Section 2.2 step 5: deleted reply, `
      + 'revoked token and non-owner are permanent and must not be retried.',
    );
    assert.equal(outcome.attempts_delta, 0);
    assert.equal(outcome.not_before, null, 'a permanent failure must not schedule a retry');
  }

  assert.equal(summary.failed, 4);
  assert.equal(summary.abandoned, 0);
  assert.equal(summary.requeued, 0, 'no permanent failure may be requeued');

  const replyUpdates = JSON.parse(summary.reply_updates_json);
  assert.equal(replyUpdates.length, 4);
  assert.ok(replyUpdates.every((u) => u.status === 'hide_failed'),
    'permanently failed replies must be marked hide_failed so they stay eligible for a manual retry');

  assert.ok(results.every((r) => r.success === false));
  assert.equal(out('Build Developer Alert - Drain Failures').length, 1,
    'permanent failures must raise a developer alert');

  evidence.push(`permanent-failures: execution ${executionId} — 400-deleted/401/403/403-scope all failed, none retried`);
}

// --- 4. attempts exhaustion -------------------------------------------------
{
  const { executionId, out } = await runFixture('attempts-exhausted');
  const summary = out('Prepare Drain Hide Result')[0];
  const outcomes = JSON.parse(summary.outcomes_json);

  const exhausted = outcomes.find((o) => o.id.endsWith('501'));   // attempts 5
  assert.equal(
    exhausted.status, 'abandoned',
    'attempts >= 5 on a retryable failure must become abandoned — section 2.2 step 5',
  );
  assert.equal(exhausted.last_error_code, 'x_unavailable');
  assert.equal(exhausted.not_before, null, 'an abandoned row must not schedule another attempt');

  const nearlyExhausted = outcomes.find((o) => o.id.endsWith('502')); // attempts 4
  assert.equal(nearlyExhausted.status, 'queued', 'attempts 4 is below the threshold and must retry');
  assert.ok(nearlyExhausted.not_before, 'a requeued row must carry a backoff');

  const fresh = outcomes.find((o) => o.id.endsWith('503'));        // attempts 1
  assert.equal(fresh.status, 'queued');
  assert.ok(
    new Date(nearlyExhausted.not_before) > new Date(fresh.not_before),
    'backoff must grow with attempts — a row that has failed 4 times should wait longer than one that failed once',
  );

  assert.equal(summary.abandoned, 1);
  assert.equal(summary.requeued, 2);
  assert.equal(summary.failed, 0, '503 is transient, not a permanent failure');

  const replyUpdates = JSON.parse(summary.reply_updates_json);
  assert.equal(replyUpdates.length, 1, 'only the abandoned row updates Replies.status');
  assert.equal(replyUpdates[0].status, 'hide_failed');

  evidence.push(`attempts-exhausted: execution ${executionId} — attempts 5 abandoned, 4 and 1 requeued with growing backoff`);
}

// --- 5. unauthorized call ---------------------------------------------------
{
  const { executionId, out, ran } = await runFixture('unauthorized-call');

  const verdict = out('Verify Drain Secret')[0];
  assert.equal(verdict.authorized, false, 'a wrong X-Drain-Secret must not be authorized');

  // The important assertion is not "it said no" but "it stopped". Nothing that
  // touches X, Telegram, or the database may run on an unauthorized call.
  for (const nodeName of [
    'Find Drainable Tokens',
    'Plan Drain Pass',
    'Claim Due Hide Rows',
    'Hide Reply On X',
    'Persist Queue Outcomes',
    'Edit Telegram Progress',
  ]) {
    assert.ok(!ran(nodeName), `"${nodeName}" executed on an unauthorized call`);
  }
  assert.ok(ran('Reject Unauthorized Drain Call'), 'the rejection branch did not run');

  evidence.push(`unauthorized-call: execution ${executionId} — rejected at the gate, no X/DB/Telegram node ran`);
}

console.log(JSON.stringify({ ok: true, env: process.env.DRAIN_ENV || 'staging', workflowId: WORKFLOW_ID, active: live.active, evidence }, null, 2));
