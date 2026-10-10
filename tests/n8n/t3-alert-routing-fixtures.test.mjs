// Phase T3 - drives the three tenancy pin fixtures through the real Code-node
// bodies of the production scheduler export, end to end from the X search response
// to the Telegram items, and asserts the T3 acceptance table.
//
//   node tests/n8n/t3-alert-routing-fixtures.test.mjs
//
// This is the offline half of the T3 gate. It proves the fixtures produce the
// routing they claim; it cannot prove wiring, credentials or the publish state, so
// it does not replace running the same fixtures through n8n's test_workflow.
//
// The production export is used because staging inserts an extra media-sentiment
// hop between the model and Calculate/Filter Sentiment Counts. The T3 nodes
// themselves are asserted identical across both exports in t3-alert-routing.test.mjs.

import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = JSON.parse(fs.readFileSync('workflows/active/xmonitor-scheduled-post-tracking.json', 'utf8'));
const code = (name) => {
  const node = workflow.nodes.find((n) => n.name === name);
  if (!node) throw new Error(`missing node: ${name}`);
  return node.parameters.jsCode;
};
const pins = (name) =>
  JSON.parse(fs.readFileSync(`tests/n8n/scheduled-tracking-pins/${name}.pinData.json`, 'utf8'));

function run(jsCode, lookup, input) {
  const $ = (name) => {
    if (!(name in lookup)) throw new Error(`unexpected $('${name}')`);
    return { all: () => lookup[name], first: () => lookup[name][0] };
  };
  return new Function('$', '$input', `return (() => { ${jsCode} })();`)($, { all: () => input });
}

/**
 * Replay the alerting path of the graph against one pinned fixture, running the
 * real node bodies and emulating only the declarative nodes (Split Out, Filter).
 */
function replay(fixture) {
  const lookup = { ...fixture };

  // Since 2026-10-10 the fixtures pin the per-reply labels on Merge Sentiment
  // Results (one model call per reply). Calculate/Filter Sentiment Counts reads the
  // regrouped {results:[...]} shape from Collect Sentiment Labels, so do the same
  // regrouping here. Production used to read it from Analyze Sentiment with ChatGPT.
  if (fixture['Merge Sentiment Results']) {
    const byPost = new Map();
    for (const item of fixture['Merge Sentiment Results']) {
      const j = item.json;
      if (!byPost.has(j.post_id)) byPost.set(j.post_id, { postId: j.post_id, postText: j.post_text, userId: j.user_id, replies: [] });
      byPost.get(j.post_id).replies.push({ id: j.reply_id, sentiment: j.sentiment, text: j.reply_text });
    }
    const regrouped = [{ json: { text: JSON.stringify({ results: [...byPost.values()] }) } }];
    lookup['Collect Sentiment Labels'] = regrouped;
    lookup['Analyze Sentiment with ChatGPT'] = regrouped;
  }

  // Split Out Posts: fans `data` out of the X search response.
  const splitPosts = fixture['Get posts of tracked users'].flatMap((page) =>
    (page.json.data || []).map((post) => ({ json: post }))
  );

  const filtered = run(code('Filter Suppressed Posts'), lookup, splitPosts);

  // Keep Posts With 10+ Replies, now `reply_count >= $json.client_min_replies`.
  const condition = workflow.nodes.find((n) => n.name === 'Keep Posts With 10+ Replies')
    .parameters.conditions.conditions[0];
  assert.equal(condition.rightValue, '={{ $json.client_min_replies }}');
  assert.equal(condition.operator.operation, 'gte');
  const qualified = filtered.filter(
    (item) => Number(item.json.public_metrics?.reply_count ?? 0) >= Number(item.json.client_min_replies)
  );
  lookup['Keep Posts With 10+ Replies'] = qualified;

  const attached = run(code('Attach replies to posts'), lookup, qualified);
  lookup['Attach replies to posts'] = attached;

  const calculated = run(code('Calculate/Filter Sentiment Counts'), lookup, attached);

  // Split Out Reply Analysis: fans `posts` out.
  const splitAnalysis = calculated[0].json.posts.map((post) => ({ json: post }));
  lookup['Split Out Reply Analysis'] = splitAnalysis;

  const built = run(code('Build Negative Alert Notification'), lookup, fixture['Get Alert Recipients']);

  return {
    qualified,
    posts: splitAnalysis.map((item) => item.json),
    sends: built.filter((item) => item.json.notify_ready),
    devAlerts: built.filter((item) => !item.json.notify_ready),
  };
}

let passed = 0;
const failures = [];
function check(label, fn) {
  try { fn(); passed += 1; } catch (error) { failures.push(`${label}\n    ${error.message.split('\n')[0]}`); }
}

const CHAT_A = '9900000001';
const CHAT_B = '9900000002';
const POST_A = '9990000000000000101';
const POST_B = '9990000000000000202';

// ------------------------------------------- cases 1-3: two clients, one pass

const bothResult = replay(pins('tenancy-two-clients-one-pass'));

check('fixture sanity: both posts clear their client min_replies and both alert', () => {
  assert.equal(bothResult.qualified.length, 2);
  assert.deepEqual(bothResult.posts.map((p) => p.alert_now), [true, true]);
  assert.deepEqual(bothResult.posts.map((p) => p.negative_ratio), [0.75, 0.75]);
});

check('case 1: client A post reaches chat A only', () => {
  const toA = bothResult.sends.filter((i) => i.json.chat_id === CHAT_A);
  assert.deepEqual(toA.map((i) => i.json.post_id), [POST_A]);
});

check('case 2: client B post reaches chat B only', () => {
  const toB = bothResult.sends.filter((i) => i.json.chat_id === CHAT_B);
  assert.deepEqual(toB.map((i) => i.json.post_id), [POST_B]);
});

check('case 3: both cross in one pass, each chat gets only its own', () => {
  assert.equal(bothResult.sends.length, 2, 'exactly one alert per client, no cross-delivery');
  assert.deepEqual(bothResult.devAlerts, []);
  // The regression this whole phase exists to prevent: neither chat may see the
  // other client's post id or post text.
  for (const item of bothResult.sends) {
    const foreign = item.json.chat_id === CHAT_A ? POST_B : POST_A;
    assert.ok(!item.json.message.includes(foreign), `${item.json.chat_id} saw ${foreign}`);
    assert.ok(!item.json.message.includes(item.json.chat_id === CHAT_A ? 'Tenancy Test B' : 'Tenancy Test A'));
  }
});

// ------------------------------------------------- case 4: B has no recipient

const orphanResult = replay(pins('tenancy-client-b-no-recipient'));

check("case 4: developer alert names client B, and client A's alert still sends", () => {
  assert.deepEqual(orphanResult.sends.map((i) => i.json.chat_id), [CHAT_A]);
  assert.deepEqual(orphanResult.sends.map((i) => i.json.post_id), [POST_A]);
  assert.equal(orphanResult.devAlerts.length, 1);
  const alert = orphanResult.devAlerts[0].json;
  assert.equal(alert.scheduler_alert_type, 'NO_TELEGRAM_RECIPIENTS');
  assert.match(alert.message, /Tenancy Test B/);
  assert.deepEqual(alert.post_ids, [POST_B]);
  assert.ok(!alert.message.includes('Tenancy Test A'), "A must not appear in B's failure");
});

check('case 4: the developer alert renders with the client named', () => {
  const devCode = code('Build Scheduler Developer Alert');
  const rendered = new Function('$json', `return (() => { ${devCode} })();`)(orphanResult.devAlerts[0].json);
  assert.match(rendered[0].json.message, /Client: Tenancy Test B bbbbbbbb-/);
  assert.match(rendered[0].json.message, /Path: NO_TELEGRAM_RECIPIENTS/);
});

// -------------------------------------------- case 5: receives_alerts = false

const mutedResult = replay(pins('tenancy-receives-alerts-false'));

check('case 5: a member with receives_alerts = false receives nothing', () => {
  assert.deepEqual(mutedResult.sends, [], 'no Telegram item may be produced');
  assert.equal(mutedResult.devAlerts.length, 1, 'the silence is reported, not silent');
  assert.equal(mutedResult.devAlerts[0].json.client_id, 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb');
});

// ------------------------------------ case 6: per-client thresholds, in the graph

check('case 6: min_replies and negative_threshold are each read per client', () => {
  const fixture = structuredClone(pins('tenancy-two-clients-one-pass'));
  const tracked = fixture['Get Tracked Users'];
  // Client B tightened: 25 replies required, so its 20-reply post drops out at the
  // gate. Client A untouched at 10, so its post survives -- one pass, two answers.
  tracked.find((t) => t.json.client_slug === 'tenancy-test-b').json.client_min_replies = 25;
  const result = replay(fixture);
  assert.deepEqual(result.qualified.map((q) => q.json.id), [POST_A]);
  assert.deepEqual(result.sends.map((i) => i.json.chat_id), [CHAT_A]);

  // Now the sentiment threshold. Ratio is 0.75 for both. Lift A above it and A
  // stops alerting while B, left at 0.5, still does.
  const fixture2 = structuredClone(pins('tenancy-two-clients-one-pass'));
  fixture2['Get Tracked Users'].find((t) => t.json.client_slug === 'tenancy-test-a')
    .json.client_negative_threshold = 0.9;
  const result2 = replay(fixture2);
  const byPost = Object.fromEntries(result2.posts.map((p) => [String(p.postId), p]));
  assert.equal(byPost[POST_A].alert_threshold, 0.9);
  assert.equal(byPost[POST_B].alert_threshold, 0.5);
  assert.equal(byPost[POST_A].alert_now, false, '0.75 must not cross A\'s 0.90');
  assert.equal(byPost[POST_B].alert_now, true, '0.75 must cross B\'s 0.50');
  assert.deepEqual(result2.sends.map((i) => i.json.chat_id), [CHAT_B]);
  assert.deepEqual(result2.devAlerts, [], 'a post that simply did not qualify is not a misconfiguration');
});

// ---------------------------------------------------- must-not-regress guards

check('the watermark inputs are unchanged by T3', () => {
  const fixture = pins('tenancy-two-clients-one-pass');
  const lookup = { ...fixture };
  const splitPosts = fixture['Get posts of tracked users'].flatMap((page) =>
    (page.json.data || []).map((post) => ({ json: post }))
  );
  const filtered = run(code('Filter Suppressed Posts'), lookup, splitPosts);
  const qualified = filtered.filter(
    (item) => Number(item.json.public_metrics?.reply_count ?? 0) >= Number(item.json.client_min_replies)
  );
  lookup['Keep Posts With 10+ Replies'] = qualified;
  const attached = run(code('Attach replies to posts'), lookup, qualified)[0].json;

  // These three drive If Fetch Truncated / If Safe To Advance Watermark. T3 adds a
  // field to this node's output; it must not have disturbed the watermark inputs.
  assert.equal(attached.fetch_truncated, false);
  assert.equal(attached.has_new_replies, true);
  assert.equal(attached.new_reply_count, 8);
  assert.deepEqual(attached.candidate_post_ids, [POST_A, POST_B]);
});

check('the OpenAI payload carries no tenancy fields', () => {
  const fixture = pins('tenancy-two-clients-one-pass');
  const lookup = { ...fixture };
  const splitPosts = fixture['Get posts of tracked users'].flatMap((page) =>
    (page.json.data || []).map((post) => ({ json: post }))
  );
  const filtered = run(code('Filter Suppressed Posts'), lookup, splitPosts);
  const qualified = filtered.filter(
    (item) => Number(item.json.public_metrics?.reply_count ?? 0) >= Number(item.json.client_min_replies)
  );
  lookup['Keep Posts With 10+ Replies'] = qualified;
  const attached = run(code('Attach replies to posts'), lookup, qualified)[0].json;

  // `text` is what Analyze Sentiment with ChatGPT receives. Client ids in it would
  // change the prompt and its cost for no benefit. Matched on the field names, not
  // on the words: the fixture's own post text legitimately names the client.
  for (const field of ['client_id', 'client_slug', 'client_name', 'min_replies', 'negative_threshold', 'post_client_map']) {
    assert.ok(!attached.text.includes(field), `${field} leaked into the model prompt`);
  }
  const modelPayload = JSON.parse(attached.text);
  assert.deepEqual(
    [...new Set(modelPayload.results.flatMap((r) => Object.keys(r)))].sort(),
    ['authorName', 'authorUsername', 'postAuthor', 'postId', 'postText', 'replies', 'totalReplyCount', 'userId'],
    'the model payload shape must be exactly what it was before T3'
  );
  assert.ok(attached.post_client_map[POST_A].client_id.startsWith('aaaaaaaa-'));
  assert.ok(attached.post_client_map[POST_B].client_id.startsWith('bbbbbbbb-'));
});

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.error(`  FAIL  ${failure}`);
process.exit(failures.length ? 1 : 0);
