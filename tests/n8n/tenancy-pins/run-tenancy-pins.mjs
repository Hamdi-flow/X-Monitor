#!/usr/bin/env node
// Run every tenancy-pins fixture against a live router and check the manifest's
// reaches / doesNotReach / refusalReason assertions.
//
//   node tests/n8n/tenancy-pins/run-tenancy-pins.mjs [workflowId]
//
// Defaults to the staging router from the manifest. Every fixture pins its own
// credentialed and side-effecting nodes, so this performs no external writes;
// the runner refuses to execute a fixture that leaves a known-risky node
// unpinned rather than trusting the manifest.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callTool } from '../../../scripts/n8n-mcp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
const workflowId = process.argv[2] || manifest.workflowId;

// Anything that spends money, writes to X, or messages a human.
const RISKY = [
  'Place Comment Order', 'Place Likes Order', 'Hide Reply On X',
  'Enqueue Hide Requests', 'Generate Supportive Comments',
];


// Fixtures that do not pin "Resolve Caller Authorization" resolve the caller
// live, so their hardcoded chat id ties them to one environment. The risky-pins
// were written against staging's operator (8677383067) and are therefore
// refused as an unknown chat on production, whose operator is 8372903693 --
// true since T2, not a T5 regression. ACTOR_CHAT_ID rewrites the acting chat so
// one fixture set covers both routers.
function retarget(pinData, chatId) {
  if (!chatId) return pinData;
  const clone = JSON.parse(JSON.stringify(pinData));
  for (const item of clone['Telegram Trigger'] || []) {
    const j = item.json || {};
    if (j.message?.chat?.id !== undefined) j.message.chat.id = Number(chatId);
    if (j.message?.from?.id !== undefined) j.message.from.id = Number(chatId);
    if (j.callback_query?.message?.chat?.id !== undefined) j.callback_query.message.chat.id = Number(chatId);
    if (j.callback_query?.from?.id !== undefined) j.callback_query.from.id = Number(chatId);
  }
  return clone;
}

const actorChatId = process.env.ACTOR_CHAT_ID || '';

const results = [];

for (const fx of manifest.fixtures) {
  const raw = JSON.parse(readFileSync(join(here, fx.file), 'utf8'));
  const pinData = retarget(raw.pinData || raw, actorChatId);

  const unpinnedRisky = RISKY.filter(
    (n) => (fx.expected?.reaches || []).includes(n) && !pinData[n],
  );
  if (unpinnedRisky.length) {
    results.push({ id: fx.id, status: 'SKIPPED', detail: `risky node unpinned: ${unpinnedRisky.join(', ')}` });
    continue;
  }

  let exec;
  try {
    exec = await callTool('test_workflow', { workflowId, pinData, triggerNodeName: 'Telegram Trigger' });
  } catch (err) {
    results.push({ id: fx.id, status: 'ERROR', detail: String(err.message).slice(0, 160) });
    continue;
  }

  const detail = await callTool('get_workflow_execution', {
    workflowId,
    executionId: String(exec.executionId),
    includeData: true,
  });
  const runData = detail.data?.resultData?.runData || {};
  const executed = new Set(Object.keys(runData));

  const problems = [];
  for (const n of fx.expected?.reaches || []) if (!executed.has(n)) problems.push(`did not reach ${n}`);
  for (const n of fx.expected?.doesNotReach || []) if (executed.has(n)) problems.push(`REACHED ${n}`);

  // expectJson: { "<node name>": { "<field>": <value> } } on the node's first
  // output item. Reachability alone cannot catch a node that runs but computes
  // the wrong answer — which is exactly how the blocked-takeover defect hid.
  for (const [nodeName, expected] of Object.entries(fx.expected?.expectJson || {})) {
    const actual = runData[nodeName]?.[0]?.data?.main?.[0]?.[0]?.json;
    if (!actual) {
      problems.push(`${nodeName} produced no output`);
      continue;
    }
    for (const [field, want] of Object.entries(expected)) {
      const got = actual[field];
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        problems.push(`${nodeName}.${field} = ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
      }
    }
  }

  if (fx.expected?.refusalReason) {
    const refusal = runData['Build Access Refusal']?.[0]?.data?.main?.[0]?.[0]?.json;
    if (!refusal) problems.push('Build Access Refusal produced nothing');
    else if (refusal.refusal_reason !== fx.expected.refusalReason) {
      problems.push(`refusal_reason ${refusal.refusal_reason} != ${fx.expected.refusalReason}`);
    }
  }

  results.push({
    id: fx.id,
    status: problems.length ? 'FAIL' : 'PASS',
    execution: exec.executionId,
    detail: problems.join('; '),
  });
}

const pass = results.filter((r) => r.status === 'PASS').length;
const fail = results.filter((r) => r.status !== 'PASS');

for (const r of results) {
  console.log(`${r.status.padEnd(8)} ${r.id.padEnd(38)} ${r.execution || ''} ${r.detail || ''}`);
}
console.log(`\n${pass}/${results.length} passed against ${workflowId}`);
if (fail.length) process.exitCode = 1;
