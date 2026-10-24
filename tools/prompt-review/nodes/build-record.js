// Build Record: score the classifier results (when there are any), render the report,
// and build the INSERT for "Sentiment Prompt Reviews". ONE item out.
// Reached three ways: Merge Labels (a measured proposal), Has Proposal's false branch
// (skipped / no_change / failed after the reviewer) and Plan Review's skip branch.
// (lib.js is pasted above this line.)
const items = $input.all();
let review;
if (items[0].json.mode === 'classify') {
  const check = $('Check Proposal').first().json;
  review = { ...check.review };
  const results = items.map(i => ({ id: i.json.id, variant: i.json.variant, label: i.json.classification_failed ? null : (PR_LABELS.includes(i.json.sentiment) ? i.json.sentiment : null) }));
  // client_stances: the stance version each client was measured with (both variants), so
  // a decision can be checked later against "Client Stances" history.
  review.metrics = { ...prScore(review.cases, results), model: check.model, temperature: check.temperature, client_stances: review.client_stances || [] };
  delete review.cases;
} else {
  review = { ...items[0].json.review };
}

const report_html = prRenderReport(review);
const subject = prSubject(review);
const j = v => prSqlValue(JSON.stringify(v == null ? null : v)) + '::jsonb';
const sql = 'INSERT INTO public."Sentiment Prompt Reviews" (id, status, window_from, window_to, new_label_count, total_label_count, summary, base_prompts, candidate_prompts, prompt_edits, cheat_sheet_proposals, corrections, checks, metrics, report_html, error, n8n_execution_id) OVERRIDING SYSTEM VALUE VALUES ('
  + [
    String(Number(review.id)),
    prSqlValue(review.status),
    review.window_from ? prSqlValue(review.window_from) + '::timestamptz' : 'NULL',
    prSqlValue(review.window_to) + '::timestamptz',
    String(Number(review.new_label_count) || 0),
    String(Number(review.total_label_count) || 0),
    prSqlValue(review.summary),
    j(review.base_prompts),
    j(review.candidate_prompts || {}),
    j(review.prompt_edits || []),
    j(review.cheat_sheet_proposals || []),
    j(review.corrections || []),
    j(review.checks || []),
    review.metrics ? j(review.metrics) : 'NULL',
    prSqlValue(report_html),
    prSqlValue(review.error),
    prSqlValue(String($execution.id)),
  ].join(', ')
  + ') RETURNING id, status;';

return [{ json: { review_id: review.id, status: review.status, subject, report_html, sql } }];
