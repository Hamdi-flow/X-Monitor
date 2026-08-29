#!/usr/bin/env node
/**
 * Phase T3 - per-client alert routing for the Scheduled Post Tracking schedulers.
 *
 *   node scripts/apply-t3-alert-routing.mjs <workflow.json> [--env prod|staging] [--check]
 *
 * Applies the T3 edit to a scheduler export in place. It is written as a
 * transformation rather than a hand-edited JSON blob so it can be re-applied to a
 * freshly pulled live export -- CLAUDE.md's rule is that live n8n is the truth and
 * local exports drift, so the edit has to survive being rebased onto a newer base.
 *
 * Every step is idempotent: re-running on an already-migrated file is a no-op and
 * reports "already applied". --check exits 1 if anything would change.
 *
 * What it changes, and nothing else:
 *   1. Get Tracked Users            Supabase getAll -> Postgres join onto "Clients",
 *                                   so each tracked user carries its client's thresholds.
 *   2. Filter Suppressed Posts      attaches client_id + thresholds to every post.
 *   3. Keep Posts With 10+ Replies  hardcoded 10 -> the post's own client_min_replies.
 *   4. Attach replies to posts      emits post_client_map, deliberately OUTSIDE `text`
 *                                   so the OpenAI payload is byte-identical to before.
 *   5. Calculate/Filter Sentiment   hardcoded 0.5 -> the post's own negative_threshold.
 *   6. Get Telegram Users           -> Get Alert Recipients, resolving Client Members
 *                                   for the owners of this pass's alerting posts.
 *   7. Build Negative Alert Notif.  one alert per recipient per post, grouped by owner;
 *                                   per-client NO_TELEGRAM_RECIPIENTS instead of global.
 *   8. Build Scheduler Dev Alert    names the client on a per-client failure.
 *   9. Get Reply Status Counts    executeOnce, the matched half of step 7 (see the
 *                                   workflow doc: removing executeOnce from the
 *                                   builder alone sends one message per reply).
 *
 * Explicitly NOT changed: the incremental replies query, the 15-conversation
 * chunking, per-reply sentiment storage, and all three watermark paths.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const DEFAULT_MIN_REPLIES = 10;
const DEFAULT_NEGATIVE_THRESHOLD = 0.5;

const CREDENTIALS = {
  prod: { id: 'Usl8p3UJw2s7aMMe', name: 'Supabase Account' },
  staging: { id: 'CyXakOvvENeDwRue', name: 'Supabase Staging Postgres' },
};

// ---------------------------------------------------------------- SQL

const TRACKED_USERS_SQL = `-- T3: tracked users carry their client's alert thresholds, so every downstream
-- decision is made per client instead of against a constant.
--
-- "Clients" is JOINed but NOT filtered on c.is_active: deactivating a client must
-- not silently stop collecting its posts. An inactive client is dropped at delivery
-- instead -- see Get Alert Recipients -- so the data keeps flowing and only the
-- Telegram fan-out stops.
--
-- Both Supabase projects are shared with the sibling FB Monitor project, so every
-- table is named explicitly.
SELECT
  tu.user_id,
  tu.username,
  tu.display_name,
  tu.telegram_chat_id,
  tu.is_active,
  tu.client_id::text            AS client_id,
  c.slug                        AS client_slug,
  c.name                        AS client_name,
  c.min_replies::int            AS client_min_replies,
  -- numeric would arrive as the string '0.50' and break a strict-typed compare.
  c.negative_threshold::float8  AS client_negative_threshold,
  c.lookback_days::int          AS client_lookback_days
FROM public."Tracked Users" tu
JOIN public."Clients" c ON c.id = tu.client_id
WHERE tu.is_active
ORDER BY tu.user_id;`;

const ALERT_RECIPIENTS_SQL = `-- T3: recipients resolved per post owner. This replaces the unfiltered read of
-- "Telegram Users", which handed every recipient every client's post text and
-- reply counts the moment a second chat existed.
--
-- A chat receives a post only when it is an active, alert-receiving member of the
-- client that owns that post.
--
-- LEFT JOIN, not INNER, on purpose: a client that has alerting posts but no
-- eligible member must still produce a row, so Build Negative Alert Notification
-- can raise a developer alert naming it rather than dropping the alert in silence.
-- c.is_active is applied here, so a deactivated client stops receiving Telegram
-- alerts while its posts continue to be collected and stored.
--
-- "Telegram Users" is deliberately no longer read. The Telegram router still
-- writes it, so the table stays in place; retiring it is a later cleanup.
WITH requested AS (
  SELECT DISTINCT unnest($1::uuid[]) AS client_id
)
SELECT
  requested.client_id::text AS client_id,
  c.name                    AS client_name,
  c.slug                    AS client_slug,
  cm.chat_id,
  cm.label,
  cm.role
FROM requested
LEFT JOIN public."Clients" c
  ON c.id = requested.client_id
 AND c.is_active
LEFT JOIN public."Client Members" cm
  ON cm.client_id = c.id
 AND cm.is_active
 AND cm.receives_alerts
ORDER BY requested.client_id, cm.chat_id;`;

// The uuid guard matters: an unparseable client_id would abort the whole pass at
// the ::uuid cast, turning one bad row into a total alert outage. Filtered out
// here, such a post falls through to the "owner did not resolve" developer alert.
const ALERT_RECIPIENTS_REPLACEMENT =
  "={{ [[...new Set($('Split Out Reply Analysis').all()" +
  '.filter(item => item.json.alert_now)' +
  '.map(item => String(item.json.client_id || ""))' +
  '.filter(value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)))]] }}';

// ---------------------------------------------------------------- code bodies

const BUILD_ALERT_CODE = `// Storage is no longer gated on the threshold, so the alert gate lives here.
//
// T3: alerts are routed per client. A post reaches exactly the chats that are
// active, alert-receiving members of the client that owns it, and never the whole
// recipient table. Input is Get Alert Recipients, not the retired Telegram Users.
const posts = $('Split Out Reply Analysis').all()
  .map(item => item.json || {})
  .filter(post => post.alert_now);

const replyCountsByPostId = new Map(
  $('Get Reply Status Counts').all().map(item => {
    const row = item.json || {};
    return [String(row.post_id || ''), {
      hiddenNegative: Number(row.hidden_negative_replies_count || 0),
      nonHiddenNegative: Number(row.non_hidden_negative_replies_count || 0),
    }];
  })
);

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

if (posts.length === 0) { return []; }

// Recipients grouped by client. Get Alert Recipients LEFT JOINs, so a client with
// no eligible member arrives as a row with a null chat_id -- that is how a
// misconfigured client is detected instead of silently skipped.
//
// Dedupe by (client, chat) defensively. The query runs executeOnce, but a repeated
// pair must never become a repeated alert.
const recipientsByClient = new Map();
const clientNameById = new Map();
const seenRecipients = new Set();
for (const item of $input.all()) {
  const row = item.json || {};
  const clientId = String(row.client_id || '');
  if (!clientId) { continue; }
  if (!recipientsByClient.has(clientId)) { recipientsByClient.set(clientId, []); }
  if (row.client_name) { clientNameById.set(clientId, String(row.client_name)); }

  const chatId = String(row.chat_id || '');
  if (!chatId) { continue; }
  const key = clientId + '|' + chatId;
  if (seenRecipients.has(key)) { continue; }
  seenRecipients.add(key);
  recipientsByClient.get(clientId).push({
    chat_id: chatId,
    label: String(row.label || ''),
    role: String(row.role || ''),
  });
}

// Posts grouped by owner. An empty client_id means the owner did not resolve
// upstream; such a post is reported to the developer chat, never broadcast.
const postsByClient = new Map();
for (const post of posts) {
  const clientId = String(post.client_id || '');
  if (!postsByClient.has(clientId)) { postsByClient.set(clientId, []); }
  postsByClient.get(clientId).push(post);
}

function describeClient(clientId) {
  if (!clientId) { return 'an unresolved client (the post owner did not resolve)'; }
  const name = clientNameById.get(clientId);
  return name ? name + ' (' + clientId + ')' : clientId;
}

function buildAlert(clientId, recipient, post, index) {
  const postId = String(post.postId || '');
  const counts = replyCountsByPostId.get(postId) || {};
  const text = escapeHtml(post.postText || '');
  const author = escapeHtml(post.postAuthor || post.authorUsername || post.userId || 'unknown');
  const totalReplies = Number(post.total_reply_count ?? post.comments_count ?? 0);
  const analyzedReplies = Number(post.analyzed_count ?? post.comments_count ?? 0);
  const negativeCount = Number(post.negative_count ?? 0);
  const hiddenNegativeReplies = Number(counts.hiddenNegative ?? 0);
  const nonHiddenNegativeReplies = Number(counts.nonHiddenNegative ?? Math.max(negativeCount - hiddenNegativeReplies, 0));
  const negativePercentage = post.negative_percentage ?? 0;
  const overall = escapeHtml(post.overall_tag || 'Negative');
  const tweetUrl = 'https://x.com/i/web/status/' + postId;
  const message = [
    '<b>XMonitor Scheduled Post Alert</b>',
    '',
    '<b>Post ' + (index + 1) + '</b>',
    'Author: ' + author,
    'Post ID: <code>' + postId + '</code>',
    'Link: ' + tweetUrl,
    '',
    '<b>Key Metrics</b>',
    'Total replies: ' + totalReplies,
    'Analyzed replies: ' + analyzedReplies,
    'Negative replies: ' + negativeCount,
    'Hidden negative replies: ' + hiddenNegativeReplies,
    'Visible negative replies: ' + nonHiddenNegativeReplies,
    'Negative sentiment: ' + negativePercentage + '%',
    'Overall sentiment: ' + overall,
    '',
    '<b>Post Text</b>',
    text || '(empty)',
  ].join('\\n');
  return { json: {
    notify_ready: true,
    chat_id: recipient.chat_id,
    client_id: clientId,
    post_id: postId,
    message,
    snooze_button_text: 'Snooze',
    snooze_callback_data: 'snooze:' + postId,
    ignore_button_text: 'Ignore',
    ignore_callback_data: 'ignore:' + postId,
    hide_button_text: 'Hide replies for Post #' + (index + 1),
    hide_callback_data: 'hide_replies:' + postId,
  } };
}

const out = [];
for (const [clientId, clientPosts] of postsByClient) {
  const recipients = recipientsByClient.get(clientId) || [];

  if (recipients.length === 0) {
    // Per client, not global. This is pushed alongside the other clients' alerts
    // rather than returned early, so one client's misconfiguration cannot suppress
    // another client's alerts. If Notifications Ready routes it to the developer
    // chat on the false branch while the true branch still sends.
    out.push({ json: {
      notify_ready: false,
      scheduler_alert_type: 'NO_TELEGRAM_RECIPIENTS',
      client_id: clientId,
      client_name: clientNameById.get(clientId) || '',
      post_count: clientPosts.length,
      post_ids: clientPosts.map(post => String(post.postId || '')).filter(Boolean),
      message: 'Scheduled tracking generated ' + clientPosts.length +
        ' negative alert post(s) for ' + describeClient(clientId) +
        ', but that client has no active "Client Members" row with receives_alerts.' +
        ' Those alerts were not sent. Other clients were unaffected.',
    } });
    continue;
  }

  for (const recipient of recipients) {
    clientPosts.forEach((post, index) => {
      out.push(buildAlert(clientId, recipient, post, index));
    });
  }
}

return out;`;

// Inserted surgically rather than replacing the body: production and staging carry
// different header strings ("XMonitor production handled error" vs "... staging ...")
// and overwriting either with the other's text would regress the labels.
const DEV_ALERT_CLIENT_LINE = `const data = $json || {};
// T3: NO_TELEGRAM_RECIPIENTS is raised per client now, so the alert has to say
// which client is misconfigured -- a bare count is unactionable past one client.
const clientLine = (data.client_id || data.client_name)
  ? 'Client: ' + [data.client_name, data.client_id].filter(Boolean).join(' ')
  : '';
`;

// ---------------------------------------------------------------- helpers

const changes = [];
const skipped = [];

function node(wf, name) {
  const found = wf.nodes.find((n) => n.name === name);
  if (!found) throw new Error(`node not found: ${name}`);
  return found;
}

function has(wf, name) {
  return wf.nodes.some((n) => n.name === name);
}

/** Insert `addition` into `code` immediately before `anchor`, once. */
function insertBefore(code, anchor, addition, marker) {
  if (code.includes(marker)) return null;
  const at = code.indexOf(anchor);
  if (at === -1) throw new Error(`anchor not found: ${anchor.slice(0, 60)}`);
  return code.slice(0, at) + addition + code.slice(at);
}

function replaceOnce(code, from, to) {
  if (!code.includes(from)) throw new Error(`text not found: ${from.slice(0, 80)}`);
  return code.replace(from, to);
}

// ---------------------------------------------------------------- steps

function step1TrackedUsers(wf, cred) {
  const n = node(wf, 'Get Tracked Users');
  if (n.type === 'n8n-nodes-base.postgres') { skipped.push('1 Get Tracked Users'); return; }
  n.type = 'n8n-nodes-base.postgres';
  n.typeVersion = 2.6;
  n.parameters = {
    operation: 'executeQuery',
    query: TRACKED_USERS_SQL,
    options: { queryBatching: 'single' },
  };
  // Preserved from the Supabase node: with zero tracked users the pass must still
  // reach Build X API Query so it can raise NO_TRACKED_USERS and take the quiet
  // path, rather than dying with no output and never advancing the watermark.
  n.alwaysOutputData = true;
  n.credentials = { postgres: { id: cred.id, name: cred.name } };
  n.notes = 'T3: joins "Clients" so each tracked user carries its client thresholds.';
  changes.push('1 Get Tracked Users -> Postgres join onto "Clients"');
}

function step2FilterSuppressed(wf) {
  const n = node(wf, 'Filter Suppressed Posts');
  let code = n.parameters.jsCode;
  if (code.includes('client_min_replies')) { skipped.push('2 Filter Suppressed Posts'); return; }

  code = replaceOnce(
    code,
    'const state = ',
    `// T3 fallbacks. These are the pre-T3 constants: if a post's client cannot be
// resolved the post behaves exactly as it did before T3 rather than alerting on
// everything. It is then reported by Build Negative Alert Notification.
const DEFAULT_MIN_REPLIES = ${DEFAULT_MIN_REPLIES};
const DEFAULT_NEGATIVE_THRESHOLD = ${DEFAULT_NEGATIVE_THRESHOLD};

const state = `
  );

  code = replaceOnce(
    code,
    `        post_author: username ? \`@\${username}\` : (name || String(item.json.author_id || 'unknown')),`,
    `        post_author: username ? \`@\${username}\` : (name || String(item.json.author_id || 'unknown')),
        // T3: the owning client rides along with the post from here on, so the
        // reply-count gate, the sentiment gate and the alert fan-out can each be
        // decided per client instead of against a global constant.
        client_id: String(tracked.client_id || ''),
        client_slug: String(tracked.client_slug || ''),
        client_name: String(tracked.client_name || ''),
        client_min_replies: Number.isFinite(Number(tracked.client_min_replies))
          ? Number(tracked.client_min_replies)
          : DEFAULT_MIN_REPLIES,
        client_negative_threshold: Number.isFinite(Number(tracked.client_negative_threshold))
          ? Number(tracked.client_negative_threshold)
          : DEFAULT_NEGATIVE_THRESHOLD,`
  );

  n.parameters.jsCode = code;
  changes.push('2 Filter Suppressed Posts -> carries client_id + thresholds');
}

function step3MinReplies(wf) {
  const n = node(wf, 'Keep Posts With 10+ Replies');
  const condition = n.parameters.conditions.conditions[0];
  if (condition.rightValue === '={{ $json.client_min_replies }}') { skipped.push('3 Keep Posts With 10+ Replies'); return; }
  condition.rightValue = '={{ $json.client_min_replies }}';
  // The node name is deliberately left alone. Attach replies to posts and every
  // pinned fixture reference it by name, and a rename buys nothing but risk.
  n.notes = 'T3: the threshold is the post\'s own client min_replies, not a constant. Name kept for the $() references and pinned fixtures.';
  changes.push('3 Keep Posts With 10+ Replies -> per-client min_replies');
}

function step4AttachReplies(wf) {
  const n = node(wf, 'Attach replies to posts');
  let code = n.parameters.jsCode;
  const marker = 'const post_client_map';
  const addition = `// T3: which client owns each post, and its thresholds. Built as a separate map
// and deliberately kept OUT of \`results\`/\`text\`, because \`text\` is the OpenAI
// prompt payload -- tenancy ids have no business in it, and adding them would
// change the prompt, its cost, and the model's input for no gain.
const post_client_map = {};
for (const item of $('Keep Posts With 10+ Replies').all()) {
  const row = item.json || {};
  const postId = String(row.id || '');
  if (!postId) continue;
  post_client_map[postId] = {
    client_id: String(row.client_id || ''),
    client_slug: String(row.client_slug || ''),
    client_name: String(row.client_name || ''),
    min_replies: Number(row.client_min_replies ?? ${DEFAULT_MIN_REPLIES}),
    negative_threshold: Number(row.client_negative_threshold ?? ${DEFAULT_NEGATIVE_THRESHOLD}),
  };
}

`;
  const inserted = insertBefore(code, 'const allPosts = [...postsByConversation.values()];', addition, marker);
  if (inserted === null) { skipped.push('4 Attach replies to posts'); return; }
  code = replaceOnce(inserted, '    candidate_post_ids:', '    post_client_map,\n    candidate_post_ids:');
  n.parameters.jsCode = code;
  changes.push('4 Attach replies to posts -> emits post_client_map');
}

function step5Threshold(wf) {
  const n = node(wf, 'Calculate/Filter Sentiment Counts');
  let code = n.parameters.jsCode;
  if (code.includes('DEFAULT_ALERT_THRESHOLD')) { skipped.push('5 Calculate/Filter Sentiment Counts'); return; }

  code = replaceOnce(
    code,
    `const ALERT_THRESHOLD = ${DEFAULT_NEGATIVE_THRESHOLD};`,
    `// T3: the alert threshold is per client now. This constant survives only as the
// fallback for a post whose client did not resolve, and equals the pre-T3 value.
const DEFAULT_ALERT_THRESHOLD = ${DEFAULT_NEGATIVE_THRESHOLD};`
  );

  // Anchored on the storedByPostId comment rather than on the node reference just
  // below it: staging reads $('Apply Media Sentiment') where production reads
  // $('Analyze Sentiment with ChatGPT'), and this anchor is common to both.
  code = replaceOnce(
    code,
    '// Counts from replies scored in earlier passes.',
    `// T3: per-post client thresholds, carried alongside the post rather than inside
// the model payload. See Attach replies to posts.
const clientByPostId = $('Attach replies to posts').first()?.json?.post_client_map || {};

// Counts from replies scored in earlier passes.`
  );

  code = replaceOnce(
    code,
    "    const stored = storedByPostId.get(postId) || { analyzed: 0, negative: 0, positive: 0, neutral: 0 };",
    `    const stored = storedByPostId.get(postId) || { analyzed: 0, negative: 0, positive: 0, neutral: 0 };
    const client = clientByPostId[postId] || {};
    const clientThreshold = Number(client.negative_threshold);
    const alert_threshold = Number.isFinite(clientThreshold) ? clientThreshold : DEFAULT_ALERT_THRESHOLD;`
  );

  code = replaceOnce(
    code,
    `      // Storage is no longer gated on the threshold - only alerting is.
      alert_now: negative_ratio >= ALERT_THRESHOLD,`,
    `      // T3: the owning client travels with the post so the alert fan-out can route
      // on it without re-querying, and so execution data shows who a post was for.
      client_id: String(client.client_id || ''),
      client_slug: String(client.client_slug || ''),
      client_name: String(client.client_name || ''),
      alert_threshold,
      // Storage is no longer gated on the threshold - only alerting is.
      alert_now: negative_ratio >= alert_threshold,`
  );

  n.parameters.jsCode = code;
  changes.push('5 Calculate/Filter Sentiment Counts -> per-client negative_threshold');
}

function step6Recipients(wf, cred) {
  if (has(wf, 'Get Alert Recipients')) { skipped.push('6 Get Alert Recipients'); return; }
  const n = node(wf, 'Get Telegram Users');
  n.name = 'Get Alert Recipients';
  n.type = 'n8n-nodes-base.postgres';
  n.typeVersion = 2.6;
  n.parameters = {
    operation: 'executeQuery',
    query: ALERT_RECIPIENTS_SQL,
    options: { queryBatching: 'single', queryReplacement: ALERT_RECIPIENTS_REPLACEMENT },
  };
  // Its parameters come from $('Split Out Reply Analysis'), not from $json, so it
  // must run exactly once however many items Get Reply Status Counts emitted.
  // Without this the recipient set is multiplied by the alerting-post count.
  n.executeOnce = true;
  // With no alerting posts the query returns nothing; the builder still has to run
  // so it can return [] cleanly rather than leaving the branch dead.
  n.alwaysOutputData = true;
  n.credentials = { postgres: { id: cred.id, name: cred.name } };
  n.notes = 'T3: replaces the unfiltered "Telegram Users" read. The router still writes that table; it is simply no longer a routing source.';

  // Rename in the connection graph, both as a source key and as a target.
  if (wf.connections['Get Telegram Users']) {
    wf.connections['Get Alert Recipients'] = wf.connections['Get Telegram Users'];
    delete wf.connections['Get Telegram Users'];
  }
  for (const outputs of Object.values(wf.connections)) {
    for (const branches of Object.values(outputs)) {
      for (const branch of branches || []) {
        for (const link of branch || []) {
          if (link.node === 'Get Telegram Users') link.node = 'Get Alert Recipients';
        }
      }
    }
  }
  changes.push('6 Get Telegram Users -> Get Alert Recipients (Client Members)');
}

function step7BuildAlert(wf) {
  const n = node(wf, 'Build Negative Alert Notification');
  if (n.parameters.jsCode.includes('recipientsByClient')) { skipped.push('7 Build Negative Alert Notification'); return; }
  n.parameters.jsCode = BUILD_ALERT_CODE;
  // executeOnce truncates input to the FIRST item. Harmless while there was one
  // recipient row; with per-client routing it would silently drop every recipient
  // but one. The node is already runOnceForAllItems, so removing the flag changes
  // nothing except that it now sees the whole recipient set.
  delete n.executeOnce;
  n.notes = 'T3: one alert per recipient per post, grouped by the post owner. Per-client NO_TELEGRAM_RECIPIENTS.';
  changes.push('7 Build Negative Alert Notification -> per-client fan-out (executeOnce removed)');
}

function step8DevAlert(wf) {
  const n = node(wf, 'Build Scheduler Developer Alert');
  let code = n.parameters.jsCode;
  if (code.includes('clientLine')) { skipped.push('8 Build Scheduler Developer Alert'); return; }
  code = replaceOnce(code, 'const data = $json || {};\n', DEV_ALERT_CLIENT_LINE);
  code = replaceOnce(
    code,
    "`Path: ${data.scheduler_alert_type || 'scheduler validation'}`,",
    "`Path: ${data.scheduler_alert_type || 'scheduler validation'}`,clientLine,"
  );
  n.parameters.jsCode = code;
  changes.push('8 Build Scheduler Developer Alert -> names the client');
}

function step9ReplyCountsExecuteOnce(wf) {
  const n = node(wf, 'Get Reply Status Counts');
  if (n.executeOnce === true) { skipped.push('9 Get Reply Status Counts'); return; }
  // The other half of the matched pair documented in
  // docs/workflows/xmonitor-scheduled-post-tracking.md. Removing executeOnce from
  // Build Negative Alert Notification (step 7) is only safe once the lookups that
  // feed it stop fanning out per input item: Insert or update replies emits one
  // item per reply, and this node reads none of its own input -- it takes its post
  // ids from $('Split Out Reply Analysis'). Shipping step 7 alone would send one
  // message per reply. Get Alert Recipients is created with the same flag.
  n.executeOnce = true;
  changes.push('9 Get Reply Status Counts -> executeOnce (matched pair with step 7)');
}

// ---------------------------------------------------------------- main

const [, , file, ...rest] = process.argv;
if (!file) {
  console.error('usage: node scripts/apply-t3-alert-routing.mjs <workflow.json> [--env prod|staging] [--check]');
  process.exit(2);
}
const check = rest.includes('--check');
const envIndex = rest.indexOf('--env');
const env = envIndex === -1
  ? (file.includes('staging') ? 'staging' : 'prod')
  : rest[envIndex + 1];
const cred = CREDENTIALS[env];
if (!cred) { console.error(`unknown --env ${env}`); process.exit(2); }

const before = readFileSync(file, 'utf8');
const wf = JSON.parse(before);

step1TrackedUsers(wf, cred);
step2FilterSuppressed(wf);
step3MinReplies(wf);
step4AttachReplies(wf);
step5Threshold(wf, cred);
step6Recipients(wf, cred);
step7BuildAlert(wf);
step8DevAlert(wf);
step9ReplyCountsExecuteOnce(wf);

const after = JSON.stringify(wf, null, 2) + '\n';

console.log(`${file}  [${env}]`);
for (const c of changes) console.log(`  applied  ${c}`);
for (const s of skipped) console.log(`  already  ${s}`);

if (check) {
  process.exit(changes.length ? 1 : 0);
}
if (changes.length) {
  writeFileSync(file, after);
  console.log(`  written  ${changes.length} change(s)`);
} else {
  console.log('  no change');
}
