#!/usr/bin/env node
// T5 — re-key /track ownership from telegram_chat_id to client_id.
//
// Idempotent and anchored on node names, so it can be re-applied to a freshly
// pulled live graph (local exports drift; live n8n is the truth).
//
//   node scripts/apply-t5-track-client.mjs <workflowId>
//
// Applies to one router. Run it against staging first, then production.

import { callTool } from './n8n-mcp.mjs';

const [, , workflowId, credId, credName] = process.argv;
if (!workflowId || !credId || !credName) {
  console.error('usage: node scripts/apply-t5-track-client.mjs <workflowId> <postgresCredId> <postgresCredName>');
  process.exit(2);
}

const details = await callTool('get_workflow_details', { workflowId });
const existingNodes = new Set(details.workflow.nodes.map((n) => n.name));

// One X account belongs to one CLIENT. The pre-T5 guard compared chats, which
// stopped meaning anything once /track became staff-only: a staff chat is
// neither client's chat, so the guard would have let any staff caller move an
// account between clients. telegram_chat_id is deliberately no longer written
// -- client_id is the sole ownership key (see the migration's column comment).
const UPSERT_QUERY = `INSERT INTO public."Tracked Users" (user_id, username, client_id, is_active)
VALUES ($1, $2, $3, true)
ON CONFLICT (user_id) DO UPDATE
SET
  username = EXCLUDED.username,
  client_id = EXCLUDED.client_id,
  is_active = true
WHERE
  public."Tracked Users".client_id = EXCLUDED.client_id
RETURNING user_id, username, client_id, is_active;`;

const REFUSAL_CODE = `// T2 shared refusal surface. Every denial in this workflow lands here.
// SECURITY: 'post_not_found' and 'cross_tenant_post' MUST return the same
// user-facing text. Distinguishing them turns the bot into an oracle for
// probing which post ids exist inside other clients. The real reason is
// recorded in refusal_reason (execution data) and in the developer alert only.
const auth = $('Build Caller Authorization').first().json;
const post = $input.first()?.json || {};

const postId = String(auth.post_id || '');
const postExists = Boolean(post && post.post_id);

// T5: an unknown/inactive client on a staff /track. Checked FIRST and gated on
// an explicit marker set only by Build Track Client Result, so every pre-T5
// branch reaches this node with the marker absent and behaves exactly as before.
const trackClientUnresolved = post.track_client_unresolved === true;

// T5: the client-administration commands are staff-only for the same reason
// /track is -- they change who owns what. Same refusal text, so a client chat
// cannot tell a staff-only command from an unrecognised one.
const STAFF_ONLY_INTENTS = new Set(['TRACK_USERS', 'LIST_CLIENTS', 'CREATE_CLIENT', 'ATTACH_CHAT']);

let refusal_reason;
if (trackClientUnresolved) {
  refusal_reason = 'unknown_client';
} else if (auth.auth_is_known !== true) {
  refusal_reason = 'unknown_chat';
} else if (STAFF_ONLY_INTENTS.has(auth.intent)) {
  refusal_reason = 'staff_only_command';
} else if (postExists) {
  refusal_reason = 'cross_tenant_post';
} else {
  refusal_reason = 'post_not_found';
}

const requestedSlug = String(post.requested_client_slug || '');
const availableSlugs = String(post.available_slugs || '');

const MESSAGES = {
  unknown_chat: {
    message: 'This chat is not registered with XMonitor. Ask your account manager to add it, then try again.',
    callback_text: 'Chat not registered.',
  },
  staff_only_command: {
    message: 'This command is not available for this chat.',
    callback_text: 'Not available.',
  },
  post_denied: {
    message: \`Post \${postId} was not found. Wait for monitoring to flag it, then try again.\`,
    callback_text: 'Post not found.',
  },
  // Naming the valid slugs is safe here and nowhere else: /track is staff-only,
  // so this message can only ever reach a chat that is already allowed to act
  // across every client. It is not an oracle the way a post id would be.
  unknown_client: {
    message: availableSlugs
      ? \`No active client with slug "\${requestedSlug}". Active clients: \${availableSlugs}.\`
      : \`No active client with slug "\${requestedSlug}". There are no active clients yet -- create one with /client_new first.\`,
    callback_text: 'Unknown client.',
  },
};

const chosen = MESSAGES[refusal_reason] || MESSAGES.post_denied;

return [{
  json: {
    telegram_chat_id: auth.telegram_chat_id,
    callback_query_id: auth.callback_query_id || '',
    callback_message_id: auth.callback_message_id || '',
    post_id: postId,
    intent: auth.intent || '',
    command: auth.command || '',
    refusal_reason,
    denied_post_client_id: postExists ? String(post.client_id || '') : '',
    requested_client_slug: requestedSlug,
    caller_client_ids: auth.auth_client_ids || [],
    caller_is_staff: auth.auth_is_staff === true,
    message: chosen.message,
    callback_text: chosen.callback_text,
  },
}];`;

const RESTORE_CODE = `// Clear Telegram User Links and Deactivate Tracked Users For Chat both return
// Supabase rows, which do not carry the usersToTrack list that
// Split Users To Track needs. Re-emit the resolved payload so the tracking
// branch keeps its input, and keep pairedItem so downstream
// $('...').item lookups still resolve.
//
// T5: re-emits Build Track Client Result rather than Parse Users To Track, so
// the resolved client_id travels with the accounts instead of being looked up
// again further down.
return [{
  json: $('Build Track Client Result').first().json,
  pairedItem: { item: 0 },
}];`;

// --- the client-resolution scaffold, spliced into the /track branch ----------
// If Track Users Input Valid -[true]-> Resolve Track Client
//   -> Build Track Client Result -> If Track Client Known
//        [true]  -> Clear Telegram User Links (the original chain, unchanged)
//        [false] -> Build Access Refusal (reason unknown_client)
const PARSE_TRACK_CODE = `// T5: /track is staff-only and must name the client it is tracking FOR.
//
// The client token is LABELLED (client:<slug>), never positional. This parser
// accepts bare words as usernames, so a positional slug would make
// \`/track acme @foo\` genuinely ambiguous -- and tracking into the wrong client
// silently mis-files that client's monitoring, which nothing downstream would
// catch. The token is stripped BEFORE username extraction so the slug can
// never be read as a handle.
//
// There is deliberately NO default client. Omitting it refuses. The old
// behaviour derived ownership from the caller's chat and fell back to "the
// sole active client", which returns NULL the moment a second client exists
// (see set_tracked_user_client_id) -- guessing is the defect T5 removes.
const route = $('Parse Telegram Message').first().json;
const text = route.command_args || route.message_text || '';

const CLIENT_TOKEN = /(?:^|\\s)client[:=]([A-Za-z0-9][A-Za-z0-9_-]{0,48})(?=\\s|$)/i;
const clientMatch = text.match(CLIENT_TOKEN);
const client_slug = clientMatch ? clientMatch[1].toLowerCase() : '';

// Remove the client token first so it never becomes a username candidate.
const textWithoutClient = text.replace(new RegExp(CLIENT_TOKEN.source, 'gi'), ' ');

function normalizeUsername(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\\/\\/(?:www\\.)?(?:x|twitter)\\.com\\//i, '')
    .replace(/^@+/, '')
    .split(/[/?#]/)[0]
    .replace(/[^A-Za-z0-9_]/g, '')
    .toLowerCase();
}

const candidates = [];

for (const match of textWithoutClient.matchAll(/@([A-Za-z0-9_]{1,15})/g)) {
  candidates.push(match[1]);
}

for (const match of textWithoutClient.matchAll(/(?:https?:\\/\\/)?(?:www\\.)?(?:x|twitter)\\.com\\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/gi)) {
  candidates.push(match[1]);
}

let cleanedText = textWithoutClient
  .replace(/(?:https?:\\/\\/)?(?:www\\.)?(?:x|twitter)\\.com\\/[A-Za-z0-9_]{1,15}(?:[/?#][^\\s]*)?/gi, ' ')
  .replace(/@[A-Za-z0-9_]{1,15}/g, ' ')
  .replace(/^\\/track(?:@\\w+)?/i, ' ')
  .replace(/\\b(track|tracking|accounts?|users?|usernames?|x|twitter|please|pls|add|the|following|and|or|to|of|for|client)\\b/gi, ' ');

for (const part of cleanedText.split(/[\\s,;:]+/)) {
  candidates.push(part);
}

const reserved = new Set([
  'home', 'explore', 'notifications', 'messages', 'i', 'intent', 'search',
  'settings', 'compose', 'share', 'status', 'post', 'posts', 'reply', 'replies',
]);

const usersArray = [...new Set(
  candidates
    .map(normalizeUsername)
    .filter(user => /^[a-z0-9_]{1,15}$/.test(user))
    .filter(user => !reserved.has(user))
)];

const users_valid = usersArray.length > 0 && Boolean(client_slug);

// One invalid branch, two distinct causes -- the operator needs to know which.
let invalid_reason = '';
if (!client_slug && usersArray.length === 0) invalid_reason = 'no_client_and_no_users';
else if (!client_slug) invalid_reason = 'missing_client';
else if (usersArray.length === 0) invalid_reason = 'no_users';

return [{
  json: {
    users_valid,
    invalid_reason,
    client_slug,
    telegram_chat_id: route.telegram_chat_id,
    usersToTrack: users_valid ? usersArray.map(user => ({ user })) : [{ user: '' }],
    usernames: usersArray,
    message: '',
  },
}];`;

const scaffold = [
  {
    name: 'Resolve Track Client',
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.6,
    position: [-180, 1180],
    parameters: {
      operation: 'executeQuery',
      query: `-- T5: resolve the slug the staff caller typed to a real, ACTIVE client.
-- Always returns exactly one row, so an unknown slug is a null client_id
-- rather than an empty result -- the refusal path needs available_slugs to
-- tell the caller what they could have typed.
-- Both Supabase projects are shared with FB Monitor, so the table is named
-- explicitly.
select
  (select c.id::text from public."Clients" c where c.slug = $1 and c.is_active) as client_id,
  (select c.name    from public."Clients" c where c.slug = $1 and c.is_active) as client_name,
  coalesce((
    select string_agg(c.slug, ', ' order by c.slug)
      from public."Clients" c where c.is_active
  ), '') as available_slugs`,
      options: { queryReplacement: '={{ $json.client_slug }}' },
    },
    credentials: { postgres: { id: credId, name: credName } },
  },
  {
    name: 'Build Track Client Result',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [0, 1180],
    parameters: {
      jsCode: `// T5: merge the resolved client back onto the parsed /track payload, so one
// item carries both the accounts to track and the client that will own them.
// Fails closed: no row, or a row with a null client_id, means unresolved.
const parsed = $('Parse Users To Track').first().json;
const row = $input.first()?.json || {};

const client_id = String(row.client_id || '');
const track_client_resolved = client_id.length > 0;

const usernames = Array.isArray(parsed.usernames) ? parsed.usernames : [];
const client_name = String(row.client_name || '');

return [{
  json: {
    ...parsed,
    client_id,
    client_name,
    track_client_resolved,
    // Consumed by Build Access Refusal to distinguish an unknown client from
    // the T2 refusals, which must keep their existing messages verbatim.
    track_client_unresolved: !track_client_resolved,
    requested_client_slug: String(parsed.client_slug || ''),
    available_slugs: String(row.available_slugs || ''),
    // The success message names the client, so a mis-typed slug that happens
    // to resolve is still visible to the operator in the reply.
    message: \`Now tracking for \${client_name} (\${parsed.client_slug}):\\n- \${usernames.join('\\n- ')}\`,
  },
  pairedItem: { item: 0 },
}];`,
    },
  },
  {
    name: 'If Track Client Known',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: [180, 1180],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 3 },
        conditions: [
          {
            id: 'b0000000-0000-4000-8000-000000000001',
            leftValue: '={{ $json.track_client_resolved === true }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
  },
];

const operations = [
  { type: 'updateNodeParameters', nodeName: 'Parse Users To Track', parameters: { jsCode: PARSE_TRACK_CODE } },
];

for (const node of scaffold) {
  operations.push(
    existingNodes.has(node.name)
      ? { type: 'updateNodeParameters', nodeName: node.name, parameters: node.parameters, replace: true }
      : { type: 'addNode', node },
  );
}
operations.push({ type: 'setNodeSettings', nodeName: 'Resolve Track Client', settings: { alwaysOutputData: true } });

if (!existingNodes.has('Resolve Track Client')) {
  operations.push({ type: 'removeConnection', source: 'If Track Users Input Valid', target: 'Clear Telegram User Links', sourceIndex: 0 });
  operations.push({ type: 'addConnection', source: 'If Track Users Input Valid', target: 'Resolve Track Client', sourceIndex: 0 });
  operations.push({ type: 'addConnection', source: 'Resolve Track Client', target: 'Build Track Client Result' });
  operations.push({ type: 'addConnection', source: 'Build Track Client Result', target: 'If Track Client Known' });
  operations.push({ type: 'addConnection', source: 'If Track Client Known', target: 'Clear Telegram User Links', sourceIndex: 0 });
  operations.push({ type: 'addConnection', source: 'If Track Client Known', target: 'Build Access Refusal', sourceIndex: 1 });
}

operations.push(
  {
    type: 'updateNodeParameters',
    nodeName: 'Upsert Tracked X User',
    parameters: {
      operation: 'executeQuery',
      query: UPSERT_QUERY,
      options: {
        queryBatching: 'independently',
        queryReplacement:
          "={{ [$json.data.id, $json.data.username, $('Build Track Client Result').first().json.client_id] }}",
      },
    },
  },
  {
    // Name kept deliberately: three pinned fixtures reference it by name and
    // must keep passing. The scope is now the client, not the caller's chat.
    type: 'updateNodeParameters',
    nodeName: 'Deactivate Tracked Users For Chat',
    parameters: {
      operation: 'update',
      tableId: 'Tracked Users',
      filterType: 'manual',
      filters: {
        conditions: [
          {
            keyName: 'client_id',
            condition: 'eq',
            keyValue: "={{ $('Build Track Client Result').first().json.client_id }}",
          },
        ],
      },
      fieldsUi: { fieldValues: [{ fieldId: 'is_active', fieldValue: 'false' }] },
    },
  },
  { type: 'updateNodeParameters', nodeName: 'Build Access Refusal', parameters: { jsCode: REFUSAL_CODE } },
  { type: 'updateNodeParameters', nodeName: 'Restore Track User List', parameters: { jsCode: RESTORE_CODE } },
  {
    type: 'updateNodeParameters',
    nodeName: 'Send Tracking Success',
    parameters: {
      chatId: "={{ $('Parse Telegram Message').item.json.telegram_chat_id }}",
      text: "={{ $('Build Track Client Result').first().json.message }}",
      additionalFields: { appendAttribution: false, parse_mode: 'HTML' },
    },
  },
);

const res = await callTool('update_workflow', {
  workflowId,
  versionName: 'T5: re-key /track ownership to client_id',
  versionDescription:
    'Upsert writes client_id and guards on it; deactivate is client-scoped; refusal gains unknown_client; success names the client.',
  operations,
});

console.log(
  JSON.stringify(
    {
      workflowId: res.workflowId,
      name: res.name,
      nodeCount: res.nodeCount,
      appliedOperations: res.appliedOperations,
      autoAssignedCredentials: res.autoAssignedCredentials,
      newWarnings: (res.validationWarnings || []).filter((w) => !w.preExisting),
    },
    null,
    2,
  ),
);
