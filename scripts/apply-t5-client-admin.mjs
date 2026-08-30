#!/usr/bin/env node
// T5 — staff-only client administration from Telegram, so a second client can
// be onboarded with no hand-written SQL (the console is read-only).
//
// Adds three commands, all reusing T2's refusal machinery for non-staff callers:
//
//   /clients                                       list active clients + chats
//   /client_new <slug> <Name...>                   create a Clients row
//   /client_attach <slug> <chat_id> [role] [label] attach a Client Members chat
//
// Idempotent: re-running against a graph that already has the nodes only
// refreshes their parameters.
//
//   node scripts/apply-t5-client-admin.mjs <workflowId> <postgresCredentialId> <postgresCredentialName>

import { callTool } from './n8n-mcp.mjs';

const [, , workflowId, credId, credName] = process.argv;
if (!workflowId || !credId || !credName) {
  console.error('usage: node scripts/apply-t5-client-admin.mjs <workflowId> <credId> <credName>');
  process.exit(2);
}

const details = await callTool('get_workflow_details', { workflowId });
const wf = details.workflow;
const existing = new Set(wf.nodes.map((n) => n.name));

// ---------------------------------------------------------------------------
// 1. Parse Telegram Message — three new commands
// ---------------------------------------------------------------------------
const parseNode = wf.nodes.find((n) => n.name === 'Parse Telegram Message');
let parseCode = parseNode.parameters.jsCode;

const NEW_CASES = `    // T5 staff-only client administration. Gated on Staff by
    // If Client Admin Is Staff, exactly like /track.
    case 'clients':
      intent = 'LIST_CLIENTS';
      break;

    case 'client_new':
      intent = 'CREATE_CLIENT';
      break;

    case 'client_attach':
      intent = 'ATTACH_CHAT';
      break;

`;

if (!parseCode.includes("case 'client_new':")) {
  const anchor = "    case 'hide_replies':";
  if (!parseCode.includes(anchor)) throw new Error('Parse Telegram Message: anchor not found');
  parseCode = parseCode.replace(anchor, NEW_CASES + anchor);
}

// ---------------------------------------------------------------------------
// 2. Route Telegram Intent — three new outputs
// ---------------------------------------------------------------------------
// Switch rules are an array; setNodeParameter cannot index into one, so the
// whole rules object is rewritten via updateNodeParameters.
const routeNode = wf.nodes.find((n) => n.name === 'Route Telegram Intent');
const rules = JSON.parse(JSON.stringify(routeNode.parameters.rules));
const haveKeys = new Set(rules.values.map((r) => r.outputKey));
const template = rules.values[0];

for (const key of ['LIST_CLIENTS', 'CREATE_CLIENT', 'ATTACH_CHAT']) {
  if (haveKeys.has(key)) continue;
  const rule = JSON.parse(JSON.stringify(template));
  rule.outputKey = key;
  const cond = rule.conditions.conditions[0];
  cond.id = `c5000000-0000-4000-8000-${key.slice(0, 12).padEnd(12, '0')}`;
  cond.rightValue = key;
  rules.values.push(rule);
}

// ---------------------------------------------------------------------------
// 3. Staff-only gate shared by all three commands
// ---------------------------------------------------------------------------
const X0 = -1400;
const Y0 = 2600;

const nodes = [
  {
    name: 'If Client Admin Is Staff',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: [X0, Y0],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 3 },
        conditions: [
          {
            id: 'c5000000-0000-4000-8000-000000000001',
            leftValue: "={{ $('Build Caller Authorization').first().json.auth_is_staff === true }}",
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
  },
  {
    name: 'Route Client Admin Intent',
    type: 'n8n-nodes-base.switch',
    typeVersion: 3.2,
    position: [X0 + 200, Y0],
    parameters: {
      rules: {
        values: ['LIST_CLIENTS', 'CREATE_CLIENT', 'ATTACH_CHAT'].map((key, i) => ({
          outputKey: key,
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 3 },
            conditions: [
              {
                id: `c5000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`,
                leftValue: "={{ $('Build Caller Authorization').first().json.intent }}",
                rightValue: key,
                operator: { type: 'string', operation: 'equals' },
              },
            ],
            combinator: 'and',
          },
          renameOutput: true,
        })),
      },
      options: {},
    },
  },

  // --- /clients -------------------------------------------------------------
  {
    name: 'List Clients',
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.6,
    position: [X0 + 420, Y0 - 220],
    parameters: {
      operation: 'executeQuery',
      query: `-- T5 /clients. One row per client with its attached chats, so staff can see
-- what exists before tracking into it. Both Supabase projects are shared with
-- the sibling FB Monitor project, so tables are named explicitly.
select
  c.slug,
  c.name,
  c.is_active,
  c.min_replies,
  c.negative_threshold::float8 as negative_threshold,
  coalesce((
    select count(*) from public."Client Members" cm
     where cm.client_id = c.id and cm.is_active
  ), 0) as active_chats,
  coalesce((
    select string_agg(cm.chat_id || case when cm.receives_alerts then '' else ' (muted)' end, ', ' order by cm.chat_id)
      from public."Client Members" cm
     where cm.client_id = c.id and cm.is_active
  ), '') as chat_ids
from public."Clients" c
order by c.is_active desc, c.slug`,
      options: {},
    },
    credentials: { postgres: { id: credId, name: credName } },
  },
  {
    name: 'Build Clients List',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [X0 + 620, Y0 - 220],
    parameters: {
      jsCode: `// T5 /clients — render the client roster for a staff chat.
const rows = $input.all().map((i) => i.json).filter((r) => r && r.slug);

if (!rows.length) {
  return [{ json: { message: 'No clients exist yet. Create one with:\\n/client_new <slug> <Name>' } }];
}

const lines = rows.map((r) => {
  const state = r.is_active ? '' : ' [inactive]';
  const chats = r.chat_ids ? r.chat_ids : 'no chats attached';
  return \`• \${r.slug}\${state} — \${r.name}\\n   chats: \${chats}\\n   min_replies \${r.min_replies}, threshold \${r.negative_threshold}\`;
});

return [{ json: { message: \`Clients (\${rows.length}):\\n\\n\${lines.join('\\n\\n')}\` } }];`,
    },
  },

  // --- /client_new ----------------------------------------------------------
  {
    name: 'Parse Client New',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [X0 + 420, Y0],
    parameters: {
      jsCode: `// T5 /client_new <slug> <Name...>
// The slug is the key staff will type into /track, so it is constrained to the
// shape /track accepts and lowercased here rather than at use time.
const route = $('Parse Telegram Message').first().json;
const args = String(route.command_args || '').trim();
const tokens = args.split(/\\s+/).filter(Boolean);

const slug = String(tokens[0] || '').toLowerCase();
const name = tokens.slice(1).join(' ').trim();

let error = '';
if (!slug || !name) {
  error = 'Usage: /client_new <slug> <Name>\\nExample: /client_new acme Acme Corporation';
} else if (!/^[a-z0-9][a-z0-9_-]{1,48}$/.test(slug)) {
  error = \`"\${slug}" is not a valid slug. Use 2-49 characters: lowercase letters, digits, hyphen or underscore, starting with a letter or digit.\`;
}

return [{
  json: {
    client_new_valid: error === '',
    slug,
    client_name: name,
    message: error,
  },
}];`,
    },
  },
  {
    name: 'If Client New Valid',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: [X0 + 620, Y0],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 3 },
        conditions: [
          {
            id: 'c5000000-0000-4000-8000-000000000201',
            leftValue: '={{ $json.client_new_valid === true }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
  },
  {
    name: 'Create Client',
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.6,
    position: [X0 + 820, Y0 - 80],
    parameters: {
      operation: 'executeQuery',
      query: `-- T5 /client_new. Idempotent: re-running with an existing slug reports the
-- existing row rather than failing, so a staff retry is never destructive.
-- The 'created' flag is what tells the two cases apart downstream.
with ins as (
  insert into public."Clients" (slug, name)
  values ($1, $2)
  on conflict (slug) do nothing
  returning id, slug, name, is_active
)
select id::text as client_id, slug, name, is_active, true as created from ins
union all
select c.id::text, c.slug, c.name, c.is_active, false as created
  from public."Clients" c
 where c.slug = $1 and not exists (select 1 from ins)`,
      options: { queryReplacement: '={{ [$json.slug, $json.client_name] }}' },
    },
    credentials: { postgres: { id: credId, name: credName } },
  },
  {
    name: 'Build Client New Result',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [X0 + 1020, Y0 - 80],
    parameters: {
      jsCode: `// T5 /client_new result. Names the next step explicitly — a client with no
// chat attached receives nothing, which is the easiest thing to forget.
const row = $input.first()?.json || {};

if (!row.client_id) {
  return [{ json: { message: 'Could not create the client. Check the slug and try again.' } }];
}

const created = row.created === true || row.created === 'true';
const head = created
  ? \`Created client \${row.name} (\${row.slug}).\`
  : \`Client \${row.slug} already exists — \${row.name}\${row.is_active ? '' : ' [inactive]'}. Nothing changed.\`;

return [{
  json: {
    message: \`\${head}\\n\\nNext:\\n/client_attach \${row.slug} <chat_id>\\n/track client:\${row.slug} @handle\`,
  },
}];`,
    },
  },

  // --- /client_attach -------------------------------------------------------
  {
    name: 'Parse Client Attach',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [X0 + 420, Y0 + 240],
    parameters: {
      jsCode: `// T5 /client_attach <slug> <chat_id> [role] [label...]
// role defaults to 'client'; 'operator' is the only other value the
// Client Members_role_check constraint accepts.
const route = $('Parse Telegram Message').first().json;
const tokens = String(route.command_args || '').trim().split(/\\s+/).filter(Boolean);

const slug = String(tokens[0] || '').toLowerCase();
const chat_id = String(tokens[1] || '');
let role = String(tokens[2] || '').toLowerCase();
let label = tokens.slice(3).join(' ').trim();

// role is optional and positional, so a label in its place must not become a role.
if (role && role !== 'client' && role !== 'operator') {
  label = [tokens[2], ...tokens.slice(3)].join(' ').trim();
  role = 'client';
}
if (!role) role = 'client';

let error = '';
if (!slug || !chat_id) {
  error = 'Usage: /client_attach <slug> <chat_id> [role] [label]\\nExample: /client_attach acme 8677383067 client Acme ops';
} else if (!/^-?[0-9]{1,19}$/.test(chat_id)) {
  error = \`"\${chat_id}" is not a valid Telegram chat id.\`;
}

return [{
  json: {
    client_attach_valid: error === '',
    slug,
    chat_id,
    role,
    label,
    message: error,
  },
}];`,
    },
  },
  {
    name: 'If Client Attach Valid',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: [X0 + 620, Y0 + 240],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 3 },
        conditions: [
          {
            id: 'c5000000-0000-4000-8000-000000000301',
            leftValue: '={{ $json.client_attach_valid === true }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
  },
  {
    name: 'Attach Client Member',
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.6,
    position: [X0 + 820, Y0 + 180],
    parameters: {
      operation: 'executeQuery',
      query: `-- T5 /client_attach. Returns zero rows when the slug names no ACTIVE client,
-- which the builder reports as an unknown-client error rather than a success.
-- Re-attaching an existing chat reactivates it instead of erroring, so a retry
-- is safe.
with c as (
  select id, name from public."Clients" where slug = $1 and is_active
)
insert into public."Client Members" (client_id, chat_id, role, label, receives_alerts, is_active)
select c.id, $2, $3, nullif($4, ''), true, true from c
on conflict (client_id, chat_id) do update
  set role = excluded.role,
      label = coalesce(excluded.label, public."Client Members".label),
      is_active = true,
      updated_at = now()
returning
  client_id::text,
  chat_id,
  role,
  label,
  receives_alerts,
  (select name from c) as client_name`,
      options: { queryReplacement: '={{ [$json.slug, $json.chat_id, $json.role, $json.label] }}' },
    },
    credentials: { postgres: { id: credId, name: credName } },
  },
  {
    name: 'Build Client Attach Result',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [X0 + 1020, Y0 + 180],
    parameters: {
      jsCode: `// T5 /client_attach result. An empty result means the slug matched no active
// client — the insert selected from an empty CTE — so it is reported as an
// unknown client, not as a silent success.
const row = $input.first()?.json || {};
const parsed = $('Parse Client Attach').first().json;

if (!row.client_id) {
  return [{
    json: {
      message: \`No active client with slug "\${parsed.slug}". Run /clients to see what exists, or create it with /client_new.\`,
    },
  }];
}

return [{
  json: {
    message: \`Attached chat \${row.chat_id} to \${row.client_name} (\${parsed.slug}) as \${row.role}.\\nAlerts: \${row.receives_alerts ? 'on' : 'off'}.\\n\\nNext:\\n/track client:\${parsed.slug} @handle\`,
  },
}];`,
    },
  },

  // --- shared ---------------------------------------------------------------
  {
    name: 'Build Client Admin Error',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [X0 + 820, Y0 + 420],
    parameters: {
      jsCode: `// Shared usage/validation error surface for the three client-admin commands.
// The message is built by whichever Parse node rejected the input.
return [{ json: { message: String($json.message || 'Invalid input.') } }];`,
    },
  },
  {
    name: 'Send Client Admin Reply',
    type: 'n8n-nodes-base.telegram',
    typeVersion: 1.2,
    position: [X0 + 1260, Y0],
    parameters: {
      chatId: "={{ $('Parse Telegram Message').first().json.telegram_chat_id }}",
      text: '={{ $json.message }}',
      additionalFields: { appendAttribution: false },
    },
  },
];

const operations = [
  { type: 'updateNodeParameters', nodeName: 'Parse Telegram Message', parameters: { jsCode: parseCode } },
  { type: 'updateNodeParameters', nodeName: 'Route Telegram Intent', parameters: { rules } },
];

for (const node of nodes) {
  if (existing.has(node.name)) {
    operations.push({ type: 'updateNodeParameters', nodeName: node.name, parameters: node.parameters, replace: true });
  } else {
    operations.push({ type: 'addNode', node });
  }
}

// Telegram credential for the reply node: copy whatever the existing sends use.
const telegramCred = wf.nodes.find((n) => n.type === 'n8n-nodes-base.telegram' && n.credentials?.telegramApi)
  ?.credentials?.telegramApi;
if (telegramCred && !existing.has('Send Client Admin Reply')) {
  operations.push({
    type: 'setNodeCredential',
    nodeName: 'Send Client Admin Reply',
    credentialKey: 'telegramApi',
    credentialId: telegramCred.id,
    credentialName: telegramCred.name,
  });
}

// Wiring. addConnection is idempotent on repeat runs.
const routeOutputs = rules.values.map((r) => r.outputKey);
const conns = [
  ['Route Telegram Intent', 'If Client Admin Is Staff', routeOutputs.indexOf('LIST_CLIENTS'), 0],
  ['Route Telegram Intent', 'If Client Admin Is Staff', routeOutputs.indexOf('CREATE_CLIENT'), 0],
  ['Route Telegram Intent', 'If Client Admin Is Staff', routeOutputs.indexOf('ATTACH_CHAT'), 0],
  ['If Client Admin Is Staff', 'Route Client Admin Intent', 0, 0],
  ['If Client Admin Is Staff', 'Build Access Refusal', 1, 0],
  ['Route Client Admin Intent', 'List Clients', 0, 0],
  ['Route Client Admin Intent', 'Parse Client New', 1, 0],
  ['Route Client Admin Intent', 'Parse Client Attach', 2, 0],
  ['List Clients', 'Build Clients List', 0, 0],
  ['Build Clients List', 'Send Client Admin Reply', 0, 0],
  ['Parse Client New', 'If Client New Valid', 0, 0],
  ['If Client New Valid', 'Create Client', 0, 0],
  ['If Client New Valid', 'Build Client Admin Error', 1, 0],
  ['Create Client', 'Build Client New Result', 0, 0],
  ['Build Client New Result', 'Send Client Admin Reply', 0, 0],
  ['Parse Client Attach', 'If Client Attach Valid', 0, 0],
  ['If Client Attach Valid', 'Attach Client Member', 0, 0],
  ['If Client Attach Valid', 'Build Client Admin Error', 1, 0],
  ['Attach Client Member', 'Build Client Attach Result', 0, 0],
  ['Build Client Attach Result', 'Send Client Admin Reply', 0, 0],
  ['Build Client Admin Error', 'Send Client Admin Reply', 0, 0],
];

for (const [source, target, sourceIndex, targetIndex] of conns) {
  operations.push({ type: 'addConnection', source, target, sourceIndex, targetIndex });
}

// Postgres nodes must always output data: an empty result is a meaningful
// answer (unknown slug) that the builders report, not a dead branch.
for (const n of ['List Clients', 'Create Client', 'Attach Client Member']) {
  operations.push({ type: 'setNodeSettings', nodeName: n, settings: { alwaysOutputData: true } });
}

const res = await callTool('update_workflow', {
  workflowId,
  versionName: 'T5: staff client administration commands',
  versionDescription: '/clients, /client_new and /client_attach, staff-gated and reusing the T2 refusal surface.',
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
