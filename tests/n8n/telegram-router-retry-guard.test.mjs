// Guards the one setting that stands between an HTTP timeout and a double charge.
//
// SMMWiz's `add` endpoint is not idempotent and has no cancel. If n8n ever retries
// `Place Comment Order` or `Place Likes Order`, a request that already reached the
// provider becomes a second real, charged order. `retryOnFail` is therefore pinned
// to an explicit `false` on both nodes in both routers, and this test fails if that
// ever stops being true — including after a node `typeVersion` bump, which is the
// path by which an absent property quietly acquires a new default.
//
// Read-only: it fetches both workflows and asserts. It never executes them, and it
// never touches the SMM provider, Telegram, X, Supabase, or OpenAI.
//
//   node tests/n8n/telegram-router-retry-guard.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';

const MANIFEST = 'tests/n8n/telegram-router-risky-pins/manifest.json';

function readEnv(path) {
  const values = {};
  for (const rawLine of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
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

function requireEnv(env, name) {
  assert.ok(env[name], `${name} is required in keys.env`);
  return env[name];
}

function parseMcpResponse(responseText) {
  const dataLine = responseText.split(/\r?\n/).find((line) => line.startsWith('data: '));
  return JSON.parse(dataLine ? dataLine.slice(6) : responseText);
}

async function callMcp(url, token, name, args, id) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
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
const mcpUrl = requireEnv(env, 'N8N_MCP_URL');
const mcpToken = requireEnv(env, 'N8N_MCP_ACCESS_TOKEN');

const { nodeSettingsAssertions: expected } = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
assert.ok(expected, `${MANIFEST} is missing nodeSettingsAssertions`);

const checked = [];
let requestId = 1;

for (const workflow of expected.workflows) {
  const details = await callMcp(mcpUrl, mcpToken, 'get_workflow_details', { workflowId: workflow.id }, requestId += 1);
  const live = details.workflow;
  assert.ok(live, `could not read workflow ${workflow.id} (${workflow.name})`);
  assert.equal(live.name, workflow.name, `workflow ${workflow.id} changed name`);

  for (const expectedNode of expected.nodes) {
    const node = live.nodes.find((candidate) => candidate.name === expectedNode.name);
    assert.ok(node, `${workflow.name}: node "${expectedNode.name}" is missing`);
    assert.equal(node.type, expectedNode.type, `${workflow.name} / ${expectedNode.name}: node type changed`);

    // An absent retryOnFail relies on n8n's default of false. That default is not a
    // decision and can move; the property must be present and explicitly false.
    assert.ok(
      Object.prototype.hasOwnProperty.call(node, 'retryOnFail'),
      `${workflow.name} / ${expectedNode.name}: retryOnFail is ABSENT. It must be set explicitly to false — `
      + 'relying on the n8n default is what this test exists to prevent. '
      + expected.why,
    );
    assert.equal(
      node.retryOnFail, expectedNode.retryOnFail,
      `${workflow.name} / ${expectedNode.name}: retryOnFail is ${node.retryOnFail}, must be ${expectedNode.retryOnFail}. `
      + expected.why,
    );

    // A typeVersion bump can change defaults underneath a node, so pin it too and
    // force a deliberate re-review rather than a silent drift.
    assert.equal(
      node.typeVersion, expectedNode.typeVersion,
      `${workflow.name} / ${expectedNode.name}: typeVersion moved from ${expectedNode.typeVersion} to ${node.typeVersion}. `
      + 'Re-confirm retryOnFail is still false under the new version, then update the manifest.',
    );

    checked.push(`${workflow.name} / ${node.name}: retryOnFail=${node.retryOnFail} typeVersion=${node.typeVersion}`);
  }

  for (const stickyName of expected.stickyNotes ?? []) {
    const sticky = live.nodes.find((candidate) => candidate.name === stickyName);
    assert.ok(sticky, `${workflow.name}: sticky note "${stickyName}" recording the no-retry decision is missing`);
    assert.equal(sticky.type, 'n8n-nodes-base.stickyNote', `${workflow.name}: "${stickyName}" is not a sticky note`);
  }
}

console.log(JSON.stringify({ ok: true, assertions: checked.length, checked }, null, 2));
