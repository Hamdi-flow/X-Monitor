#!/usr/bin/env node
// T5 — carry the client through the X OAuth flow.
//
//   router:   Resolve Auth Client -> Generate X OAuth Link -> Save Auth Session
//             writes "X Auth Sessions".client_id
//   callback: Validate Auth Session / Prepare Account Row carry it through, and
//             Stamp Auth Account Client writes "X Auth Accounts".client_id
//
// WHY A SEPARATE STAMP NODE, not a column on the existing Upsert X Auth Account:
// this is a live external flow, and the failure would only surface the next
// time someone ran /auth_x. Adding client_id to that upsert's column mapping
// risks a null/empty uuid cast breaking the insert, which would mean clients
// cannot connect X accounts at all. The stamp runs AFTER the account row is
// safely written, is a no-op when no client resolved, and carries
// onError: continueRegularOutput so it can never break the authorization.
//
// Client resolution is deliberately best-effort and never refuses: a chat with
// no client still authorizes exactly as it does today, leaving client_id null
// (which is why T1 left the column nullable).
//
//   node scripts/apply-t5-oauth-client.mjs router <workflowId> <credId> <credName>
//   node scripts/apply-t5-oauth-client.mjs callback <workflowId> <credId> <credName>

import { callTool } from './n8n-mcp.mjs';

const [, , part, workflowId, credId, credName] = process.argv;
if (!['router', 'callback'].includes(part) || !workflowId || !credId || !credName) {
  console.error('usage: node scripts/apply-t5-oauth-client.mjs <router|callback> <workflowId> <credId> <credName>');
  process.exit(2);
}

const details = await callTool('get_workflow_details', { workflowId });
const wf = details.workflow;
const existing = new Set(wf.nodes.map((n) => n.name));
const posOf = (name) => wf.nodes.find((n) => n.name === name)?.position || [0, 0];
const operations = [];

if (part === 'router') {
  // -- Resolve which client this authorization is for ------------------------
  const genPos = posOf('Generate X OAuth Link');
  const resolveNode = {
    name: 'Resolve Auth Client',
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.6,
    position: [genPos[0] - 200, genPos[1]],
    parameters: {
      operation: 'executeQuery',
      query: `-- T5: which client is this X authorization for?
--   $1 an explicit client:<slug> typed by a staff caller, else ''
--   $2 the caller's own client when they belong to exactly one, else ''
-- Returns one row always. A null client_id is a valid outcome -- the chat has
-- no client, or a staff caller typed a slug that does not resolve -- and the
-- authorization proceeds regardless, exactly as it did before T5.
select
  case
    when $1 <> '' then (select c.id::text from public."Clients" c where c.slug = $1 and c.is_active)
    when $2 <> '' then $2
    else null
  end as client_id`,
      options: {
        queryReplacement:
          "={{ [ ($('Build Caller Authorization').first().json.command_args || '').match(/client[:=]([A-Za-z0-9][A-Za-z0-9_-]{0,48})/i)?.[1]?.toLowerCase() || '', (($('Build Caller Authorization').first().json.auth_client_ids || []).length === 1 ? $('Build Caller Authorization').first().json.auth_client_ids[0] : '') ] }}",
      },
    },
    credentials: { postgres: { id: credId, name: credName } },
  };

  operations.push(
    existing.has('Resolve Auth Client')
      ? { type: 'updateNodeParameters', nodeName: 'Resolve Auth Client', parameters: resolveNode.parameters, replace: true }
      : { type: 'addNode', node: resolveNode },
  );
  operations.push({ type: 'setNodeSettings', nodeName: 'Resolve Auth Client', settings: { alwaysOutputData: true } });

  // Re-route AUTH_X through the resolver.
  operations.push({ type: 'removeConnection', source: 'Route Telegram Intent', target: 'Generate X OAuth Link', sourceIndex: 1 });
  operations.push({ type: 'addConnection', source: 'Route Telegram Intent', target: 'Resolve Auth Client', sourceIndex: 1 });
  operations.push({ type: 'addConnection', source: 'Resolve Auth Client', target: 'Generate X OAuth Link' });

  // Generate X OAuth Link now sits behind the resolver, so telegram_chat_id can
  // no longer come from $json -- that is the Postgres row. Read it from the
  // parser, and carry client_id onto the session payload.
  const gen = wf.nodes.find((n) => n.name === 'Generate X OAuth Link');
  let code = gen.parameters.jsCode;
  if (!code.includes('client_id')) {
    code = code.replace(
      'return [{\n  json: {\n    telegram_chat_id: $json.telegram_chat_id,',
      `// T5: $json is now Resolve Auth Client's row, so the chat id comes from the
// parser. client_id may be null -- an unowned chat still authorizes.
const clientId = $json.client_id || null;

return [{
  json: {
    telegram_chat_id: $('Parse Telegram Message').first().json.telegram_chat_id,
    client_id: clientId,`,
    );
    if (!code.includes('client_id: clientId')) throw new Error('Generate X OAuth Link: anchor not found');
  }
  operations.push({ type: 'updateNodeParameters', nodeName: 'Generate X OAuth Link', parameters: { jsCode: code } });

  // Save Auth Session records it.
  const save = wf.nodes.find((n) => n.name === 'Save Auth Session');
  const fieldValues = JSON.parse(JSON.stringify(save.parameters.fieldsUi.fieldValues));
  if (!fieldValues.some((f) => f.fieldId === 'client_id')) {
    fieldValues.push({ fieldId: 'client_id', fieldValue: '={{ $json.client_id }}' });
  }
  operations.push({
    type: 'updateNodeParameters',
    nodeName: 'Save Auth Session',
    parameters: { fieldsUi: { fieldValues } },
  });
} else {
  // -- callback --------------------------------------------------------------
  const validate = wf.nodes.find((n) => n.name === 'Validate Auth Session');
  let vcode = validate.parameters.jsCode;
  if (!vcode.includes('client_id')) {
    vcode = vcode.replace(
      '    code_verifier: session.code_verifier,\n    session_expires_at: session.expires_at,',
      '    code_verifier: session.code_verifier,\n    session_expires_at: session.expires_at,\n    // T5: the client this authorization was started for. May be null.\n    client_id: session.client_id || null,',
    );
    if (!vcode.includes('client_id: session.client_id')) throw new Error('Validate Auth Session: anchor not found');
  }
  operations.push({ type: 'updateNodeParameters', nodeName: 'Validate Auth Session', parameters: { jsCode: vcode } });

  const prep = wf.nodes.find((n) => n.name === 'Prepare Account Row');
  let pcode = prep.parameters.jsCode;
  if (!pcode.includes('client_id')) {
    pcode = pcode.replace(
      '    telegram_chat_id: session.telegram_chat_id,\n    state: session.state,',
      '    telegram_chat_id: session.telegram_chat_id,\n    // T5: carried from "X Auth Sessions".client_id onto the account row.\n    client_id: session.client_id || null,\n    state: session.state,',
    );
    if (!pcode.includes('client_id: session.client_id')) throw new Error('Prepare Account Row: anchor not found');
  }
  operations.push({ type: 'updateNodeParameters', nodeName: 'Prepare Account Row', parameters: { jsCode: pcode } });

  const upsertPos = posOf('Upsert X Auth Account');
  const stampNode = {
    name: 'Stamp Auth Account Client',
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.6,
    position: [upsertPos[0], upsertPos[1] + 200],
    parameters: {
      operation: 'executeQuery',
      query: `-- T5: record which client this X account was authorized for.
-- Deliberately a separate statement AFTER the account row is written, and a
-- no-op when no client resolved, so it can never stop someone connecting an
-- X account. Paired with onError: continueRegularOutput.
update public."X Auth Accounts"
   set client_id = nullif($1, '')::uuid,
       updated_at = now()
 where x_user_id = $2
   and nullif($1, '') is not null
returning x_user_id, client_id::text`,
      options: {
        queryReplacement:
          "={{ [ $('Prepare Account Row').first().json.client_id || '', $('Prepare Account Row').first().json.x_user_id ] }}",
      },
    },
    credentials: { postgres: { id: credId, name: credName } },
  };

  operations.push(
    existing.has('Stamp Auth Account Client')
      ? { type: 'updateNodeParameters', nodeName: 'Stamp Auth Account Client', parameters: stampNode.parameters, replace: true }
      : { type: 'addNode', node: stampNode },
  );
  operations.push({
    type: 'setNodeSettings',
    nodeName: 'Stamp Auth Account Client',
    settings: { alwaysOutputData: true, onError: 'continueRegularOutput' },
  });

  // Splice between Upsert X Auth Account and Mark Auth Session Used.
  operations.push({ type: 'removeConnection', source: 'Upsert X Auth Account', target: 'Mark Auth Session Used' });
  operations.push({ type: 'addConnection', source: 'Upsert X Auth Account', target: 'Stamp Auth Account Client' });
  operations.push({ type: 'addConnection', source: 'Stamp Auth Account Client', target: 'Mark Auth Session Used' });
}

const res = await callTool('update_workflow', {
  workflowId,
  versionName: `T5: OAuth carries client_id (${part})`,
  versionDescription: 'X Auth Sessions.client_id is set at /auth_x and stamped onto X Auth Accounts by the callback.',
  operations,
});

console.log(
  JSON.stringify(
    {
      workflowId: res.workflowId,
      nodeCount: res.nodeCount,
      appliedOperations: res.appliedOperations,
      autoAssignedCredentials: res.autoAssignedCredentials,
      newWarnings: (res.validationWarnings || []).filter((w) => !w.preExisting),
    },
    null,
    2,
  ),
);
