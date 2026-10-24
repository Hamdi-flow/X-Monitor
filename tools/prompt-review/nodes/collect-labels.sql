-- Collect Labels: everything one review needs, as ONE row of JSON.
--   labels     every human label on X, Facebook and Instagram (the test set; the ones
--              labelled after last_window_to are this week's evidence)
--   stability  random unlabelled comments with a model label, from the 1000 newest
--   prompts / sheets / clients  the live prompt rows, active cheat sheets, clients
--   next_id    the id this run's "Sentiment Prompt Reviews" row will get, so the
--              report can name it before the row exists
-- The owner / post / comment fields are what Build Analysis Plan in each monitor puts in
-- the classifier input. X stores no reply author, so X replies are never "owner" here.
WITH items AS (
  SELECT 'x:' || r.reply_id AS id, 'x' AS platform,
         coalesce(r.client_id, p.client_id, tu.client_id)::text AS client_id,
         '@' || coalesce(tu.username, 'unknown') || coalesce(' (' || nullif(tu.display_name, '') || ')', '') AS owner,
         p.post_text AS post, r.text AS comment, false AS is_owner,
         r.sentiment AS model_label, r.manual_sentiment AS human_label, r.manual_sentiment_note AS human_note,
         r.manual_labeled_at AS labeled_at, coalesce(r.analyzed_at, r.created_at) AS seen_at
    FROM public."Replies" r
    LEFT JOIN public."Posts" p ON p.post_id = r.post_id
    LEFT JOIN public."Tracked Users" tu ON tu.user_id = p.user_id
  UNION ALL
  SELECT 'fb:' || c.comment_id, 'fb',
         coalesce(p.client_id, cfg.client_id)::text,
         coalesce(nullif(cfg.page_name, ''), 'Facebook Page ' || p.page_id),
         p.post_message, c.comment_message, coalesce(c.commenter_id = p.page_id, false),
         c.sentiment, c.manual_sentiment, c.manual_sentiment_note,
         c.manual_labeled_at, coalesce(c.created_at_on_facebook, c.created_at)
    FROM public."FB Comments" c
    JOIN public."FB Posts" p ON p.post_id = c.post_id
    LEFT JOIN public."FB Monitor Config" cfg ON cfg.page_id = p.page_id
  UNION ALL
  SELECT 'ig:' || c.comment_id, 'ig',
         cfg.client_id::text,
         '@' || coalesce(cfg.ig_username, 'unknown') || coalesce(' (' || nullif(cfg.page_name, '') || ')', ''),
         m.caption, c.comment_text, coalesce(c.is_owner_comment, false),
         c.sentiment, c.manual_sentiment, c.manual_sentiment_note,
         c.manual_labeled_at, coalesce(c.created_at_on_instagram, c.created_at)
    FROM public."IG Comments" c
    JOIN public."IG Media" m ON m.media_id = c.media_id
    LEFT JOIN public."IG Monitor Config" cfg ON cfg.ig_user_id = m.ig_user_id
),
recent AS (
  SELECT * FROM items
   WHERE human_label IS NULL AND model_label IN ('Positive', 'Neutral', 'Negative')
     AND coalesce(btrim(comment), '') <> ''
   ORDER BY seen_at DESC NULLS LAST
   LIMIT 1000
)
SELECT
  now() AS now,
  (SELECT max(window_to) FROM public."Sentiment Prompt Reviews"
    WHERE status IN ('no_change', 'pending', 'approved', 'rejected', 'superseded')) AS last_window_to,
  nextval(pg_get_serial_sequence('public."Sentiment Prompt Reviews"', 'id')) AS next_id,
  (SELECT coalesce(jsonb_object_agg(key, jsonb_build_object(
      'system_prompt', system_prompt, 'user_template', user_template,
      'model', model, 'temperature', temperature::float8)), '{}'::jsonb)
     FROM public."Sentiment Prompts") AS prompts,
  (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'platform', s.platform, 'client_id', s.client_id::text, 'client_name', c.name,
      'version', s.version, 'rules_text', s.rules_text)), '[]'::jsonb)
     FROM public."Sentiment Cheat Sheets" s JOIN public."Clients" c ON c.id = s.client_id
    WHERE s.status = 'active') AS sheets,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('client_id', id::text, 'name', name) ORDER BY name), '[]'::jsonb)
     FROM public."Clients") AS clients,
  (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.labeled_at), '[]'::jsonb)
     FROM items i WHERE i.human_label IS NOT NULL) AS labels,
  (SELECT coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb)
     FROM (SELECT * FROM recent ORDER BY random() LIMIT {{STABILITY_SIZE}}) s) AS stability;
