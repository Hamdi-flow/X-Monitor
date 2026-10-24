// Shared code of the weekly sentiment prompt review (n8n "Sentiment Prompt Review").
// n8n Code nodes cannot import files, so build-workflow.mjs pastes this file VERBATIM
// at the top of the Code nodes that need it; tests/lib.test.mjs loads it with plain
// `node --test`. Edit here, rebuild, never edit the pasted copy in n8n.
//
// COMPOSITION MIRRORS the monitors' `Resolve Sentiment Prompts` + `Build Analysis Plan`
// (X: XMonitor - Scheduled Post Tracking, FB: FB - Monitor, IG: IG - Monitor), so the
// review measures exactly what production would send. If those nodes change, change
// composeSystemPrompt / composeClassifierInput / cheatSheetBlock in the same breath.

const PR_PLATFORMS = ['x', 'fb', 'ig'];
const PR_PLATFORM_NAMES = { x: 'X', fb: 'Facebook', ig: 'Instagram' };
const PR_LABELS = ['Positive', 'Neutral', 'Negative'];
const PR_PROMPT_KEYS = ['target_stance_rules', 'comment_text', 'comment_image'];
const PR_CHEAT_MARKER = '[[CHEAT_SHEET_BLOCK]]';
const PR_MAX_CHANGE = 0.25;
const PR_MAX_SHEET = 2000;

// ---------------------------------------------------------------- composition

function prEscapeForLangChain(s) {
  const T = '\u0000CATEGORIES\u0000';
  return s.split('{categories}').join(T).split('{').join('{{').split('}').join('}}').split(T).join('{categories}');
}
function prEscapeTemplateBraces(value) {
  return String(value).split('{').join('{{').split('}').join('}}');
}
function prTidy(s) { return s.replace(/\n{3,}/g, '\n\n').trim(); }

/** comment_text as Resolve Sentiment Prompts composes it, cheat-sheet marker kept. */
function prComposeTextPrompt(prompts) {
  const rules = prompts.target_stance_rules.system_prompt.trim();
  let s = prompts.comment_text.system_prompt.split('{{target_stance_rules}}').join(rules);
  if (!s.includes('{{cheat_sheet_block}}')) s += '\n\n{{cheat_sheet_block}}';
  s = s.split('{{cheat_sheet_block}}').join('\u0001CHEAT\u0001');
  if (!s.includes('{categories}')) s += '\n\nCategorize the comment into one of the following: {categories}.';
  return prTidy(prEscapeForLangChain(s).split('\u0001CHEAT\u0001').join(PR_CHEAT_MARKER));
}

/**
 * What Build Analysis Plan puts where the marker is. X always says something; Facebook
 * and Instagram add nothing when the client has no active sheet (their prompt is then
 * byte-identical to what they sent before cheat sheets existed).
 */
function prCheatSheetBlock(platform, sheet) {
  if (sheet && sheet.rules_text) {
    return prEscapeTemplateBraces('Client-specific labelling rules (cheat sheet v' + sheet.version + '). Apply these over your general judgement whenever they match:\n' + sheet.rules_text);
  }
  return platform === 'x' ? 'No client-specific labelling rules are configured for this client. Use your general judgement.' : '';
}

/**
 * The Classify Sentiment node's systemPromptTemplate expression. X joins the block in;
 * FB and IG also collapse the blank lines an empty block leaves behind, which keeps
 * their no-sheet prompt identical to the old marker-less one.
 */
function prSystemPrompt(composedText, platform, sheet) {
  const s = composedText.split(PR_CHEAT_MARKER).join(prCheatSheetBlock(platform, sheet));
  return platform === 'x' ? s : s.replace(/\n{3,}/g, '\n\n');
}

function prFillTemplate(tpl, values) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (m, k) => Object.prototype.hasOwnProperty.call(values, k) ? String(values[k]) : m);
}
function prClassifierInput(userTemplate, c) {
  let post = c.post ? String(c.post).trim() : '';
  if (post.length > 1000) post = post.slice(0, 1000) + ' [...]';
  return prFillTemplate(userTemplate, {
    owner: c.owner || 'unknown',
    post: post || '(no text)',
    author_note: c.is_owner ? ' (written by the account owner)' : '',
    comment: String(c.comment || ''),
  });
}

// ---------------------------------------------------------------- proposals

/** Apply the reviewer's find/replace edits. Each `find` must occur exactly once. */
function prApplyEdits(basePrompts, edits) {
  const candidate = {};
  const annotated = [];
  for (const raw of Array.isArray(edits) ? edits : []) {
    const e = { key: String(raw && raw.key || ''), find: String(raw && raw.find || ''), replace: String(raw && raw.replace != null ? raw.replace : ''), reason: String(raw && raw.reason || ''), accepted: false, problem: null };
    annotated.push(e);
    if (!PR_PROMPT_KEYS.includes(e.key)) { e.problem = 'unknown prompt row'; continue; }
    const current = candidate[e.key] != null ? candidate[e.key] : (basePrompts[e.key] && basePrompts[e.key].system_prompt);
    if (typeof current !== 'string') { e.problem = 'prompt row missing'; continue; }
    if (e.find === '') { e.problem = 'empty find text'; continue; }
    const first = current.indexOf(e.find);
    if (first < 0) { e.problem = 'find text not in the row'; continue; }
    if (current.indexOf(e.find, first + 1) >= 0) { e.problem = 'find text occurs more than once'; continue; }
    if (e.find === e.replace) { e.problem = 'no change'; continue; }
    candidate[e.key] = current.slice(0, first) + e.replace + current.slice(first + e.find.length);
    e.accepted = true;
  }
  return { candidate, edits: annotated };
}

const PR_REQUIRED = {
  comment_text: ['{{target_stance_rules}}', '{{cheat_sheet_block}}', '{categories}'],
  comment_image: ['{{target_stance_rules}}'],
  target_stance_rules: [],
};

/** Words changed (removed + added) as a share of the base row's words. */
function prChangeRatio(a, b) {
  const ops = prDiffTokens(prWords(a), prWords(b));
  let changed = 0, base = 0;
  for (const op of ops) {
    const n = (op.text.match(/[^\s]+/g) || []).length;
    if (op.type !== 'add') base += n;
    if (op.type !== 'same') changed += n;
  }
  return base === 0 ? 1 : changed / base;
}

/** Form checks for one candidate row. Returns problems; empty = fine. */
function prCheckRow(key, base, cand) {
  const problems = [];
  if (cand.trim() === '') problems.push('the row would be empty');
  for (const p of PR_REQUIRED[key] || []) {
    const has = (s) => p === '{categories}' ? /(^|[^{])\{categories\}(?!\})/.test(s) : s.includes(p);
    if (has(base) && !has(cand)) problems.push('removes ' + p);
  }
  if (key === 'comment_image' && /json/i.test(base) && !/json/i.test(cand)) problems.push('removes the JSON instruction');
  if (key === 'target_stance_rules' && cand.includes('{{target_stance_rules}}')) problems.push('the rules cannot contain {{target_stance_rules}}');
  const ratio = prChangeRatio(base, cand);
  if (ratio > PR_MAX_CHANGE) problems.push('changes ' + Math.round(ratio * 100) + '% of the row (limit ' + Math.round(PR_MAX_CHANGE * 100) + '%)');
  return { problems, ratio };
}

function prCheckSheet(s, clientIds) {
  const problems = [];
  if (!PR_PLATFORMS.includes(s.platform)) problems.push('unknown platform');
  if (!clientIds.has(s.client_id)) problems.push('unknown client');
  if (String(s.rules_text || '').length > PR_MAX_SHEET) problems.push('longer than ' + PR_MAX_SHEET + ' characters');
  if (String(s.rules_text || '').includes(PR_CHEAT_MARKER)) problems.push('contains the cheat-sheet marker');
  return problems;
}

// ---------------------------------------------------------------- diff

function prWords(s) { return String(s).match(/\s+|[^\s]+/g) || []; }
function prLines(s) { return String(s) === '' ? [] : String(s).split('\n'); }

/** LCS diff of two token arrays -> [{type: same|add|del, text}], merged runs. */
function prDiffTokens(a, b) {
  const n = a.length, m = b.length;
  // Trim the common prefix and suffix first: prompts change in small places.
  let pre = 0; while (pre < n && pre < m && a[pre] === b[pre]) pre++;
  let suf = 0; while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
  const A = a.slice(pre, n - suf), B = b.slice(pre, m - suf);
  const rows = A.length + 1, cols = B.length + 1;
  const L = new Array(rows * cols).fill(0);
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) {
    L[i * cols + j] = A[i] === B[j] ? L[(i + 1) * cols + j + 1] + 1 : Math.max(L[(i + 1) * cols + j], L[i * cols + j + 1]);
  }
  const ops = [];
  const push = (type, text) => { const last = ops[ops.length - 1]; if (last && last.type === type) last.text += text; else ops.push({ type, text }); };
  for (const t of a.slice(0, pre)) push('same', t);
  let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { push('same', A[i]); i++; j++; }
    else if (L[(i + 1) * cols + j] >= L[i * cols + j + 1]) { push('del', A[i]); i++; }
    else { push('add', B[j]); j++; }
  }
  while (i < A.length) push('del', A[i++]);
  while (j < B.length) push('add', B[j++]);
  for (const t of a.slice(n - suf)) push('same', t);
  return ops;
}

/**
 * Git-style line diff with word highlights: [{type: ctx|del|add|gap, text, words?}].
 * `words` (on del/add lines that pair up) marks the changed words inside the line.
 */
function prLineDiff(a, b, context) {
  const ctx = context == null ? 2 : context;
  const sep = '\n';
  const ops = prDiffTokens(prLines(a).map(l => l + sep), prLines(b).map(l => l + sep));
  const lines = [];
  for (const op of ops) {
    const parts = op.text.split(sep); parts.pop();
    for (const p of parts) lines.push({ type: op.type === 'same' ? 'ctx' : op.type, text: p });
  }
  // Pair runs of deleted and added lines so changed words can be highlighted.
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].type !== 'del') continue;
    let d = k; while (d < lines.length && lines[d].type === 'del') d++;
    let e = d; while (e < lines.length && lines[e].type === 'add') e++;
    for (let x = 0; x < Math.min(d - k, e - d); x++) {
      const w = prDiffTokens(prWords(lines[k + x].text), prWords(lines[d + x].text));
      lines[k + x].words = w.filter(o => o.type !== 'add');
      lines[d + x].words = w.filter(o => o.type !== 'del');
    }
    k = e - 1;
  }
  const keep = lines.map(() => false);
  lines.forEach((l, k) => { if (l.type !== 'ctx') for (let z = Math.max(0, k - ctx); z <= Math.min(lines.length - 1, k + ctx); z++) keep[z] = true; });
  const out = [];
  let skipped = 0;
  lines.forEach((l, k) => {
    if (keep[k]) { if (skipped) out.push({ type: 'gap', text: skipped + ' unchanged line' + (skipped === 1 ? '' : 's') }); skipped = 0; out.push(l); }
    else skipped++;
  });
  if (skipped) out.push({ type: 'gap', text: skipped + ' unchanged line' + (skipped === 1 ? '' : 's') });
  return out;
}

// ---------------------------------------------------------------- metrics

/** results: [{id, variant: current|candidate, label|null}] -> per-case before/after. */
function prScore(cases, results) {
  const by = new Map();
  for (const r of results) {
    const e = by.get(r.id) || {};
    e[r.variant] = r.label || null;
    by.set(r.id, e);
  }
  const labelled = { n: 0, before_correct: 0, after_correct: 0, unmeasured: 0, fixed: [], broken: [], still_wrong: 0, wrong: [] };
  const stability = { n: 0, flips: [], unmeasured: 0 };
  for (const c of cases) {
    const r = by.get(c.id) || {};
    const before = r.current || null, after = r.candidate || null;
    if (!before || !after) { (c.kind === 'labelled' ? labelled : stability).unmeasured++; continue; }
    const row = { id: c.id, platform: c.platform, client_name: c.client_name || null, owner: c.owner, post: c.post, comment: c.comment, model_label: c.model_label, before, after };
    if (c.kind === 'labelled') {
      labelled.n++;
      const ok0 = before === c.human_label, ok1 = after === c.human_label;
      if (ok0) labelled.before_correct++;
      if (ok1) labelled.after_correct++;
      if (!ok0 && !ok1) labelled.still_wrong++;
      const full = { ...row, human_label: c.human_label, human_note: c.human_note || null, is_new: !!c.is_new };
      if (!ok0 && ok1) labelled.fixed.push(full);
      if (!ok0 && !ok1) labelled.wrong.push(full);
      if (ok0 && !ok1) labelled.broken.push(full);
    } else {
      stability.n++;
      if (before !== after) stability.flips.push(row);
    }
  }
  return { labelled, stability };
}

// ---------------------------------------------------------------- report (email + console)

function prEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function prPct(a, n) { return n ? Math.round((a / n) * 1000) / 10 + '%' : 'n/a'; }

const PR_C = {
  ink: '#1f2328', muted: '#59636e', line: '#d1d9e0', bg: '#ffffff', soft: '#f6f8fa',
  addBg: '#e6ffec', addWord: '#abf2bc', addInk: '#116329', delBg: '#ffebe9', delWord: '#ffcecb', delInk: '#82071e',
  gapBg: '#ddf4ff', gapInk: '#0550ae', warnBg: '#fff8c5', warnInk: '#7d4e00',
};
const PR_LABEL_COLOR = { Positive: '#1a7f37', Neutral: '#59636e', Negative: '#cf222e' };

function prBadge(label) {
  const c = PR_LABEL_COLOR[label] || PR_C.muted;
  return '<span style="display:inline-block;padding:1px 7px;border-radius:10px;border:1px solid ' + c + ';color:' + c + ';font-size:12px;font-weight:600;white-space:nowrap">' + prEsc(label || 'none') + '</span>';
}
function prArrow(a, b) { return prBadge(a) + ' <span style="color:' + PR_C.muted + '">&rarr;</span> ' + prBadge(b); }

function prDiffHtml(a, b) {
  const mono = 'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;';
  let rows = '';
  for (const l of prLineDiff(a, b, 1)) {
    if (l.type === 'gap') { rows += '<tr><td style="' + mono + 'background:' + PR_C.gapBg + ';color:' + PR_C.gapInk + ';padding:2px 8px">@@ ' + prEsc(l.text) + ' @@</td></tr>'; continue; }
    const sign = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
    const bg = l.type === 'add' ? PR_C.addBg : l.type === 'del' ? PR_C.delBg : PR_C.bg;
    const wbg = l.type === 'add' ? PR_C.addWord : PR_C.delWord;
    const body = l.words
      ? l.words.map(w => w.type === 'same' ? prEsc(w.text) : '<span style="background:' + wbg + ';border-radius:2px">' + prEsc(w.text) + '</span>').join('')
      : prEsc(l.text);
    const ink = l.type === 'add' ? PR_C.addInk : l.type === 'del' ? PR_C.delInk : PR_C.ink;
    rows += '<tr><td style="' + mono + 'background:' + bg + ';color:' + PR_C.ink + ';padding:1px 8px;white-space:pre-wrap;word-break:break-word"><span style="color:' + ink + ';user-select:none">' + sign + ' </span>' + (body || '&nbsp;') + '</td></tr>';
  }
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ' + PR_C.line + ';border-radius:6px;border-collapse:separate;overflow:hidden">' + rows + '</table>';
}

function prCaseHtml(c, kind) {
  const head = kind === 'flip' ? prArrow(c.before, c.after) : prArrow(c.before, c.after) + ' &nbsp;<span style="color:' + PR_C.muted + ';font-size:12px">human:</span> ' + prBadge(c.human_label);
  const meta = PR_PLATFORM_NAMES[c.platform] + ' &middot; ' + prEsc(c.owner || '') + (c.client_name ? ' &middot; ' + prEsc(c.client_name) : '') + (c.is_new ? ' &middot; <b>new this week</b>' : '');
  const post = c.post ? String(c.post).trim() : '';
  const postShort = post.length > 220 ? post.slice(0, 220) + '…' : post;
  return '<tr><td style="padding:10px 12px;border-top:1px solid ' + PR_C.line + '">'
    + '<div style="margin-bottom:4px">' + head + '</div>'
    + '<div style="font-size:14px;color:' + PR_C.ink + ';white-space:pre-wrap;word-break:break-word" dir="auto">' + prEsc(c.comment) + '</div>'
    + (c.human_note ? '<div style="font-size:13px;color:' + PR_C.ink + ';margin-top:4px">Note: <i dir="auto">' + prEsc(c.human_note) + '</i></div>' : '')
    + '<div style="font-size:12px;color:' + PR_C.muted + ';margin-top:4px">' + meta + (postShort ? ' &middot; on: <span dir="auto">' + prEsc(postShort) + '</span>' : '') + '</div>'
    + '</td></tr>';
}

function prSection(title, subtitle, inner) {
  return '<h2 style="font-size:17px;margin:28px 0 4px;color:' + PR_C.ink + '">' + title + '</h2>'
    + (subtitle ? '<div style="font-size:13px;color:' + PR_C.muted + ';margin-bottom:8px">' + subtitle + '</div>' : '')
    + inner;
}
function prCaseTable(list, kind, empty) {
  if (!list.length) return '<div style="font-size:13px;color:' + PR_C.muted + '">' + empty + '</div>';
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ' + PR_C.line + ';border-radius:6px;border-collapse:separate">' + list.map(c => prCaseHtml(c, kind)).join('') + '</table>';
}

/**
 * The whole report as one HTML document (inline styles only, so Gmail keeps it).
 * The console shows the same HTML in a sandboxed frame.
 */
function prRenderReport(r) {
  const env = r.environment ? '[' + r.environment + '] ' : '';
  const m = r.metrics;
  const statusLine = {
    skipped: 'Skipped: ' + r.new_label_count + ' new label' + (r.new_label_count === 1 ? '' : 's') + ' since the last review (needs at least ' + r.min_new_labels + ').',
    no_change: 'No change proposed.',
    pending: 'Waiting for your approval. Nothing has been applied.',
    failed: 'The review failed: ' + (r.error || 'unknown error'),
  }[r.status] || r.status;
  let top = '';
  if (m) {
    const n = m.labelled.n;
    const before = prPct(m.labelled.before_correct, n), after = prPct(m.labelled.after_correct, n);
    const delta = n ? Math.round(((m.labelled.after_correct - m.labelled.before_correct) / n) * 1000) / 10 : 0;
    const dColor = delta > 0 ? PR_LABEL_COLOR.Positive : delta < 0 ? PR_LABEL_COLOR.Negative : PR_C.muted;
    const cell = (big, small, color) => '<td style="padding:10px 12px;border:1px solid ' + PR_C.line + ';border-radius:6px;vertical-align:top"><div style="font-size:24px;font-weight:700;color:' + (color || PR_C.ink) + '">' + big + '</div><div style="font-size:12px;color:' + PR_C.muted + '">' + small + '</div></td>';
    top = '<table role="presentation" width="100%" cellpadding="0" cellspacing="6" style="border-collapse:separate;margin:8px -6px"><tr>'
      + cell(before + ' &rarr; ' + after, 'accuracy on ' + n + ' labelled comments', PR_C.ink)
      + cell((delta > 0 ? '+' : '') + delta + ' pts', m.labelled.fixed.length + ' fixed &middot; ' + m.labelled.broken.length + ' broken', dColor)
      + cell(m.stability.flips.length + ' / ' + m.stability.n, 'unlabelled comments that change label', m.stability.flips.length ? PR_C.warnInk : PR_C.ink)
      + '</tr></table>';
  }
  let body = '';
  if (r.summary) body += '<p style="font-size:14px;color:' + PR_C.ink + ';margin:12px 0">' + prEsc(r.summary) + '</p>';

  const keys = Object.keys(r.candidate_prompts || {});
  const sheets = r.cheat_sheet_proposals || [];
  if (keys.length) {
    body += prSection('Prompt changes', 'Shared by X, Facebook and Instagram. Red lines are removed, green lines are added.',
      keys.map(k => '<div style="font-size:13px;font-weight:600;margin:12px 0 4px;font-family:ui-monospace,Menlo,Consolas,monospace">' + prEsc(k) + '</div>'
        + prDiffHtml(r.base_prompts[k].system_prompt, r.candidate_prompts[k].system_prompt)).join(''));
  }
  if (sheets.length) {
    body += prSection('Cheat-sheet changes', 'Per client and platform. Only that client\'s comments on that platform see these rules.',
      sheets.map(s => '<div style="font-size:13px;font-weight:600;margin:12px 0 4px">' + prEsc(s.client_name || s.client_id) + ' &middot; ' + PR_PLATFORM_NAMES[s.platform]
        + ' <span style="font-weight:400;color:' + PR_C.muted + '">' + (s.base_version ? 'v' + s.base_version + ' &rarr; v' + (Number(s.base_version) + 1) : 'new sheet') + '</span></div>'
        + (s.reason ? '<div style="font-size:12px;color:' + PR_C.muted + ';margin-bottom:4px">' + prEsc(s.reason) + '</div>' : '')
        + prDiffHtml(s.base_rules || '', s.rules_text || '')).join(''));
  }
  const rejected = (r.prompt_edits || []).filter(e => !e.accepted);
  const problems = (r.checks || []).filter(c => c.problems && c.problems.length);
  if (rejected.length || problems.length) {
    body += prSection('Dropped by the checks', 'Proposed by the reviewer but not part of this proposal.',
      '<ul style="font-size:13px;color:' + PR_C.warnInk + ';background:' + PR_C.warnBg + ';padding:8px 8px 8px 28px;border-radius:6px;margin:0">'
      + rejected.map(e => '<li>' + prEsc(e.key) + ': ' + prEsc(e.problem) + (e.reason ? ' (' + prEsc(e.reason) + ')' : '') + '</li>').join('')
      + problems.map(c => '<li>' + prEsc(c.target) + ': ' + prEsc(c.problems.join('; ')) + '</li>').join('') + '</ul>');
  }
  if (m) {
    body += prSection('What the new prompt now catches', 'Labelled comments the current prompt gets wrong and the proposal gets right.',
      prCaseTable(m.labelled.fixed, 'fixed', 'None.'));
    body += prSection('What it breaks', 'Labelled comments the current prompt gets right and the proposal gets wrong.',
      prCaseTable(m.labelled.broken, 'broken', 'None.'));
    body += prSection('Still wrong', 'Labelled comments both prompts get wrong. Each needs something this edit does not give: context the classifier never sees (a video, an image, the comment it replies to), a rule about this client\'s stance, or a second look at the label itself.',
      prCaseTable(m.labelled.wrong || [], 'broken', m.labelled.still_wrong ? m.labelled.still_wrong + ' (listed from the next run on).' : 'None.'));
    body += prSection('Unlabelled comments that change label', m.stability.n + ' random recent comments nobody has labelled, re-labelled with both prompts. Each flip is a change real alerts would see.',
      prCaseTable(m.stability.flips, 'flip', 'None: every one keeps its label.'));
    body += '<div style="font-size:12px;color:' + PR_C.muted + ';margin-top:16px">Measured with the production classifier (' + prEsc(m.model) + ', temperature ' + prEsc(m.temperature) + ', same composition as the monitors). '
      + m.labelled.still_wrong + ' labelled comment' + (m.labelled.still_wrong === 1 ? ' stays' : 's stay') + ' wrong under both. '
      + (m.labelled.unmeasured + m.stability.unmeasured ? (m.labelled.unmeasured + m.stability.unmeasured) + ' classification' + (m.labelled.unmeasured + m.stability.unmeasured === 1 ? '' : 's') + ' failed and are left out. ' : '')
      + 'Images are not stored, so comments are re-labelled from their text.' + (keys.includes('comment_image') ? ' The comment_image change is therefore NOT measured.' : '') + '</div>';
  }
  const decide = r.status === 'pending'
    ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 0"><tr><td style="background:' + PR_C.soft + ';border:1px solid ' + PR_C.line + ';border-radius:6px;padding:12px;font-size:14px;color:' + PR_C.ink + '">'
      + '<b>To apply it</b>, approve review #' + r.id + ' in the console' + (r.console_url ? ': <a href="' + prEsc(r.console_url) + '/prompts/reviews?review=' + r.id + '">open Prompt reviews</a>' : '')
      + ', or reply <code>approve ' + r.id + '</code> (or <code>reject ' + r.id + '</code>) to the Claude run that sent this. Nothing changes until then; an approved edit can be undone with Restore on the Prompts page.</td></tr></table>'
    : '';
  const meta = '<div style="font-size:12px;color:' + PR_C.muted + ';margin-top:20px">Review #' + r.id + ' &middot; ' + r.new_label_count + ' new label' + (r.new_label_count === 1 ? '' : 's') + ' since ' + prEsc(r.window_from ? String(r.window_from).slice(0, 10) : 'the start') + ', ' + r.total_label_count + ' in the test set.</div>';
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sentiment prompt review #' + r.id + '</title></head>'
    + '<body style="margin:0;padding:0;background:' + PR_C.soft + '"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:16px">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:760px;background:' + PR_C.bg + ';border:1px solid ' + PR_C.line + ';border-radius:8px"><tr><td style="padding:20px 20px 24px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">'
    + '<div style="font-size:12px;color:' + PR_C.muted + ';text-transform:uppercase;letter-spacing:.04em">' + prEsc(env) + 'Weekly sentiment prompt review #' + r.id + '</div>'
    + '<h1 style="font-size:20px;margin:6px 0 4px;color:' + PR_C.ink + '">' + prEsc(statusLine) + '</h1>'
    + top + body + decide + meta
    + '</td></tr></table></td></tr></table></body></html>';
}

function prSubject(r) {
  const env = r.environment ? '[' + r.environment + '] ' : '';
  if (r.status === 'pending' && r.metrics) {
    const n = r.metrics.labelled.n;
    return env + 'Sentiment prompt review #' + r.id + ': ' + prPct(r.metrics.labelled.before_correct, n) + ' → ' + prPct(r.metrics.labelled.after_correct, n) + ', approval needed';
  }
  return env + 'Sentiment prompt review #' + r.id + ': ' + ({ skipped: 'skipped this week', no_change: 'no change proposed', failed: 'FAILED' }[r.status] || r.status);
}

// ---------------------------------------------------------------- SQL

/** A dollar-quoted literal whose tag cannot occur in the value. */
function prDollar(value) {
  const s = String(value);
  let tag;
  do { tag = '$pr' + Math.random().toString(36).slice(2, 10) + '$'; } while (s.includes(tag));
  return tag + s + tag;
}
function prSqlValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return prDollar(v);
}

if (typeof module !== 'undefined') {
  module.exports = {
    PR_PROMPT_KEYS, PR_CHEAT_MARKER, prComposeTextPrompt, prCheatSheetBlock, prSystemPrompt, prClassifierInput,
    prApplyEdits, prCheckRow, prCheckSheet, prChangeRatio, prDiffTokens, prLineDiff, prScore, prRenderReport, prSubject,
    prEsc, prDollar, prSqlValue, prEscapeForLangChain,
  };
}
