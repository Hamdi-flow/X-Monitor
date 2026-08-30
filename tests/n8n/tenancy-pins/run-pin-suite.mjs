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
const fixtureDir = process.env.FIXTURE_DIR ? join(here, '..', process.env.FIXTURE_DIR) : here;
const manifest = JSON.parse(readFileSync(join(fixtureDir, 'manifest.json'), 'utf8'));
const workflowId = process.argv[2] || manifest.workflowId;

// Anything that spends money, writes to X, or messages a human.
const RISKY = [
  'Place Comment Order', 'Place Likes Order', 'Hide Reply On X',
  'Enqueue Hide Requests', 'Generate Supportive Comments',
];

const results = [];

for (const fx of manifest.fixtures) {
  const raw = JSON.parse(readFileSync(join(fixtureDir, fx.file), 'utf8'));
  const pinData = raw.pinData || raw;

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
