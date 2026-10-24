// One-off generator for the FB / IG monitor change "fill {{cheat_sheet_block}} from the
// client's cheat sheet" (2026-10-24). Reads a live workflow (saved get_workflow_details
// JSON), applies the change, and writes the patched workflow plus the update_workflow
// operations that perform it.
//
//   node patch-meta-cheat-sheets.mjs fb|ig <live.json> <out-dir>
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [platform, livePath, outDir] = process.argv.slice(2);
const P = {
  fb: { classify: 'Analyze Comment Sentiment', name: 'Facebook', ownerKey: 'page_id', anchor: "const pageNameById = new Map($('Get Monitor Config').all().map(c => [String(c.json.page_id), c.json.page_name || null]));\n", itemOwner: 'String(post.page_id)', pushAnchor: '\n      analysis_route: route,\n' },
  ig: { classify: 'Classify Sentiment', name: 'Instagram', ownerKey: 'ig_user_id', anchor: 'for (const cfg of $("Get Monitor Config").all()) pageNameByUser.set(String(cfg.json.ig_user_id), cfg.json.page_name || null);\n', itemOwner: 'ownerId', pushAnchor: '\n      is_owner_comment: isOwner,\n' },
}[platform];
if (!P) throw new Error('platform must be fb or ig');

// The input is a saved get_workflow_details result ({workflow}) or a repo export. With a
// 4th argument the patched export is written there too (the new node binds the same
// Postgres credential as Get Sentiment Prompts in that file, so prod stays prod).
const inputJson = JSON.parse(readFileSync(livePath, 'utf8').replace(/^﻿/, ''));
const w = inputJson.workflow || inputJson;
const exportPath = process.argv[5];
const node = name => { const n = w.nodes.find(x => x.name === name); if (!n) throw new Error('no node ' + name); return n; };
const replaceOnce = (s, a, b) => { const i = s.indexOf(a); if (i < 0 || s.indexOf(a, i + 1) >= 0) throw new Error('anchor not unique: ' + a.slice(0, 60)); return s.slice(0, i) + b + s.slice(i + a.length); };

// 1. Resolve Sentiment Prompts keeps the marker, like X.
const resolve = node('Resolve Sentiment Prompts');
let rc = resolve.parameters.jsCode;
rc = replaceOnce(rc, '// {{cheat_sheet_block}}; this workflow has no cheat sheet and replaces it with nothing.',
  `// {{cheat_sheet_block}}; this workflow keeps a marker there and Build Analysis Plan fills it per\n// comment with the client's ${P.name} cheat sheet (nothing when the client has none).`);
rc = replaceOnce(rc, 'const CHEAT_SHEET_MARKER = "";', 'const CHEAT_SHEET_MARKER = "[[CHEAT_SHEET_BLOCK]]";');

// 2. Build Analysis Plan puts the client's sheet on every item.
const plan = node('Build Analysis Plan');
let pc = plan.parameters.jsCode;
const sheetCode = `// Per-client cheat sheet (2026-10-24): the client's ACTIVE ${P.name} row in
// "Sentiment Cheat Sheets" (Get Active Cheat Sheets, platform = '${platform}'). It replaces the
// [[CHEAT_SHEET_BLOCK]] marker Resolve Sentiment Prompts leaves in the system prompt. A client
// without one gets nothing there, so its prompt is exactly what it was before cheat sheets.
// Same block text as X's Build Analysis Plan; braces doubled because the system prompt is a
// LangChain template.
const clientByOwner = new Map($('Get Monitor Config').all().map(c => [String(c.json.${P.ownerKey}), c.json.client_id ? String(c.json.client_id) : null]));
const sheetByClient = new Map($('Get Active Cheat Sheets').all()
  .map(i => i.json || {})
  .filter(r => r.client_id && r.rules_text)
  .map(r => [String(r.client_id), { version: Number(r.version || 0), rulesText: String(r.rules_text) }]));
function cheatSheetFor(ownerId) {
  const clientId = clientByOwner.get(String(ownerId)) || null;
  const sheet = clientId ? sheetByClient.get(clientId) || null : null;
  const block = sheet
    ? ('Client-specific labelling rules (cheat sheet v' + sheet.version + '). Apply these over your general judgement whenever they match:\\n' + sheet.rulesText).split('{').join('{{').split('}').join('}}')
    : '';
  return { client_id: clientId, cheat_sheet_version: sheet ? sheet.version : 0, cheat_sheet_block: block };
}
`;
pc = replaceOnce(pc, P.anchor, P.anchor + sheetCode);
pc = replaceOnce(pc, P.pushAnchor, P.pushAnchor + `      ...cheatSheetFor(${P.itemOwner}),\n`);
plan.parameters.jsCode = pc;
resolve.parameters.jsCode = rc;

// 3. The classifier fills the marker; collapsing blank lines keeps the no-sheet prompt
//    identical to the old marker-less one.
const classify = node(P.classify);
const expr = "={{ $('Resolve Sentiment Prompts').first().json.comment_text.system_prompt.split('[[CHEAT_SHEET_BLOCK]]').join($json.cheat_sheet_block || '').replace(/\\n{3,}/g, '\\n\\n') }}";
classify.parameters.options.systemPromptTemplate = expr;

// 4. Get Active Cheat Sheets, between the trigger and Get Sentiment Prompts.
const gsp = node('Get Sentiment Prompts');
const trigger = Object.keys(w.connections).find(k => (w.connections[k].main || []).flat().some(t => t.node === 'Get Sentiment Prompts'));
const newNode = {
  name: 'Get Active Cheat Sheets', type: 'n8n-nodes-base.postgres', typeVersion: gsp.typeVersion,
  position: [gsp.position[0] - 220, gsp.position[1]],
  credentials: gsp.credentials,
  executeOnce: true, alwaysOutputData: true,
  notes: 'At most one active row per client for this platform (sentiment_cheat_sheets_one_active_per_platform_idx). alwaysOutputData: an empty table still lets the run continue; Build Analysis Plan ignores the blank item.',
  parameters: { operation: 'executeQuery', query: `-- Active ${P.name} cheat sheets, one per client at most. Drafts and other platforms' sheets\n-- are excluded. Read by Build Analysis Plan.\nSELECT client_id::text AS client_id, version, rules_text\nFROM public."Sentiment Cheat Sheets"\nWHERE status = 'active' AND platform = '${platform}';`, options: {} },
};
w.nodes.push(newNode);
w.connections[trigger].main = w.connections[trigger].main.map(arr => arr.map(t => t.node === 'Get Sentiment Prompts' ? { ...t, node: 'Get Active Cheat Sheets' } : t));
w.connections['Get Active Cheat Sheets'] = { main: [[{ node: 'Get Sentiment Prompts', type: 'main', index: 0 }]] };

const ops = [
  { type: 'addNode', node: { ...newNode, executeOnce: undefined, alwaysOutputData: undefined } },
  { type: 'setNodeSettings', nodeName: 'Get Active Cheat Sheets', settings: { executeOnce: true, alwaysOutputData: true } },
  { type: 'removeConnection', source: trigger, target: 'Get Sentiment Prompts', sourceIndex: 0, targetIndex: 0 },
  { type: 'addConnection', source: trigger, target: 'Get Active Cheat Sheets', sourceIndex: 0, targetIndex: 0 },
  { type: 'addConnection', source: 'Get Active Cheat Sheets', target: 'Get Sentiment Prompts', sourceIndex: 0, targetIndex: 0 },
  { type: 'setNodeParameter', nodeName: P.classify, path: '/options/systemPromptTemplate', value: expr },
  { type: 'setNodeParameter', nodeName: 'Resolve Sentiment Prompts', path: '/jsCode', value: rc },
  { type: 'setNodeParameter', nodeName: 'Build Analysis Plan', path: '/jsCode', value: pc },
];
writeFileSync(path.join(outDir, `${platform}-patched.json`), JSON.stringify(w, null, 2));
if (exportPath) writeFileSync(exportPath, JSON.stringify(w, null, 2) + '\n');
writeFileSync(path.join(outDir, `${platform}-cheat-ops.json`), JSON.stringify(ops));
console.log(platform, 'trigger', trigger, 'ops', ops.length, JSON.stringify(ops).length, 'bytes');
