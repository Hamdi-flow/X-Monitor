// Applies the "service ids from table" change to a router export.
// Usage: node patch-router.mjs <export.json> <postgresCredId> <postgresCredName> <versionId|-> <updatedAt|->
import fs from 'fs';
import { randomUUID } from 'crypto';
const [file, credId, credName, versionId, updatedAt] = process.argv.slice(2);
const raw = fs.readFileSync(file, 'utf8');
const bom = raw.startsWith('\uFEFF');
const d = JSON.parse(raw.replace(/^\uFEFF/, ''));
const by = Object.fromEntries(d.nodes.map((n) => [n.name, n]));
const c = d.connections;
const cred = { postgres: { id: credId, name: credName } };
const q = (col, what) => `-- The SMMWiz service id X ${what} orders buy. Edited on the console's /settings/smm page;\n-- every change is logged in "SMM Service ID History". Always exactly one row: NULL when the\n-- smmwiz_x row is missing, inactive or has no id, which disarms the order (next node).\nSELECT (\n  SELECT ${col} FROM public."FB SMM Settings"\n   WHERE provider = 'smmwiz_x' AND is_active\n   ORDER BY id LIMIT 1\n) AS service_id;`;
const ifp = (id) => ({ conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 3 }, conditions: [{ id, leftValue: "={{ /^[1-9][0-9]{0,9}$/.test(String($json.service_id ?? '')) }}", rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} });
const refuse = (p, msg) => ({ assignments: { assignments: [{ id: `refuse-${p}-chat`, name: 'telegram_chat_id', value: "={{ $('Parse Telegram Message').first().json.telegram_chat_id }}", type: 'string' }, { id: `refuse-${p}-msg`, name: 'order_user_message', value: msg, type: 'string' }] }, options: {} });
function branch({ load, iff, ref, col, what, pos, refusePos, refuseMsg, p, from, fromIndex, prepare, sendError }) {
  if (by[load]) throw new Error(`${load} already exists`);
  d.nodes.push(
    { parameters: { operation: 'executeQuery', query: q(col, what), options: {} }, type: 'n8n-nodes-base.postgres', typeVersion: 2.6, position: pos[0], id: randomUUID(), name: load, credentials: cred },
    { parameters: ifp(`x-${what}-service-id-set`), type: 'n8n-nodes-base.if', typeVersion: 2.3, position: pos[1], id: randomUUID(), name: iff },
    { parameters: refuse(p, refuseMsg), type: 'n8n-nodes-base.set', typeVersion: 3.4, position: refusePos, id: randomUUID(), name: ref },
  );
  const out = c[from].main[fromIndex];
  const i = out.findIndex((e) => e.node === prepare);
  if (i < 0) throw new Error(`${from} -> ${prepare} not found`);
  out[i] = { node: load, type: 'main', index: 0 };
  c[load] = { main: [[{ node: iff, type: 'main', index: 0 }]] };
  c[iff] = { main: [[{ node: prepare, type: 'main', index: 0 }], [{ node: ref, type: 'main', index: 0 }]] };
  c[ref] = { main: [[{ node: sendError, type: 'main', index: 0 }]] };
  const sid = by[prepare].parameters.assignments.assignments.find((a) => a.name === 'serviceId');
  sid.value = `={{ $('${load}').first().json.service_id }}`;
}
branch({ load: 'Load X Likes Service Id', iff: 'If X Likes Service Id Set', ref: 'Refuse Likes Order No Service Id', col: 'likes_service_id', what: 'likes', p: 'likes',
  pos: [[-12624, 1184], [-12400, 1184]], refusePos: [-12176, 1568], from: 'Set Likes Service Config', fromIndex: 0, prepare: 'Prepare Likes Order Request', sendError: 'Send Likes Order Error',
  refuseMsg: "I did not place the likes order: no X likes service id is configured. Set one on the console's SMM service ids page first." });
branch({ load: 'Load X Comments Service Id', iff: 'If X Comments Service Id Set', ref: 'Refuse Comment Order No Service Id', col: 'comments_service_id', what: 'comments', p: 'comments',
  pos: [[-11280, 160], [-11056, 160]], refusePos: [-10832, 736], from: 'Route Comment Order Decision', fromIndex: 0, prepare: 'Prepare Comment Order Request', sendError: 'Send Comment Order Error',
  refuseMsg: "I did not place the comments order: no X comments service id is configured. Set one on the console's SMM service ids page first. Nothing was charged." });
if (versionId !== '-') d.versionId = versionId;
if (updatedAt !== '-') d.updatedAt = updatedAt;
fs.writeFileSync(file, (bom ? '\uFEFF' : '') + JSON.stringify(d, null, 2) + '\n');
console.log(file, d.nodes.length, 'nodes');
