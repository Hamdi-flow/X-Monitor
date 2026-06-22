import assert from 'node:assert/strict';
import fs from 'node:fs';

const WORKFLOW_NAME = 'XMonitor - Order Info Database Integration Test';
const POSTGRES_CREDENTIAL = {
  id: 'CyXakOvvENeDwRue',
  name: 'Supabase Staging Postgres',
};
const TERMINAL_STATUSES = new Set(['success', 'error', 'canceled', 'crashed']);

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

function apiBase(rawBase) {
  const base = rawBase.replace(/\/$/, '');
  return base.endsWith('/api/v1') ? base : `${base}/api/v1`;
}

async function apiRequest(base, apiKey, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-N8N-API-KEY': apiKey,
      ...options.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`n8n API ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
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
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`n8n MCP ${response.status}: ${text}`);
  const envelope = parseMcpResponse(text);
  if (envelope.error) throw new Error(`n8n MCP error: ${JSON.stringify(envelope.error)}`);
  const content = envelope.result?.content?.find((item) => item.type === 'text')?.text;
  assert.ok(content, `n8n MCP ${name} returned no text result`);
  const result = JSON.parse(content);
  if ((envelope.result?.isError || result.error) && !result.executionId) {
    throw new Error(`${name} failed: ${content}`);
  }
  return result;
}

function postgresNode(name, position, query, queryReplacement) {
  return {
    parameters: {
      operation: 'executeQuery',
      query,
      options: { queryBatching: 'independently', queryReplacement },
    },
    id: crypto.randomUUID(),
    name,
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.6,
    position,
    credentials: { postgres: POSTGRES_CREDENTIAL },
    onError: 'continueRegularOutput',
  };
}

function codeNode(name, position, jsCode) {
  return {
    parameters: { jsCode },
    id: crypto.randomUUID(),
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
  };
}

function connect(connections, source, target) {
  connections[source] = { main: [[{ node: target, type: 'main', index: 0 }]] };
}

function buildWorkflow() {
  const upsertSql = `INSERT INTO public."Order Info" (
  provider, provider_order_id, order_type, post_id, telegram_chat_id,
  x_username, link, service_id, quantity, comment_count, request_payload,
  provider_add_response, provider_status, normalized_status, next_check_at
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9::integer, $10::integer,
  $11::jsonb, $12::jsonb, $13, $14, $15::timestamptz
)
ON CONFLICT (provider, provider_order_id) DO UPDATE SET
  order_type = EXCLUDED.order_type,
  post_id = EXCLUDED.post_id,
  telegram_chat_id = EXCLUDED.telegram_chat_id,
  x_username = EXCLUDED.x_username,
  link = EXCLUDED.link,
  service_id = EXCLUDED.service_id,
  quantity = EXCLUDED.quantity,
  comment_count = EXCLUDED.comment_count,
  request_payload = EXCLUDED.request_payload,
  provider_add_response = EXCLUDED.provider_add_response,
  provider_status = EXCLUDED.provider_status,
  normalized_status = EXCLUDED.normalized_status,
  next_check_at = EXCLUDED.next_check_at,
  last_error = NULL
RETURNING *;`;
  const replacements = `={{ [$json.provider, $json.provider_order_id, $json.order_type,
    $json.post_id, $json.telegram_chat_id, $json.x_username, $json.link,
    $json.service_id, $json.quantity, $json.comment_count,
    JSON.stringify($json.request_payload), JSON.stringify($json.provider_add_response),
    $json.provider_status, $json.normalized_status, $json.next_check_at] }}`;

  const prepareInsert = `const response = $input.first().json;
return [{ json: {
  provider: 'smmwiz',
  provider_order_id: String(response.order),
  order_type: 'likes',
  post_id: 'order-info-integration-insert',
  telegram_chat_id: '100000001',
  x_username: 'integration_insert',
  link: 'https://x.com/integration/status/100000001',
  service_id: '12104',
  quantity: 25,
  comment_count: null,
  request_payload: { phase: 'insert', quantity: 25 },
  provider_add_response: { ...response, phase: 'insert' },
  provider_status: 'Pending',
  normalized_status: 'pending',
  next_check_at: '2030-01-02T03:04:05.000Z',
} }];`;

  const prepareUpdate = `const response = $('Pinned SMM Response').first().json;
return [{ json: {
  provider: 'smmwiz',
  provider_order_id: String(response.order),
  order_type: 'comments',
  post_id: 'order-info-integration-update',
  telegram_chat_id: '100000002',
  x_username: 'integration_update',
  link: 'https://x.com/integration/status/100000002',
  service_id: '12105',
  quantity: 7,
  comment_count: 3,
  request_payload: { phase: 'update', quantity: 7, comments: 3 },
  provider_add_response: { ...response, phase: 'update' },
  provider_status: 'Processing',
  normalized_status: 'in_progress',
  next_check_at: '2031-02-03T04:05:06.000Z',
} }];`;

  const verify = `const insert = $('Insert Order Info').first().json;
const update = $('Update Order Info').first().json;
const cleanup = $('Cleanup Order Info').first().json;
const confirmation = $('Confirm Cleanup').first().json;
const expectedColumns = [
  'id', 'provider', 'provider_order_id', 'order_type', 'post_id',
  'telegram_chat_id', 'x_username', 'link', 'service_id', 'quantity',
  'comment_count', 'request_payload', 'provider_add_response', 'provider_status',
  'normalized_status', 'status_response', 'charge', 'start_count', 'remains',
  'currency', 'poll_attempts', 'last_checked_at', 'next_check_at', 'last_error',
  'created_at', 'updated_at', 'completed_at', 'notified_at',
].sort();
const actualColumns = Object.keys(insert).sort();
if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns)) {
  throw new Error('Column mismatch: ' + JSON.stringify({ expectedColumns, actualColumns }));
}
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
};
const same = (actual, expected, label) => {
  if (JSON.stringify(stable(actual)) !== JSON.stringify(stable(expected))) {
    throw new Error(label + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
};
const validDate = (value, label) => {
  if (!value || Number.isNaN(Date.parse(value))) throw new Error(label + ' is not a timestamp: ' + value);
};
same(insert.provider, 'smmwiz', 'insert.provider');
same(insert.provider_order_id, String($('Pinned SMM Response').first().json.order), 'insert.provider_order_id');
same(insert.order_type, 'likes', 'insert.order_type');
same(insert.post_id, 'order-info-integration-insert', 'insert.post_id');
same(insert.telegram_chat_id, '100000001', 'insert.telegram_chat_id');
same(insert.x_username, 'integration_insert', 'insert.x_username');
same(insert.link, 'https://x.com/integration/status/100000001', 'insert.link');
same(insert.service_id, '12104', 'insert.service_id');
same(insert.quantity, 25, 'insert.quantity');
same(insert.comment_count, null, 'insert.comment_count');
same(insert.request_payload, { phase: 'insert', quantity: 25 }, 'insert.request_payload');
same(insert.provider_add_response, { order: $('Pinned SMM Response').first().json.order, fixture: true, phase: 'insert' }, 'insert.provider_add_response');
same(insert.provider_status, 'Pending', 'insert.provider_status');
same(insert.normalized_status, 'pending', 'insert.normalized_status');
for (const column of ['status_response', 'charge', 'start_count', 'remains', 'currency', 'last_checked_at', 'last_error', 'completed_at', 'notified_at']) same(insert[column], null, 'insert.' + column);
same(insert.poll_attempts, 0, 'insert.poll_attempts');
same(new Date(insert.next_check_at).toISOString(), '2030-01-02T03:04:05.000Z', 'insert.next_check_at');
validDate(insert.created_at, 'insert.created_at');
validDate(insert.updated_at, 'insert.updated_at');
if (!/^[0-9a-f-]{36}$/i.test(insert.id)) throw new Error('insert.id is not a UUID: ' + insert.id);

same(update.id, insert.id, 'update.id');
same(update.provider, 'smmwiz', 'update.provider');
same(update.provider_order_id, insert.provider_order_id, 'update.provider_order_id');
same(update.order_type, 'comments', 'update.order_type');
same(update.post_id, 'order-info-integration-update', 'update.post_id');
same(update.telegram_chat_id, '100000002', 'update.telegram_chat_id');
same(update.x_username, 'integration_update', 'update.x_username');
same(update.link, 'https://x.com/integration/status/100000002', 'update.link');
same(update.service_id, '12105', 'update.service_id');
same(update.quantity, 7, 'update.quantity');
same(update.comment_count, 3, 'update.comment_count');
same(update.request_payload, { phase: 'update', quantity: 7, comments: 3 }, 'update.request_payload');
same(update.provider_add_response, { order: $('Pinned SMM Response').first().json.order, fixture: true, phase: 'update' }, 'update.provider_add_response');
same(update.provider_status, 'Processing', 'update.provider_status');
same(update.normalized_status, 'in_progress', 'update.normalized_status');
for (const column of ['status_response', 'charge', 'start_count', 'remains', 'currency', 'last_checked_at', 'last_error', 'completed_at', 'notified_at']) same(update[column], null, 'update.' + column);
same(update.poll_attempts, 0, 'update.poll_attempts');
same(new Date(update.next_check_at).toISOString(), '2031-02-03T04:05:06.000Z', 'update.next_check_at');
same(update.created_at, insert.created_at, 'update.created_at');
validDate(update.updated_at, 'update.updated_at');
if (Date.parse(update.updated_at) < Date.parse(insert.updated_at)) throw new Error('updated_at moved backwards');
same(cleanup.id, update.id, 'cleanup.id');
same(Number(confirmation.remaining_rows), 0, 'cleanup.remaining_rows');
return [{ json: { ok: true, verified_columns: expectedColumns, cleaned_provider_order_id: update.provider_order_id } }];`;

  const nodes = [
    {
      parameters: {}, id: crypto.randomUUID(), name: 'Manual Trigger',
      type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0],
    },
    {
      parameters: { method: 'POST', url: 'https://example.invalid/smm-order', options: {} },
      id: crypto.randomUUID(), name: 'Pinned SMM Response',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4, position: [220, 0],
    },
    codeNode('Prepare Insert Row', [440, 0], prepareInsert),
    postgresNode('Insert Order Info', [660, 0], upsertSql, replacements),
    codeNode('Prepare Update Row', [880, 0], prepareUpdate),
    postgresNode('Update Order Info', [1100, 0], upsertSql, replacements),
    postgresNode(
      'Cleanup Order Info', [1320, 0],
      'DELETE FROM public."Order Info" WHERE provider = $1 AND provider_order_id = $2 RETURNING *;',
      `={{ ['smmwiz', String($('Pinned SMM Response').first().json.order)] }}`,
    ),
    postgresNode(
      'Confirm Cleanup', [1540, 0],
      'SELECT count(*)::integer AS remaining_rows FROM public."Order Info" WHERE provider = $1 AND provider_order_id = $2;',
      `={{ ['smmwiz', String($('Pinned SMM Response').first().json.order)] }}`,
    ),
    codeNode('Verify Every Column', [1760, 0], verify),
  ];
  const connections = {};
  for (let index = 0; index < nodes.length - 1; index += 1) connect(connections, nodes[index].name, nodes[index + 1].name);
  return {
    name: WORKFLOW_NAME,
    nodes,
    connections,
    settings: { executionOrder: 'v1', availableInMCP: true },
  };
}

async function waitForExecution(mcpUrl, mcpToken, workflowId, executionId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const execution = await callMcp(mcpUrl, mcpToken, 'get_execution', {
      workflowId, executionId, includeData: true,
      nodeNames: ['Verify Every Column', 'Confirm Cleanup'], truncateData: 5,
    }, 100 + attempt);
    if (TERMINAL_STATUSES.has(execution.execution?.status)) return execution;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Execution ${executionId} did not finish within 30 seconds`);
}

const env = readEnv('keys.env');
const base = apiBase(requireEnv(env, 'N8N_BASE_URL'));
const apiKey = requireEnv(env, 'N8N_API_KEY');
const mcpUrl = requireEnv(env, 'N8N_MCP_URL');
const mcpToken = requireEnv(env, 'N8N_MCP_ACCESS_TOKEN');
const providerOrderId = `xmonitor-order-info-it-${Date.now()}`;
let workflow;

try {
  workflow = await apiRequest(base, apiKey, '/workflows', {
    method: 'POST', body: JSON.stringify(buildWorkflow()),
  });
  const started = await callMcp(mcpUrl, mcpToken, 'test_workflow', {
    workflowId: workflow.id,
    triggerNodeName: 'Manual Trigger',
    pinData: {
      'Manual Trigger': [{ json: {} }],
      'Pinned SMM Response': [{ json: { order: providerOrderId, fixture: true } }],
    },
  }, 1);
  const execution = await waitForExecution(mcpUrl, mcpToken, workflow.id, started.executionId);
  assert.equal(execution.execution?.status, 'success', JSON.stringify(execution, null, 2));
  console.log(JSON.stringify({
    workflowId: workflow.id,
    executionId: started.executionId,
    providerOrderId,
    status: execution.execution.status,
    verifiedColumns: 28,
    remainingRows: 0,
  }, null, 2));
} finally {
  if (workflow?.id) await apiRequest(base, apiKey, `/workflows/${workflow.id}`, { method: 'DELETE' });
}
