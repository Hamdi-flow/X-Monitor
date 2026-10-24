// Checks the FB / IG cheat-sheet patch (patch-meta-cheat-sheets.mjs) against the live code
// it was generated from, when out/live-<p>.json and out/<p>-patched.json exist:
//   - without a sheet, the patched monitor sends byte-for-byte the old prompt;
//   - with a sheet, it sends exactly what the review (lib.js) measures.
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
const code = (w, name) => w.nodes.find(n => n.name === name).parameters.jsCode;
const resolve = (src) => new Function('$input', src)({ all: () => rows.map(json => ({ json })) })[0].json.comment_text.system_prompt;
/** The patched classifier expression, evaluated. */
const fill = (sp, block) => sp.split('[[CHEAT_SHEET_BLOCK]]').join(block || '').replace(/\n{3,}/g, '\n\n');

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
    // The block exactly as the patched Build Analysis Plan builds it.
    const plan = code(patched, 'Build Analysis Plan');
    const fn = plan.slice(plan.indexOf('function cheatSheetFor'), plan.indexOf('\n}\n', plan.indexOf('function cheatSheetFor')) + 2);
    const cheatSheetFor = new Function('clientByOwner', 'sheetByClient', fn + '\nreturn cheatSheetFor;')(
      new Map([['owner-1', 'client-1']]), new Map([['client-1', { version: 2, rulesText: sheet.rules_text }]]));
    const item = cheatSheetFor('owner-1');
    assert.deepEqual([item.client_id, item.cheat_sheet_version], ['client-1', 2]);
    assert.equal(fill(after, item.cheat_sheet_block), lib.prSystemPrompt(lib.prComposeTextPrompt(prompts), p, sheet));
    assert.equal(cheatSheetFor('unknown').cheat_sheet_block, '');
  });
}
