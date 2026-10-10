// Phase T3 - per-client alert routing.
//
// Executes the real Code-node bodies out of both scheduler exports against two
// synthetic clients and asserts the T3 acceptance table. This does NOT replace the
// pinned staging run -- it cannot prove wiring, credentials or the publish state --
// but it does prove the routing logic itself, and it runs with no n8n access.
//
//   node tests/n8n/t3-alert-routing.test.mjs
//
// Structural assertions cover the "must not regress" list: the watermark gates, the
// incremental replies query and the 15-conversation chunking are asserted untouched.

import assert from 'node:assert/strict';
import fs from 'node:fs';

const EXPORTS = [
  ['production', 'workflows/active/xmonitor-scheduled-post-tracking.json'],
  ['staging', 'workflows/staging/xmonitor-scheduled-post-tracking-staging.json'],
];

const CLIENT_A = '11111111-1111-4111-8111-111111111111';
const CLIENT_B = '22222222-2222-4222-8222-222222222222';

let passed = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push(`${label}\n    ${error.message.split('\n')[0]}`);
  }
}

/** Run an n8n Code node body with a fake $() / $input, as the sibling tests do. */
function runCode(jsCode, { lookup = {}, input = [] } = {}) {
  const $ = (name) => {
    if (!(name in lookup)) throw new Error(`unexpected $('${name}')`);
    return { all: () => lookup[name], first: () => lookup[name][0] };
  };
  const $input = { all: () => input };
  return new Function('$', '$input', `return (() => { ${jsCode} })();`)($, $input);
}

for (const [envName, path] of EXPORTS) {
  const workflow = JSON.parse(fs.readFileSync(path, 'utf8'));
  const node = (name) => {
    const found = workflow.nodes.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`missing node: ${name}`);
    return found;
  };
  const label = (name) => `[${envName}] ${name}`;

  // ---------------------------------------------------------------- structure

  check(label('"Telegram Users" is no longer a routing source'), () => {
    // Comments are stripped first: the replacement nodes deliberately explain in
    // prose why the table is no longer read, and that prose must not fail this.
    const stripComments = (text) => String(text)
      .split('\n')
      .filter((line) => !/^\s*(--|\/\/)/.test(line))
      .join('\n');

    const readers = workflow.nodes.filter((n) => {
      if (n.parameters?.tableId === 'Telegram Users') return true;
      const executable = [n.parameters?.query, n.parameters?.jsCode]
        .filter(Boolean)
        .map(stripComments)
        .join('\n');
      return executable.includes('Telegram Users');
    });
    assert.deepEqual(readers.map((n) => n.name), [], 'a node still reads "Telegram Users"');
    assert.equal(workflow.nodes.find((n) => n.name === 'Get Telegram Users'), undefined);
  });

  check(label('Get Alert Recipients resolves Client Members, runs once, always outputs'), () => {
    const n = node('Get Alert Recipients');
    assert.equal(n.type, 'n8n-nodes-base.postgres');
    assert.match(n.parameters.query, /"Client Members"/);
    assert.match(n.parameters.query, /cm\.is_active/);
    assert.match(n.parameters.query, /cm\.receives_alerts/);
    assert.match(n.parameters.query, /LEFT JOIN/, 'must LEFT JOIN so a client with no recipient still yields a row');
    // Its parameters come from $('Split Out Reply Analysis'), not $json: running per
    // input item would multiply the recipient set by the alerting-post count.
    assert.equal(n.executeOnce, true);
    assert.equal(n.alwaysOutputData, true);
  });

  check(label('Get Tracked Users carries per-client thresholds'), () => {
    const n = node('Get Tracked Users');
    assert.equal(n.type, 'n8n-nodes-base.postgres');
    assert.match(n.parameters.query, /"Clients"/);
    assert.match(n.parameters.query, /negative_threshold::float8/, 'numeric would arrive as a string');
    assert.equal(n.alwaysOutputData, true, 'zero tracked users must still reach NO_TRACKED_USERS');
  });

  check(label('min_replies is per client, not the hardcoded 10'), () => {
    const condition = node('Keep Posts With 10+ Replies').parameters.conditions.conditions[0];
    assert.equal(condition.rightValue, '={{ $json.client_min_replies }}');
  });

  check(label('the executeOnce matched pair is complete'), () => {
    // executeOnce truncates a Code node's input to the FIRST item, which would drop
    // every recipient but one the moment routing produces more than one.
    assert.notEqual(node('Build Negative Alert Notification').executeOnce, true);
    // ...but removing it there is only safe once both input-independent lookups stop
    // fanning out per input item. Insert or update replies emits one item per reply,
    // so shipping half this pair sends one Telegram message per reply.
    assert.equal(node('Get Reply Status Counts').executeOnce, true);
    assert.equal(node('Get Alert Recipients').executeOnce, true);
  });

  check(label('client ids never enter the OpenAI payload'), () => {
    const code = node('Attach replies to posts').parameters.jsCode;
    const resultsBlock = code.slice(code.indexOf('const postsByConversation'), code.indexOf('const replyPages'));
    assert.ok(!/client/i.test(resultsBlock), 'post_client_map must stay out of `text`');
    assert.match(code, /post_client_map/);
  });

  // ------------------------------------------------- must-not-regress guards

  check(label('watermark: truncated pass still gated on fetch_truncated'), () => {
    const gate = node('If Safe To Advance Watermark').parameters.conditions.conditions;
    assert.ok(JSON.stringify(gate).includes('fetch_truncated'));
    const gate2 = node('If Safe To Advance Watermark (Analyzed)').parameters.conditions.conditions;
    assert.ok(JSON.stringify(gate2).includes('fetch_truncated'));
  });

  check(label('watermark: both writers still reachable, neither from the OpenAI error branch'), () => {
    const quiet = workflow.connections['If Safe To Advance Watermark'].main[0][0].node;
    assert.equal(quiet, 'Advance Run State (Quiet Pass)');
    const active = workflow.connections['If Safe To Advance Watermark (Analyzed)'].main[0][0].node;
    assert.equal(active, 'Advance Run State');
    // The sentiment failure path reaches only the dev alert. Production: the batched
    // analyzer's error output (1) goes to the probe. Staging classifies per reply
    // (2026-10-10): Collect Sentiment Labels -> If Any Classification Failed -> probe,
    // and the analyzed watermark gate also holds on classification_failed_count.
    if (envName === 'staging') {
      const failedBranch = workflow.connections['If Any Classification Failed'].main[0][0].node;
      assert.equal(failedBranch, 'Probe OpenAI Error Reason');
      const gate = node('If Safe To Advance Watermark (Analyzed)').parameters.conditions.conditions;
      assert.ok(JSON.stringify(gate).includes('classification_failed_count'), 'a failed reply must hold the watermark');
    } else {
      const errorBranch = workflow.connections['Analyze Sentiment with ChatGPT'].main[1][0].node;
      assert.equal(errorBranch, 'Probe OpenAI Error Reason');
    }
  });

  check(label('incremental replies query and 15-conversation chunking untouched'), () => {
    const code = node('Build Replies Query').parameters.jsCode;
    assert.match(code, /15/, 'chunk size must still be 15 conversations');
    assert.match(node('Get Analyzed Reply Ids').parameters.query, /analyzed_at/);
  });

  check(label('per-reply sentiment storage untouched'), () => {
    const assignments = node('Prepare Reply Data').parameters.assignments.assignments;
    const names = assignments.map((a) => a.name);
    assert.ok(names.includes('sentiment'), 'every reply still stores its label');
  });

  // ------------------------------------------------------ behavioural table

  const builderCode = node('Build Negative Alert Notification').parameters.jsCode;

  const post = (postId, clientId, overrides = {}) => ({
    json: {
      postId,
      client_id: clientId,
      postText: `post ${postId}`,
      postAuthor: '@someone',
      alert_now: true,
      negative_count: 6,
      analyzed_count: 10,
      total_reply_count: 12,
      negative_percentage: 60,
      overall_tag: 'Negative',
      ...overrides,
    },
  });
  const recipient = (clientId, chatId, clientName) => ({
    json: { client_id: clientId, chat_id: chatId, client_name: clientName, label: 'chat', role: 'client' },
  });
  const orphanClient = (clientId, clientName) => ({
    json: { client_id: clientId, chat_id: null, client_name: clientName, label: null, role: null },
  });

  const build = (posts, recipients) => runCode(builderCode, {
    lookup: {
      'Split Out Reply Analysis': posts,
      'Get Reply Status Counts': [],
    },
    input: recipients,
  });

  const sends = (out) => out.filter((i) => i.json.notify_ready);
  const devAlerts = (out) => out.filter((i) => !i.json.notify_ready);

  check(label('case 1: client A post crosses -> chat A only'), () => {
    const out = build([post('101', CLIENT_A)], [recipient(CLIENT_A, 'chatA', 'Client A')]);
    assert.deepEqual(sends(out).map((i) => i.json.chat_id), ['chatA']);
    assert.deepEqual(devAlerts(out), []);
  });

  check(label('case 2: client B post crosses -> chat B only'), () => {
    const out = build([post('202', CLIENT_B)], [recipient(CLIENT_B, 'chatB', 'Client B')]);
    assert.deepEqual(sends(out).map((i) => i.json.chat_id), ['chatB']);
  });

  check(label('case 3: both cross in one pass -> each chat gets only its own'), () => {
    const out = build(
      [post('101', CLIENT_A), post('202', CLIENT_B)],
      [recipient(CLIENT_A, 'chatA', 'Client A'), recipient(CLIENT_B, 'chatB', 'Client B')]
    );
    const byChat = {};
    for (const item of sends(out)) (byChat[item.json.chat_id] ??= []).push(item.json.post_id);
    assert.deepEqual(byChat, { chatA: ['101'], chatB: ['202'] });
  });

  check(label('case 4: client B has no active recipient -> B named, A still sends'), () => {
    const out = build(
      [post('101', CLIENT_A), post('202', CLIENT_B)],
      [recipient(CLIENT_A, 'chatA', 'Client A'), orphanClient(CLIENT_B, 'Client B')]
    );
    assert.deepEqual(sends(out).map((i) => i.json.chat_id), ['chatA'], "A's alert must still send");
    const alerts = devAlerts(out);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].json.scheduler_alert_type, 'NO_TELEGRAM_RECIPIENTS');
    assert.equal(alerts[0].json.client_id, CLIENT_B);
    assert.match(alerts[0].json.message, /Client B/);
    assert.deepEqual(alerts[0].json.post_ids, ['202']);
  });

  check(label('case 5: receives_alerts = false -> receives nothing'), () => {
    // The query filters on cm.receives_alerts, so such a member never appears as a
    // row with a chat_id. The client arrives orphaned instead.
    const out = build([post('202', CLIENT_B)], [orphanClient(CLIENT_B, 'Client B')]);
    assert.deepEqual(sends(out), []);
    assert.equal(devAlerts(out).length, 1);
  });

  check(label('a client entirely absent from the recipient set still alerts the dev chat'), () => {
    const out = build([post('303', CLIENT_B)], []);
    const alerts = devAlerts(out);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].json.client_id, CLIENT_B);
  });

  check(label('an unresolved post owner is reported, never broadcast'), () => {
    const out = build([post('404', '')], [recipient(CLIENT_A, 'chatA', 'Client A')]);
    assert.deepEqual(sends(out), [], 'must not fall back to some other client\'s chat');
    assert.match(devAlerts(out)[0].json.message, /unresolved client/);
  });

  check(label('two members of one client each get one alert per post'), () => {
    const out = build(
      [post('101', CLIENT_A), post('102', CLIENT_A)],
      [recipient(CLIENT_A, 'chatA1', 'Client A'), recipient(CLIENT_A, 'chatA2', 'Client A')]
    );
    assert.equal(sends(out).length, 4);
  });

  check(label('a duplicated (client, chat) row does not duplicate the alert'), () => {
    const out = build(
      [post('101', CLIENT_A)],
      [recipient(CLIENT_A, 'chatA', 'Client A'), recipient(CLIENT_A, 'chatA', 'Client A')]
    );
    assert.equal(sends(out).length, 1);
  });

  check(label('no alerting posts -> no items, no developer alert'), () => {
    const out = build([post('101', CLIENT_A, { alert_now: false })], [recipient(CLIENT_A, 'chatA', 'Client A')]);
    assert.deepEqual(out, []);
  });

  check(label('alert button payloads unchanged (they couple to the router)'), () => {
    const out = build([post('101', CLIENT_A)], [recipient(CLIENT_A, 'chatA', 'Client A')]);
    const json = out[0].json;
    assert.equal(json.snooze_callback_data, 'snooze:101');
    assert.equal(json.ignore_callback_data, 'ignore:101');
    assert.equal(json.hide_callback_data, 'hide_replies:101');
    assert.match(json.message, /XMonitor Scheduled Post Alert/);
  });

  // ------------------------------------------ case 6: per-client threshold

  check(label('case 6: each post is judged by its own client negative_threshold'), () => {
    const sentimentCode = node('Calculate/Filter Sentiment Counts').parameters.jsCode;
    const modelNode = envName === 'staging' ? 'Apply Media Sentiment' : 'Analyze Sentiment with ChatGPT';

    // A ratio of 0.4: below client A's 0.5, above client B's 0.3.
    const replies = (negatives, total) => [
      ...Array.from({ length: negatives }, (_, i) => ({ id: `n${i}`, sentiment: 'Negative', text: 'bad' })),
      ...Array.from({ length: total - negatives }, (_, i) => ({ id: `p${i}`, sentiment: 'Positive', text: 'good' })),
    ];
    const modelOutput = [{
      json: {
        text: JSON.stringify({
          results: [
            { postId: '101', postText: 'a', userId: 'ua', replies: replies(4, 10) },
            { postId: '202', postText: 'b', userId: 'ub', replies: replies(4, 10) },
          ],
        }),
      },
    }];

    const out = runCode(sentimentCode, {
      lookup: {
        [modelNode]: modelOutput,
        'Get Stored Post Counts': [],
        'Attach replies to posts': [{
          json: {
            text: JSON.stringify({ results: [] }),
            post_client_map: {
              101: { client_id: CLIENT_A, client_name: 'Client A', min_replies: 10, negative_threshold: 0.5 },
              202: { client_id: CLIENT_B, client_name: 'Client B', min_replies: 5, negative_threshold: 0.3 },
            },
          },
        }],
      },
    });

    const posts = out[0].json.posts;
    const byId = Object.fromEntries(posts.map((p) => [String(p.postId), p]));
    assert.equal(byId['101'].negative_ratio, 0.4);
    assert.equal(byId['202'].negative_ratio, 0.4);
    assert.equal(byId['101'].alert_threshold, 0.5);
    assert.equal(byId['202'].alert_threshold, 0.3);
    assert.equal(byId['101'].alert_now, false, '0.40 must not cross client A\'s 0.50');
    assert.equal(byId['202'].alert_now, true, '0.40 must cross client B\'s 0.30');
    assert.equal(byId['101'].client_id, CLIENT_A);
    assert.equal(byId['202'].client_id, CLIENT_B);
  });

  check(label('an unresolved client falls back to the pre-T3 0.5, not to alerting on everything'), () => {
    const sentimentCode = node('Calculate/Filter Sentiment Counts').parameters.jsCode;
    const modelNode = envName === 'staging' ? 'Apply Media Sentiment' : 'Analyze Sentiment with ChatGPT';
    const out = runCode(sentimentCode, {
      lookup: {
        [modelNode]: [{
          json: {
            text: JSON.stringify({
              results: [{
                postId: '999',
                postText: 'x',
                userId: 'u',
                replies: [
                  { id: 'n1', sentiment: 'Negative', text: 'bad' },
                  { id: 'p1', sentiment: 'Positive', text: 'good' },
                  { id: 'p2', sentiment: 'Positive', text: 'good' },
                ],
              }],
            }),
          },
        }],
        'Get Stored Post Counts': [],
        'Attach replies to posts': [{ json: { text: JSON.stringify({ results: [] }), post_client_map: {} } }],
      },
    });
    const post999 = out[0].json.posts[0];
    assert.equal(post999.alert_threshold, 0.5);
    assert.equal(post999.alert_now, false);
  });

  // ------------------------------------------------- developer alert wording

  check(label('developer alert names the client and keeps its environment header'), () => {
    const code = node('Build Scheduler Developer Alert').parameters.jsCode;
    const run = (json) => new Function('$json', `return (() => { ${code} })();`)(json);
    const withClient = run({
      scheduler_alert_type: 'NO_TELEGRAM_RECIPIENTS',
      client_id: CLIENT_B,
      client_name: 'Client B',
      message: 'no recipients',
      post_count: 1,
    });
    assert.match(withClient[0].json.message, /Client: Client B 22222222-/);
    const expectedHeader = envName === 'staging' ? /staging handled error/ : /production handled error/;
    assert.match(withClient[0].json.message, expectedHeader, 'environment header must not be swapped');
    // A non-tenancy failure must not grow an empty Client line.
    const withoutClient = run({ scheduler_alert_type: 'NO_TRACKED_USERS', message: 'none configured' });
    assert.ok(!withoutClient[0].json.message.includes('Client:'));
  });
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.error(`  FAIL  ${failure}`);
process.exit(failures.length ? 1 : 0);
