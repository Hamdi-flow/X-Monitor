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
    { id: 'ig:4', kind: 'stability', platform: 'ig' },
    { id: 'ig:5', kind: 'stability', platform: 'ig' },
  ];
  const res = [
    ['x:1', 'Positive', 'Negative'], ['x:2', 'Positive', 'Neutral'], ['x:3', 'Neutral', null], ['ig:4', 'Neutral', 'Negative'], ['ig:5', 'Positive', 'Positive'],
  ].flatMap(([id, a, b]) => [{ id, variant: 'current', label: a }, { id, variant: 'candidate', label: b }]);
  const m = lib.prScore(cases, res);
  assert.equal(m.labelled.n, 2);
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
});

test('dollar quoting never collides with the value', () => {
  const v = "it's $pr$ and $$ and ;DROP TABLE";
  const q = lib.prDollar(v);
  const tag = q.match(/^\$pr[a-z0-9]*\$/)[0];
  assert.ok(q.endsWith(tag));
  assert.equal(q.slice(tag.length, -tag.length), v);
});
