// Compares a live workflow (a saved get_workflow_details result) with the local build.
// Code nodes are compared with blank lines and comment-only lines ignored (the push may
// reflow those); every other parameter must match exactly. Exits 1 on any difference.
//
//   node tools/prompt-review/compare-live.mjs staging <get_workflow_details.json>
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [env, file] = process.argv.slice(2);
const local = JSON.parse(readFileSync(path.join(here, '../../workflows', env === 'staging' ? 'staging' : 'active', `sentiment-prompt-review-${env}.json`), 'utf8'));
const raw = JSON.parse(readFileSync(file, 'utf8'));
const live = raw.workflow || raw;
const norm = s => String(s).replace(/\r\n/g, '\n').split('\n').map(l => l.trimEnd()).filter(l => l.trim() !== '' && !/^\s*(\/\/|\/\*\*|\*)/.test(l)).join('\n');
const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x);
let bad = 0;
for (const n of local.nodes) {
  const l = live.nodes.find(x => x.name === n.name);
  if (!l) { console.log('MISSING', n.name); bad++; continue; }
  const { jsCode, ...rest } = n.parameters;
  const { jsCode: liveCode, ...liveRest } = l.parameters;
  if (jsCode !== undefined && norm(jsCode) !== norm(liveCode)) {
    const a = norm(jsCode).split('\n'), b = norm(liveCode).split('\n');
    const i = a.findIndex((x, k) => x !== b[k]);
    console.log('CODE DIFFERS', n.name, 'line', i, '\n  local:', a[i], '\n  live: ', b[i]); bad++;
  }
  if (canon(rest) !== canon(liveRest)) { console.log('PARAMS DIFFER', n.name, '\n  local:', canon(rest).slice(0, 300), '\n  live: ', canon(liveRest).slice(0, 300)); bad++; }
  for (const k of ['type', 'typeVersion', 'onError', 'retryOnFail', 'maxTries', 'executeOnce']) {
    if ((n[k] ?? null) !== (l[k] ?? null)) { console.log('FIELD', n.name, k, n[k], '!=', l[k]); bad++; }
  }
}
const conns = c => canon(Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v])));
if (conns(local.connections) !== conns(live.connections)) { console.log('CONNECTIONS DIFFER'); bad++; }
console.log(bad ? `${bad} difference(s)` : `live matches local build (${local.nodes.length} nodes)`);
process.exit(bad ? 1 : 0);
