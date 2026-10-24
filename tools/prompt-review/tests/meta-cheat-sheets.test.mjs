// The review must measure the block the monitors really build. Two checks:
//   1. Against each monitor's OWN Build Analysis Plan code (X from this repo's staging
//      export, FB / IG from the sibling repos' exports): for a client with stance + sheet,
//      sheet only, stance only, blank stance, and neither, the monitor's block equals
//      lib.prCheatSheetBlock. Skipped for FB / IG when no sibling export with the stance
//      code is found (set FB_MONITOR_EXPORT / IG_MONITOR_EXPORT to point at one).
//   2. The FB / IG cheat-sheet patch (patch-meta-cheat-sheets.mjs), when out/live-<p>.json
//      and out/<p>-patched.json exist: without a sheet, the patched monitor sends
//      byte-for-byte the old prompt; with a sheet, exactly what the review measures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../out');
const repo = path.resolve(here, '../../..');
const lib = require('../lib.js');

const seed = readFileSync(path.join(repo, 'db/migrations/2026-10-18-sentiment-prompts.sql'), 'utf8').replace(/\r\n/g, '\n');
const b = [...seed.matchAll(/\$p\$([\s\S]*?)\$p\$/g)].map(m => m[1]);
const rows = [['target_stance_rules', b[0], null], ['comment_text', b[1], b[2]], ['comment_image', b[3], null]]
  .map(([key, system_prompt, user_template]) => ({ key, system_prompt, user_template, model: 'gpt-5.4-mini', temperature: 0 }));
const prompts = Object.fromEntries(rows.map(r => [r.key, r]));
const rd = f => JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, ''));
const code = (w, name) => w.nodes.find(n => n.name === name).parameters.jsCode.replace(/\r\n/g, '\n');
const resolve = (src) => new Function('$input', src)({ all: () => rows.map(json => ({ json })) })[0].json.comment_text.system_prompt;
/** The patched classifier expression, evaluated. */
const fill = (sp, block) => sp.split('[[CHEAT_SHEET_BLOCK]]').join(block || '').replace(/\n{3,}/g, '\n\n');

// ---------------------------------------------------------------- 1. stance + sheet block

// Rows as Get Active Cheat Sheets returns them since 2026-10-24 (one per client; a missing
// half is NULL), with a brace in each half to pin the doubling.
const SHEET = { version: 3, rules_text: '- Praise of {rival} is Negative.' };
const STANCE = { version: 2, stance_text: '  The owner backs {reform}; attacks on the banking cartel agree with him.\n' };
const BLANK = { version: 1, stance_text: '   ' };
const CHEAT_ROWS = [
  { client_id: 'A', version: SHEET.version, rules_text: SHEET.rules_text, stance_version: STANCE.version, stance_text: STANCE.stance_text },
  { client_id: 'B', version: SHEET.version, rules_text: SHEET.rules_text, stance_version: null, stance_text: null },
  { client_id: 'C', version: null, rules_text: null, stance_version: STANCE.version, stance_text: STANCE.stance_text },
  { client_id: 'E', version: SHEET.version, rules_text: SHEET.rules_text, stance_version: BLANK.version, stance_text: BLANK.stance_text },
];
const CASES = [
  ['A', 'stance + sheet', SHEET, STANCE],
  ['B', 'sheet only', SHEET, null],
  ['C', 'stance only', null, STANCE],
  ['D', 'neither', null, null],
  ['E', 'blank stance + sheet', SHEET, BLANK],
];
const sib = (product, rel) => [path.resolve(repo, '..', product, rel), path.resolve(repo, '../../../..', product, '.claude/worktrees/client-stances', rel)];
const EXPORTS = {
  fb: [process.env.FB_MONITOR_EXPORT, ...sib('FB Monitor', 'workflows/fb-monitor-beta/current.json'), ...sib('FB Monitor', 'workflows/fb-monitor-beta/staging.json')],
  ig: [process.env.IG_MONITOR_EXPORT, ...sib('Insta-Monitor', 'workflows/ig-monitor/current.json'), ...sib('Insta-Monitor', 'workflows/ig-monitor/staging.json')],
};
const hasStanceCode = f => !!f && existsSync(f) && code(rd(f), 'Build Analysis Plan').includes('stanceByClient');
const $rows = () => ({ all: () => CHEAT_ROWS.map(json => ({ json })) });

/** X: the per-post block code of the staging Build Analysis Plan, run on CHEAT_ROWS. */
function xBlockFor() {
  const c = code(rd(path.join(repo, 'workflows/staging/xmonitor-scheduled-post-tracking-staging.json')), 'Build Analysis Plan');
  const cut = (from, to) => {
    const i = c.indexOf(from), j = c.indexOf(to, i);
    assert.ok(i >= 0 && j > i, 'X Build Analysis Plan changed shape near: ' + from);
    return c.slice(i, j + to.length);
  };
  const maps = cut('const cheatRows = ', 'function escapeTemplateBraces(value) {');
  const esc = cut('function escapeTemplateBraces(value) {', '\n}\n');
  const block = cut('const parts = [];', "'No client-specific labelling rules are configured for this client. Use your general judgement.';");
  const body = maps.slice(0, -'function escapeTemplateBraces(value) {'.length) + esc
    + '\nreturn clientId => {\nconst sheet = sheetByClientId.get(clientId) || null;\nconst stance = stanceByClientId.get(clientId) || null;\n'
    + block + '\nreturn escapeTemplateBraces(block);\n};';
  return new Function('$', body)($rows);
}
/** FB / IG: the export's cheatSheetFor, one owner per client. */
function metaBlockFor(file) {
  const c = code(rd(file), 'Build Analysis Plan');
  const i = c.indexOf('const cheatRows = ');
  const fn = c.slice(i, c.indexOf('\n}\n', c.indexOf('function cheatSheetFor')) + 3);
  const clientByOwner = new Map(['A', 'B', 'C', 'D', 'E'].map(k => ['owner-' + k, k]));
  const f = new Function('$', 'clientByOwner', fn + '\nreturn cheatSheetFor;')($rows, clientByOwner);
  return clientId => f('owner-' + clientId).cheat_sheet_block;
}

test('x: the monitor block equals lib.prCheatSheetBlock (stance first, stance only, none)', () => {
  const blockFor = xBlockFor();
  for (const [id, what, sheet, stance] of CASES) assert.equal(blockFor(id), lib.prCheatSheetBlock('x', sheet, stance), what);
  // Sanity: the cases really differ.
  assert.ok(blockFor('A').startsWith('About this client (stance v2).'));
  assert.equal(blockFor('B'), blockFor('E'));
});
for (const p of ['fb', 'ig']) {
  const file = EXPORTS[p].find(hasStanceCode);
  test(`${p}: the monitor block equals lib.prCheatSheetBlock (stance first, stance only, none)`, { skip: !file && `no ${p} export with the stance code found` }, () => {
    const blockFor = metaBlockFor(file);
    for (const [id, what, sheet, stance] of CASES) assert.equal(blockFor(id), lib.prCheatSheetBlock(p, sheet, stance), what + ' (' + file + ')');
    assert.equal(blockFor('D'), '');
  });
}

// ---------------------------------------------------------------- 2. the 2026-10-24 patch

for (const p of ['fb', 'ig']) {
  const livePath = path.join(out, `live-${p}.json`), patchedPath = path.join(out, `${p}-patched.json`);
  test(`${p}: patched prompt equals the old one without a sheet and lib.js with one`, { skip: !existsSync(patchedPath) && 'run patch-meta-cheat-sheets.mjs first' }, () => {
    const live = rd(livePath).workflow, patched = rd(patchedPath);
    const before = resolve(code(live, 'Resolve Sentiment Prompts'));
    const after = resolve(code(patched, 'Resolve Sentiment Prompts'));
    assert.ok(after.includes('[[CHEAT_SHEET_BLOCK]]'));
    assert.equal(fill(after, ''), before);
    assert.equal(fill(after, ''), lib.prSystemPrompt(lib.prComposeTextPrompt(prompts), p, null));
    const sheet = { version: 2, rules_text: '- Praise of {rival} is Negative.' };
    // The block exactly as the patched Build Analysis Plan builds it (stanceByClient is
    // passed empty: the patch predates stances, and a later export may reference it).
    const plan = code(patched, 'Build Analysis Plan');
    const fn = plan.slice(plan.indexOf('function cheatSheetFor'), plan.indexOf('\n}\n', plan.indexOf('function cheatSheetFor')) + 2);
    const cheatSheetFor = new Function('clientByOwner', 'sheetByClient', 'stanceByClient', fn + '\nreturn cheatSheetFor;')(
      new Map([['owner-1', 'client-1']]), new Map([['client-1', { version: 2, rulesText: sheet.rules_text }]]), new Map());
    const item = cheatSheetFor('owner-1');
    assert.deepEqual([item.client_id, item.cheat_sheet_version], ['client-1', 2]);
    assert.equal(fill(after, item.cheat_sheet_block), lib.prSystemPrompt(lib.prComposeTextPrompt(prompts), p, sheet));
    assert.equal(cheatSheetFor('unknown').cheat_sheet_block, '');
  });
}
