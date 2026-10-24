// node --test tools/prompt-review/tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const lib = require('../lib.js');
const repo = path.resolve(here, '../../..');

// The seeded rows, read from the migration so the test follows the real prompts.
const seed = readFileSync(path.join(repo, 'db/migrations/2026-10-18-sentiment-prompts.sql'), 'utf8').replace(/\r\n/g, '\n');
const bodies = [...seed.matchAll(/\$p\$([\s\S]*?)\$p\$/g)].map(m => m[1]);
const PROMPTS = {
  target_stance_rules: { system_prompt: bodies[0], user_template: null },
  comment_text: { system_prompt: bodies[1], user_template: bodies[2] },
  comment_image: { system_prompt: bodies[3], user_template: null },
};

/** Run the X monitor's own Resolve Sentiment Prompts node code on the given rows. */
function runResolve(exportPath, rows) {
  const w = JSON.parse(readFileSync(exportPath, 'utf8'));
  const code = w.nodes.find(n => n.name === 'Resolve Sentiment Prompts').parameters.jsCode;
  const $input = { all: () => rows.map(json => ({ json })) };
  return new Function('$input', code)($input)[0].json;
}
const rows = Object.entries(PROMPTS).map(([key, r]) => ({ key, ...r, model: 'gpt-5.4-mini', temperature: 0 }));

test('composition matches the X monitor Resolve node byte for byte', () => {
  const resolved = runResolve(path.join(repo, 'workflows/staging/xmonitor-scheduled-post-tracking-staging.json'), rows);
  assert.equal(resolved.comment_text.source, 'table');
  assert.equal(lib.prComposeTextPrompt(PROMPTS), resolved.comment_text.system_prompt);
});

test('X fills the marker with the sheet or the no-rules sentence', () => {
  const composed = lib.prComposeTextPrompt(PROMPTS);
  const none = lib.prSystemPrompt(composed, 'x', null);
  assert.ok(none.includes('No client-specific labelling rules are configured'));
  const withSheet = lib.prSystemPrompt(composed, 'x', { version: 3, rules_text: 'Praise of {rival} is Negative.' });
  assert.ok(withSheet.includes('(cheat sheet v3)'));
  assert.ok(withSheet.includes('Praise of {{rival}} is Negative.'), 'braces doubled for LangChain');
  assert.ok(!withSheet.includes(lib.PR_CHEAT_MARKER));
});

test('FB/IG without a sheet send the same prompt as before cheat sheets', () => {
  // Before: Resolve with CHEAT_SHEET_MARKER = "" (the marker removed, then tidied).
  const rulesIn = PROMPTS.comment_text.system_prompt.split('{{target_stance_rules}}').join(PROMPTS.target_stance_rules.system_prompt.trim());
  const before = lib.prEscapeForLangChain(rulesIn.split('{{cheat_sheet_block}}').join('')).replace(/\n{3,}/g, '\n\n').trim();
  const composed = lib.prComposeTextPrompt(PROMPTS);
  assert.equal(lib.prSystemPrompt(composed, 'fb', null), before);
  assert.equal(lib.prSystemPrompt(composed, 'ig', null), before);
});

// Client stances (2026-10-24): the monitors put "About this client (stance vN)" ahead of the
// cheat sheet. meta-cheat-sheets.test.mjs pins this against each monitor's own code.
const STANCE_HEAD = 'About this client (stance v1). Use it to judge whether a comment is for or against the account owner:\n';
const SHEET_HEAD = 'Client-specific labelling rules (cheat sheet v3). Apply these over your general judgement whenever they match:\n';
const SHEET = { version: 3, rules_text: 'Praise of {rival} is Negative.' };

test('stance: a client without one gets exactly the old block, on every platform', () => {
  const composed = lib.prComposeTextPrompt(PROMPTS);
  const oldBlock = (p, sheet) => sheet ? (SHEET_HEAD + sheet.rules_text).split('{').join('{{').split('}').join('}}') : (p === 'x' ? 'No client-specific labelling rules are configured for this client. Use your general judgement.' : '');
  for (const p of ['x', 'fb', 'ig']) for (const sheet of [null, SHEET]) {
    for (const stance of [undefined, null, { version: 4, stance_text: '' }, { version: 4, stance_text: ' \n ' }]) {
      assert.equal(lib.prCheatSheetBlock(p, sheet, stance), oldBlock(p, sheet), p + ' ' + JSON.stringify([sheet, stance]));
      assert.equal(lib.prSystemPrompt(composed, p, sheet, stance), lib.prSystemPrompt(composed, p, sheet));
    }
  }
});

test('stance: first, then the sheet, blank line between, braces doubled', () => {
  const stance = { version: 1, stance_text: '  The owner backs {reform}.\n' };
  const block = lib.prCheatSheetBlock('fb', SHEET, stance);
  assert.equal(block, STANCE_HEAD + 'The owner backs {{reform}}.\n\n' + SHEET_HEAD + 'Praise of {{rival}} is Negative.');
  const sp = lib.prSystemPrompt(lib.prComposeTextPrompt(PROMPTS), 'x', SHEET, stance);
  assert.ok(sp.includes(block));
  assert.ok(sp.indexOf('(stance v1)') < sp.indexOf('(cheat sheet v3)'));
});

test('stance only: the stance alone replaces the no-rules sentence (X) or nothing (FB/IG)', () => {
  const stance = { version: 1, stance_text: 'The owner backs reform.' };
  for (const p of ['x', 'fb', 'ig']) assert.equal(lib.prCheatSheetBlock(p, null, stance), STANCE_HEAD + 'The owner backs reform.');
  assert.ok(!lib.prSystemPrompt(lib.prComposeTextPrompt(PROMPTS), 'x', null, stance).includes('No client-specific labelling rules'));
});

test('a proposed sheet that repeats the stance is dropped', () => {
  const ids = new Set(['c1']);
  const stance = { version: 1, stance_text: 'The owner backs reform.\nAttacks on banks agree with him.' };
  assert.deepEqual(lib.prCheckSheet({ platform: 'x', client_id: 'c1', rules_text: '- the owner backs reform. attacks on banks agree with him.\n- Clowns are Negative.' }, ids, stance), ['repeats the client stance (set by staff, not by the review)']);
  assert.deepEqual(lib.prCheckSheet({ platform: 'x', client_id: 'c1', rules_text: '- Clowns are Negative.' }, ids, stance), []);
  assert.deepEqual(lib.prCheckSheet({ platform: 'x', client_id: 'c1', rules_text: '- Clowns are Negative.' }, ids), []);
});

test('classifier input follows the user template and cuts the post at 1000', () => {
  const s = lib.prClassifierInput(PROMPTS.comment_text.user_template, { owner: '@a', post: 'p'.repeat(1200), comment: 'hi', is_owner: true });
  assert.ok(s.startsWith('Account owner: @a\n'));
  assert.ok(s.includes('p'.repeat(1000) + ' [...]'));
  assert.ok(s.includes('Comment (written by the account owner):'));
});

test('edits apply only when the find text occurs exactly once', () => {
  const base = { target_stance_rules: { system_prompt: 'one two three. two.' } };
  const r = lib.prApplyEdits(base, [
    { key: 'target_stance_rules', find: 'two', replace: 'TWO' },
    { key: 'target_stance_rules', find: 'one', replace: 'ONE' },
    { key: 'target_stance_rules', find: 'missing', replace: 'x' },
    { key: 'bogus', find: 'a', replace: 'b' },
  ]);
  assert.deepEqual(r.edits.map(e => e.problem), ['find text occurs more than once', null, 'find text not in the row', 'unknown prompt row']);
  assert.equal(r.candidate.target_stance_rules, 'ONE two three. two.');
});

test('row checks: placeholders, emptiness, 25% limit', () => {
  const base = PROMPTS.comment_text.system_prompt;
  assert.deepEqual(lib.prCheckRow('comment_text', base, base.replace('will', 'shall')).problems, []);
  assert.ok(lib.prCheckRow('comment_text', base, base.replace('{{cheat_sheet_block}}', '')).problems.some(p => p.includes('{{cheat_sheet_block}}')));
  assert.ok(lib.prCheckRow('comment_text', base, base.replace('{categories}', '{{categories}}')).problems.some(p => p.includes('{categories}')));
  assert.ok(lib.prCheckRow('comment_text', base, '').problems.includes('the row would be empty'));
  const rules = PROMPTS.target_stance_rules.system_prompt;
  assert.ok(lib.prCheckRow('target_stance_rules', rules, rules + '\n' + rules.slice(0, rules.length / 2)).problems.some(p => p.includes('limit 25%')));
  assert.ok(lib.prCheckRow('comment_image', PROMPTS.comment_image.system_prompt, PROMPTS.comment_image.system_prompt.replace(/JSON/gi, 'text')).problems.includes('removes the JSON instruction'));
});

test('line diff marks removed and added lines and the changed words', () => {
  const a = 'keep 1\nkeep 2\nthe cat sat\nkeep 3\nkeep 4\nkeep 5\nkeep 6';
  const b = 'keep 1\nkeep 2\nthe dog sat\nkeep 3\nkeep 4\nkeep 5\nkeep 6\nnew line';
  const d = lib.prLineDiff(a, b, 1);
  assert.deepEqual(d.map(l => l.type), ['gap', 'ctx', 'del', 'add', 'ctx', 'gap', 'ctx', 'add']);
  assert.deepEqual(d[2].words.filter(w => w.type === 'del').map(w => w.text), ['cat']);
  assert.deepEqual(d[3].words.filter(w => w.type === 'add').map(w => w.text), ['dog']);
});

test('scoring separates fixed, broken and stability flips', () => {
  const cases = [
    { id: 'x:1', kind: 'labelled', platform: 'x', human_label: 'Negative' },
    { id: 'x:2', kind: 'labelled', platform: 'x', human_label: 'Positive' },
    { id: 'x:3', kind: 'labelled', platform: 'x', human_label: 'Neutral' },
    { id: 'x:6', kind: 'labelled', platform: 'x', human_label: 'Negative', human_note: 'mocks him' },
    { id: 'ig:4', kind: 'stability', platform: 'ig' },
    { id: 'ig:5', kind: 'stability', platform: 'ig' },
  ];
  const res = [
    ['x:1', 'Positive', 'Negative'], ['x:2', 'Positive', 'Neutral'], ['x:3', 'Neutral', null], ['x:6', 'Positive', 'Neutral'], ['ig:4', 'Neutral', 'Negative'], ['ig:5', 'Positive', 'Positive'],
  ].flatMap(([id, a, b]) => [{ id, variant: 'current', label: a }, { id, variant: 'candidate', label: b }]);
  const m = lib.prScore(cases, res);
  assert.equal(m.labelled.n, 3);
  assert.equal(m.labelled.still_wrong, 1);
  assert.deepEqual(m.labelled.wrong.map(c => [c.id, c.before, c.after, c.human_note]), [['x:6', 'Positive', 'Neutral', 'mocks him']]);
  assert.equal(m.labelled.unmeasured, 1);
  assert.deepEqual([m.labelled.before_correct, m.labelled.after_correct], [1, 1]);
  assert.deepEqual(m.labelled.fixed.map(c => c.id), ['x:1']);
  assert.deepEqual(m.labelled.broken.map(c => c.id), ['x:2']);
  assert.deepEqual(m.stability.flips.map(c => c.id), ['ig:4']);
});

test('report escapes comment text and shows the decision box only when pending', () => {
  const m = lib.prScore([{ id: 'x:1', kind: 'labelled', platform: 'x', human_label: 'Negative', comment: '<script>alert(1)</script>', owner: '@o' }],
    [{ id: 'x:1', variant: 'current', label: 'Positive' }, { id: 'x:1', variant: 'candidate', label: 'Negative' }]);
  m.model = 'gpt-5.4-mini'; m.temperature = 0;
  const r = { id: 7, status: 'pending', environment: 'STAGING', new_label_count: 1, total_label_count: 1, metrics: m,
    base_prompts: { target_stance_rules: { system_prompt: 'a b c' } }, candidate_prompts: { target_stance_rules: { system_prompt: 'a B c' } } };
  const html = lib.prRenderReport(r);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('approve 7'));
  assert.ok(html.includes('0% &rarr; 100%'));
  assert.ok(!lib.prRenderReport({ ...r, status: 'no_change', metrics: null }).includes('approve 7'));
  assert.match(lib.prSubject(r), /^\[STAGING\] Sentiment prompt review #7: 0% → 100%/);
  assert.ok(!html.includes('Client stances in the prompt'));
  assert.ok(lib.prRenderReport({ ...r, client_stances: [{ client_id: 'c1', client_name: 'House <Account>', version: 1 }] }).includes('Client stances in the prompt (set by staff, read-only here): House &lt;Account&gt; v1.'));
});

test('dollar quoting never collides with the value', () => {
  const v = "it's $pr$ and $$ and ;DROP TABLE";
  const q = lib.prDollar(v);
  const tag = q.match(/^\$pr[a-z0-9]*\$/)[0];
  assert.ok(q.endsWith(tag));
  assert.equal(q.slice(tag.length, -tag.length), v);
});

// Production review #1 (2026-10-24): three of its five "fixes" came from cheat-sheet rules
// quoting the very comments and posts they were scored on. Those rules must be dropped;
// the general rules of the same review must pass.
test('copy check drops rules that quote labelled comments or posts', () => {
  const xPost = 'المزيد من الإجرام الإسرائيلي اليوم في عربصاليم، في وقتٍ يواصل فيه حزب الله انتحاره الجماعي، والدولة غائبة كليًا. https://t.co/0Tq8XAtu6t';
  const igPost = 'هذا الكلام من ٦ أشهر… وهذه اليوم النتيجة.';
  const labels = [
    { id: 'x:2096829877076779022', post: xPost, comment: '@michelhelou_lb الإجرام تخزن الاسلحة تحت بيوت الناس' },
    { id: 'ig:18087716947926631', post: igPost, comment: '😂😂😂😂😂😂😂😂😂😂😂' },
    { id: 'ig:18090770690326887', post: igPost, comment: 'يعني الجيش مافي يرد هجوم اسرائيلي وبدكن الحزب يسلم شو الحل عندك' },
    { id: 'ig:18055544318452664', post: igPost, comment: '👌👌👌👌' },
  ];
  const xSheet = "- For @michelhelou_lb's Arab Salim post («المزيد من الإجرام الإسرائيلي اليوم في عربصاليم…»), bare criticism of storing weapons under homes, such as «الإجرام تخزن الاسلحة تحت بيوت الناس», is Neutral when no clearer stance toward him/the post is expressed.";
  assert.deepEqual(lib.prCopyProblems('', xSheet, labels), [
    'quotes labelled comment x:2096829877076779022',
    'quotes the post of labelled comment x:2096829877076779022',
  ]);
  const igSheet = "- For @camillemourani's disarmament video captioned «هذا الكلام من ٦ أشهر… وهذه اليوم النتيجة.», repeated 😂 alone mocks the video: Negative.\n- On that video, «يعني الجيش مافي يرد هجوم اسرائيلي وبدكن الحزب يسلم شو الحل عندك» is a non-hostile request for a security alternative: Neutral.";
  assert.deepEqual(lib.prCopyProblems('', igSheet, labels), [
    'quotes labelled comment ig:18090770690326887',
    'quotes the post of labelled comment ig:18087716947926631',
  ]);
  // General rules, emoji examples and text the base row already had are fine.
  const general = '- Threats or taunts at the owner/post are Negative despite apparent praise.\n- Clear approval emojis (e.g. 👌) are Positive.';
  assert.deepEqual(lib.prCopyProblems('', general, labels), []);
  assert.deepEqual(lib.prCopyProblems(xSheet, xSheet + '\n- Sarcasm about the army is Negative.', labels), []);
  // A short phrase is not a quote unless the whole comment is that phrase; links and ids are.
  assert.deepEqual(lib.prCopyProblems('', 'Comments like "الإجرام" alone are Neutral.', labels), []);
  assert.deepEqual(lib.prCopyProblems('', 'Replies to https://x.com/a/status/2096829877076779022 are Neutral.', labels), ['names a specific link or post id']);
});
