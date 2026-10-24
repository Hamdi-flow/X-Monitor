// Finish Review: record whether the email went out, and return the run's summary (what
// the Claude scheduled task reads). The Gmail node continues on error, so a failed send
// still reaches here with an error instead of an id. (lib.js is pasted above this line.)
const rec = $('Build Record').first().json;
const mail = $input.first().json || {};
const ok = !!mail.id;
const err = ok ? null : String(mail.error && (mail.error.message || mail.error) || mail.message || 'email not sent').slice(0, 500);
const id = String(Number(rec.review_id));
const RET = ` RETURNING id, status, email_sent_at, email_error, new_label_count, total_label_count, summary,
  (metrics->'labelled'->>'n')::int AS labelled_n,
  (metrics->'labelled'->>'before_correct')::int AS before_correct,
  (metrics->'labelled'->>'after_correct')::int AS after_correct,
  jsonb_array_length(coalesce(metrics->'labelled'->'fixed', '[]')) AS fixed,
  jsonb_array_length(coalesce(metrics->'labelled'->'broken', '[]')) AS broken,
  (metrics->'stability'->>'n')::int AS stability_n,
  jsonb_array_length(coalesce(metrics->'stability'->'flips', '[]')) AS stability_flips,
  (SELECT count(*) FROM jsonb_object_keys(candidate_prompts))::int AS changed_rows,
  jsonb_array_length(cheat_sheet_proposals) AS cheat_sheets, error;`;
const set = ok ? 'email_sent_at = now(), email_error = NULL' : 'email_error = ' + prSqlValue(err);
return [{ json: { sql: 'UPDATE public."Sentiment Prompt Reviews" SET ' + set + ' WHERE id = ' + id + RET } }];
