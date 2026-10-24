// Check Proposal: parse the reviewer's answer, apply its edits, run the form checks,
// and emit one classifier item per (comment, prompt variant). Item 0 also carries the
// review so far, read by Build Record as $('Check Proposal').first().json.review.
// (lib.js is pasted above this line.)
const plan = $('Plan Review').first().json;
const review = { ...plan.review };
const res = $input.first().json || {};

// Anthropic Messages API response: thinking blocks, then the JSON answer as text. Check
// stop_reason before reading content: a refusal (after any fallback) or a cut-off answer
// is a failed run, never a partial proposal.
let parsed = null;
try {
  if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
  if (res.stop_reason === 'refusal') throw new Error('refused (' + ((res.stop_details && res.stop_details.category) || 'no category') + ')');
  if (res.stop_reason === 'max_tokens') throw new Error('answer cut off at max_tokens');
  const content = (Array.isArray(res.content) ? res.content : []).filter(b => b && b.type === 'text').map(b => b.text).join('');
  if (!content) throw new Error('empty answer (stop_reason ' + res.stop_reason + ')');
  parsed = JSON.parse(content);
  review.reviewer_model = res.model || null;
} catch (e) {
  review.status = 'failed';
  review.error = 'reviewer: ' + e.message;
  return [{ json: { mode: 'record', review } }];
}

review.summary = String(parsed.summary || '').slice(0, 2000) || null;
const labelIds = new Set(plan.labels.map(l => l.id));
review.corrections = (Array.isArray(parsed.corrections) ? parsed.corrections : [])
  .filter(c => c && labelIds.has(String(c.id)))
  .map(c => ({ id: String(c.id), scope: c.scope === 'client' ? 'client' : 'general', reason: String(c.reason || '').slice(0, 500) }));

// Shared rows.
const base = review.base_prompts;
const applied = prApplyEdits(base, parsed.prompt_edits);
review.prompt_edits = applied.edits;
for (const key of Object.keys(applied.candidate)) {
  const c = prCheckRow(key, base[key].system_prompt, applied.candidate[key]);
  review.checks.push({ target: key, problems: c.problems, change_ratio: Math.round(c.ratio * 1000) / 1000 });
  if (!c.problems.length) review.candidate_prompts[key] = { system_prompt: applied.candidate[key] };
}

// Cheat sheets.
const clientIds = new Set(plan.clients.map(c => c.client_id));
const clientName = new Map(plan.clients.map(c => [c.client_id, c.name]));
const activeSheet = (platform, clientId) => plan.sheets.find(s => s.platform === platform && s.client_id === clientId) || null;
const seen = new Set();
for (const raw of Array.isArray(parsed.cheat_sheets) ? parsed.cheat_sheets : []) {
  const s = { platform: String(raw && raw.platform || ''), client_id: String(raw && raw.client_id || ''), rules_text: String(raw && raw.rules_text || '').trim(), reason: String(raw && raw.reason || '').slice(0, 500) };
  const target = 'cheat sheet ' + s.platform + ' / ' + (clientName.get(s.client_id) || s.client_id);
  const problems = prCheckSheet(s, clientIds);
  const k = s.platform + ':' + s.client_id;
  if (seen.has(k)) problems.push('proposed twice');
  seen.add(k);
  const cur = activeSheet(s.platform, s.client_id);
  if (!problems.length && (cur ? cur.rules_text.trim() : '') === s.rules_text) problems.push('same as the current sheet');
  review.checks.push({ target, problems });
  if (problems.length) continue;
  review.cheat_sheet_proposals.push({
    platform: s.platform, client_id: s.client_id, client_name: clientName.get(s.client_id) || null,
    base_version: cur ? cur.version : null, base_rules: cur ? cur.rules_text : null,
    rules_text: s.rules_text, reason: s.reason,
  });
}

if (!Object.keys(review.candidate_prompts).length && !review.cheat_sheet_proposals.length) {
  review.status = 'no_change';
  return [{ json: { mode: 'record', review } }];
}

// Measure: every label (the test set) and the stability sample, each under both prompts.
const tpl = base.comment_text.user_template;
const merged = { ...base };
for (const k of Object.keys(review.candidate_prompts)) merged[k] = { ...base[k], system_prompt: review.candidate_prompts[k].system_prompt };
const composed = { current: prComposeTextPrompt(base), candidate: prComposeTextPrompt(merged) };
const sheetFor = (variant, platform, clientId) => {
  if (variant === 'candidate') {
    const p = review.cheat_sheet_proposals.find(x => x.platform === platform && x.client_id === clientId);
    if (p) return p.rules_text ? { version: (p.base_version || 0) + 1, rules_text: p.rules_text } : null;
  }
  return activeSheet(platform, clientId);
};
const cases = [];
const ids = new Set();
for (const l of plan.labels) {
  if (!String(l.comment || '').trim() || ids.has(l.id)) continue;
  ids.add(l.id);
  cases.push({ ...l, kind: 'labelled' });
}
for (const s of plan.stability) {
  if (ids.has(s.id)) continue;
  ids.add(s.id);
  cases.push({ ...s, client_name: clientName.get(s.client_id) || null, kind: 'stability' });
}
review.cases = cases.map(c => ({ id: c.id, kind: c.kind, platform: c.platform, client_name: c.client_name, owner: c.owner, post: c.post, comment: c.comment, model_label: c.model_label, human_label: c.human_label || null, human_note: c.human_note || null, is_new: !!c.is_new }));
review.status = 'pending';

const out = [];
for (const c of cases) {
  const input = prClassifierInput(tpl, c);
  for (const variant of ['current', 'candidate']) {
    out.push({ json: { mode: 'classify', id: c.id, variant, classifier_input: input, system_prompt: prSystemPrompt(composed[variant], c.platform, sheetFor(variant, c.platform, c.client_id)) } });
  }
}
out[0].json.review = review;
out[0].json.model = base.comment_text.model || 'gpt-5.4-mini';
out[0].json.temperature = Number(base.comment_text.temperature) || 0;
return out;
