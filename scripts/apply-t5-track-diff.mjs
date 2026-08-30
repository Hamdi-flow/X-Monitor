#!/usr/bin/env node
// T5 follow-up — stop /track emptying a client's list when nothing was tracked.
//
// THE DEFECT. /track means "replace this client's tracked accounts", and the
// deactivate ran FIRST, before the X lookup and before the upsert. So any
// failure after it left the client with an empty active list and the caller
// told it worked:
//
//   * a blocked ownership takeover (the upsert's client guard refuses, 0 rows)
//   * a failed X user lookup (pre-existing, recorded in the router doc)
//
// THE FIX. Deactivate LAST, and by difference rather than wholesale:
//
//   Upsert Tracked X User
//     -> Link Telegram User To X User
//     -> Build Track Outcome                  classify succeeded vs blocked
//     -> Deactivate Tracked Users For Chat    deactivate only rows NOT in the
//                                             succeeded set; no-ops on empty
//     -> Build Track Result Message           reports blocked accounts honestly
//     -> Send Tracking Success
//
// Nothing is deactivated until at least one account has actually been written,
// so a wholly failed /track is now a no-op instead of a wipe. The statement is
// explicitly guarded (`jsonb_array_length($2::jsonb) > 0`) because an empty
// succeeded set would otherwise match every row and deactivate the lot.
//
// The node keeps the name "Deactivate Tracked Users For Chat": three pinned
// fixtures reference it by name and must keep passing. Its type changes from
// Supabase to Postgres, which needs a remove+add rather than a parameter edit.
//
//   node scripts/apply-t5-track-diff.mjs <workflowId> <postgresCredId> <postgresCredName>

import { callTool } from './n8n-mcp.mjs';

const [, , workflowId, credId, credName] = process.argv;
if (!workflowId || !credId || !credName) {
  console.error('usage: node scripts/apply-t5-track-diff.mjs <workflowId> <credId> <credName>');
  process.exit(2);
}

const { workflow } = await callTool('get_workflow_details', { workflowId });
const existing = new Set(workflow.nodes.map((n) => n.name));
const deactivateNode = workflow.nodes.find((n) => n.name === 'Deactivate Tracked Users For Chat');
if (!deactivateNode) throw new Error('Deactivate Tracked Users For Chat not found');

const alreadyDone = deactivateNode.type === 'n8n-nodes-base.postgres';
const operations = [];

const OUTCOME_CODE = `// T5 follow-up: classify what the upsert actually did, per requested account.
//
// "Upsert Tracked X User" is guarded by
//   WHERE "Tracked Users".client_id = EXCLUDED.client_id
// so an account owned by ANOTHER client updates zero rows and the node emits an
// item with no user_id. That is the blocked-takeover case, and before this node
// existed it was indistinguishable from success.
//
// Index alignment: "If X User Lookup Successful" output 0 is exactly the set of
// items that reached the upsert, in the same order, so the two zip 1:1.
const attempts = $('Upsert Tracked X User').all();
const requested = $('If X User Lookup Successful').all();
const client = $('Build Track Client Result').first().json;

const succeeded = [];
const blocked = [];

attempts.forEach((item, i) => {
  const row = item.json || {};
  if (row.user_id) {
    succeeded.push({ user_id: String(row.user_id), username: String(row.username || '') });
    return;
  }
  const asked = requested[i]?.json?.data || {};
  blocked.push({ user_id: String(asked.id || ''), username: String(asked.username || '') });
});

return [{
  json: {
    client_id: String(client.client_id || ''),
    client_name: String(client.client_name || ''),
    client_slug: String(client.client_slug || ''),
    succeeded,
    blocked,
    succeeded_ids: succeeded.map((s) => s.user_id),
  },
}];`;

const DEACTIVATE_QUERY = `-- T5 follow-up: /track replaces a client's list, so accounts the caller did
-- NOT name are deactivated. This runs AFTER the upserts and takes the set of
-- accounts actually written, so a blocked takeover or a failed X lookup can no
-- longer empty a client's list.
--
-- jsonb_array_length($2) > 0 is load-bearing: with an empty succeeded set the
-- NOT EXISTS matches every row and this would deactivate everything. An empty
-- set means nothing was tracked, so the correct behaviour is to change nothing.
--
-- Both Supabase projects are shared with the sibling FB Monitor project, so the
-- table is named explicitly.
update public."Tracked Users" t
   set is_active = false
 where t.client_id = $1::uuid
   and t.is_active
   and jsonb_array_length($2::jsonb) > 0
   and not exists (
     select 1
       from jsonb_array_elements_text($2::jsonb) as k(id)
      where k.id = t.user_id
   )
returning t.user_id, t.username;`;

const MESSAGE_CODE = `// T5 follow-up: report what actually happened, per account.
//
// A blocked account used to be silently reported as success. It is now named,
// because "already tracked by another client" is something only staff can
// resolve and they cannot resolve what they are not told.
const outcome = $('Build Track Outcome').first().json;
const deactivated = $input.all()
  .map((i) => i.json || {})
  .filter((r) => r.user_id);

const lines = [];

if (outcome.succeeded.length) {
  lines.push(\`Now tracking for \${outcome.client_name} (\${outcome.client_slug}):\`);
  lines.push(outcome.succeeded.map((s) => \`- \${s.username}\`).join('\\n'));
} else {
  lines.push(\`No accounts were tracked for \${outcome.client_name} (\${outcome.client_slug}).\`);
  lines.push('Nothing was changed.');
}

if (deactivated.length) {
  lines.push('');
  lines.push('Stopped tracking:');
  lines.push(deactivated.map((r) => \`- \${r.username || r.user_id}\`).join('\\n'));
}

if (outcome.blocked.length) {
  lines.push('');
  lines.push('Could not track — already tracked by another client:');
  lines.push(outcome.blocked.map((b) => \`- \${b.username || b.user_id}\`).join('\\n'));
  lines.push('Move the account off its current client first, or track it there.');
}

return [{
  json: {
    message: lines.join('\\n'),
    succeeded_count: outcome.succeeded.length,
    blocked_count: outcome.blocked.length,
    deactivated_count: deactivated.length,
  },
}];`;

if (!alreadyDone) {
  // 1. Take the deactivate out of the pre-upsert path.
  operations.push({ type: 'removeConnection', source: 'Clear Telegram User Links', target: 'Deactivate Tracked Users For Chat' });
  operations.push({ type: 'removeConnection', source: 'Deactivate Tracked Users For Chat', target: 'Restore Track User List' });
  operations.push({ type: 'addConnection', source: 'Clear Telegram User Links', target: 'Restore Track User List' });

  // 2. Replace it with a Postgres node of the same name (type change needs
  //    remove+add; the name is kept because pinned fixtures reference it).
  operations.push({ type: 'removeNode', nodeName: 'Deactivate Tracked Users For Chat' });
  operations.push({
    type: 'addNode',
    node: {
      name: 'Deactivate Tracked Users For Chat',
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.6,
      position: [-12176, -624],
      parameters: {
        operation: 'executeQuery',
        query: DEACTIVATE_QUERY,
        options: {
          queryReplacement:
            '={{ [$json.client_id, JSON.stringify($json.succeeded_ids)] }}',
        },
      },
      credentials: { postgres: { id: credId, name: credName } },
    },
  });
}

// 3. The two new Code nodes, idempotent.
const newNodes = [
  { name: 'Build Track Outcome', position: [-12400, -624], jsCode: OUTCOME_CODE },
  { name: 'Build Track Result Message', position: [-11952, -624], jsCode: MESSAGE_CODE },
];

for (const n of newNodes) {
  operations.push(
    existing.has(n.name)
      ? { type: 'updateNodeParameters', nodeName: n.name, parameters: { jsCode: n.jsCode }, replace: true }
      : {
          type: 'addNode',
          node: {
            name: n.name,
            type: 'n8n-nodes-base.code',
            typeVersion: 2,
            position: n.position,
            parameters: { jsCode: n.jsCode },
          },
        },
  );
}

if (!alreadyDone) {
  operations.push({ type: 'removeConnection', source: 'Link Telegram User To X User', target: 'Send Tracking Success' });
  operations.push({ type: 'addConnection', source: 'Link Telegram User To X User', target: 'Build Track Outcome' });
  operations.push({ type: 'addConnection', source: 'Build Track Outcome', target: 'Deactivate Tracked Users For Chat' });
  operations.push({ type: 'addConnection', source: 'Deactivate Tracked Users For Chat', target: 'Build Track Result Message' });
  operations.push({ type: 'addConnection', source: 'Build Track Result Message', target: 'Send Tracking Success' });
  operations.push({ type: 'setNodePosition', nodeName: 'Send Tracking Success', position: [-11728, -624] });
}

// An empty deactivate result is the normal case, not a dead branch.
operations.push({
  type: 'setNodeSettings',
  nodeName: 'Deactivate Tracked Users For Chat',
  settings: { alwaysOutputData: true },
});

operations.push({
  type: 'updateNodeParameters',
  nodeName: 'Send Tracking Success',
  parameters: {
    chatId: "={{ $('Parse Telegram Message').item.json.telegram_chat_id }}",
    text: "={{ $('Build Track Result Message').first().json.message }}",
    additionalFields: { appendAttribution: false, parse_mode: 'HTML' },
  },
});

const res = await callTool('update_workflow', {
  workflowId,
  versionName: 'T5 fix: deactivate by difference, after the upserts',
  versionDescription:
    'A blocked takeover or failed lookup no longer empties the client list, and blocked accounts are reported instead of being called success.',
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
