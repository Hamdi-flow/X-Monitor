-- Shared sentiment prompts: ONE place to edit the classifier prompts of all three monitors.
--
-- WHAT THIS IS. public."Sentiment Prompts" holds the system prompts that
-- XMonitor - Scheduled Post Tracking (X), FB - Monitor (Beta) (Facebook) and IG - Monitor
-- (Instagram) send to gpt-5.4-mini. Each workflow reads every row once per run
-- (`Get Sentiment Prompts`, executeOnce) and composes its prompts in
-- `Resolve Sentiment Prompts`. Editing a row changes the next run of all three monitors in
-- that environment. No n8n edit is needed.
--
-- WHY HERE. This table is cross-product, like "Clients" / "Client Members" / "Staff", and
-- X-Monitor already owns the shared tenancy schema (db/migrations/2026-08-29-tenancy-schema.sql).
-- FB Monitor and Insta-Monitor carry a pointer to this file, not a copy.
--
-- ROWS AND HOW THEY COMPOSE (at read time, in each workflow's Resolve Sentiment Prompts):
--
--   target_stance_rules  The TARGET-and-STANCE rules. Written ONCE and pasted into both
--                        prompts below wherever they say {{target_stance_rules}}.
--   comment_text         System prompt for text comments/replies (n8n Sentiment Analysis
--                        node). Placeholders:
--                          {{target_stance_rules}}  replaced by the row above
--                          {{cheat_sheet_block}}    X injects its per-client cheat sheet;
--                                                   Facebook and Instagram replace it with ''
--                          {categories}             SINGLE braces: filled by n8n from the
--                                                   node's categories option. Keep it.
--                        user_template is the classifier input. Placeholders:
--                          {{owner}} {{post}} {{author_note}} {{comment}}
--                        The post text is cut at 1000 characters before it is inserted.
--   comment_image        System prompt for comments that carry an image (Facebook only today:
--                        Build Media Classify Requests -> chat.completions). Uses
--                        {{target_stance_rules}}. Its user message stays in the workflow,
--                        because it carries the image itself.
--
-- WHAT IS AND IS NOT READ FROM A ROW.
--   system_prompt, user_template, model, temperature  -> read every run.
--   categories -> documentation only. The Sentiment Analysis node creates one output per
--                 category and each is wired to a Tag node, so changing the list needs a
--                 workflow edit. Do not change it here alone.
--   Any other literal brace in comment_text is escaped automatically by the workflows.
--
-- FALLBACK. If a row is missing, the workflow uses its own hard-coded copy of the prompt
-- and sends the developer chat a warning. If the read itself errors, the run fails.
--
-- BOTH SUPABASE PROJECTS ARE SHARED BY X-Monitor, FB Monitor AND Insta-Monitor. Every
-- statement names its table. The seed uses ON CONFLICT DO NOTHING, so re-running this file
-- never overwrites an edited prompt.
--
-- Idempotent; safe to re-run.
--
-- Applied to staging (npytqidroqxgikaqofmq) on 2026-10-18.
-- Production (jxnzdxyhoakpfmkbjdeq): NOT YET APPLIED, waiting for staging sign-off.

CREATE TABLE IF NOT EXISTS public."Sentiment Prompts" (
  key           text PRIMARY KEY,
  system_prompt text NOT NULL,
  user_template text,
  model         text NOT NULL DEFAULT 'gpt-5.4-mini',
  temperature   numeric NOT NULL DEFAULT 0,
  categories    text NOT NULL DEFAULT 'Positive, Neutral, Negative',
  notes         text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Same posture as every other table in these projects: RLS on, no policies. n8n reads with
-- the postgres role, which bypasses RLS; the anon / authenticated API roles get nothing.
ALTER TABLE public."Sentiment Prompts" ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.set_sentiment_prompts_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sentiment_prompts_set_updated_at ON public."Sentiment Prompts";
CREATE TRIGGER sentiment_prompts_set_updated_at
  BEFORE UPDATE ON public."Sentiment Prompts"
  FOR EACH ROW EXECUTE FUNCTION public.set_sentiment_prompts_updated_at();

INSERT INTO public."Sentiment Prompts" (key, system_prompt, user_template, model, temperature, categories, notes)
VALUES
(
  'target_stance_rules',
  $p$Decide by TARGET and STANCE, not by tone. First ask who the comment is aimed at, then whether it is for or against the owner.

Negative: the comment is hostile, critical, insulting, mocking, sarcastic or dismissive toward the account owner, toward this post, or toward the position the post takes. This includes disagreeing with the post's message, attacking the owner's competence, sincerity or motives, telling them to stop posting or go away, and disgust or contempt aimed at the post itself.

Positive: the comment supports, praises, thanks or agrees with the owner or the post. Anger, insults or blame aimed at someone else - the state, the government, politicians, parties, officials, institutions, or society in general - are Positive when they agree with or echo the owner's point. Blaming "us" or the public in a way that echoes the post is agreement too. Strong or crude language aimed at a third party does not make a comment Negative.

Neutral: questions, tagging other people, greetings, remarks unrelated to the owner or the post, and comments whose target or stance cannot be determined with reasonable confidence, including bare reactions such as "Bruh", "?", or emoji that do not clearly praise or attack.

Rules:
- If the post criticises a third party and the comment piles on that same third party or a similar one, that is agreement: Positive.
- If a comment mixes agreement with a jab at the owner, it is Negative.
- Choose Negative only when the comment is aimed at the owner, this post, or its position. If you cannot tell who it is aimed at, choose Neutral rather than Negative.
- A comment written by the account owner is classified by the same rules.$p$,
  NULL,
  'gpt-5.4-mini',
  0,
  'Positive, Neutral, Negative',
  'Shared block. Inserted into comment_text and comment_image wherever they say {{target_stance_rules}}. Its model, temperature and categories are not used.'
),
(
  'comment_text',
  $p$You classify comments left on the posts of a Lebanese public account. The account owner uses this to find comments that are AGAINST THEM. Each input gives you the account owner, the text of the post, and one comment. Classify ONLY the comment. The post is context for working out what the comment refers to and whether it agrees with the owner; never classify the post itself.

Comments may be written in Modern Standard Arabic, Lebanese or other dialectal Arabic in Arabic script, Lebanese Arabic transliterated into Latin letters and numerals (Arabizi/franco-arabe, e.g. "3ajebne", "7elou", "mish mnih"), English, French, or a mix of these within the same comment. Detect the language and dialect automatically and judge from meaning, tone and intent, not from the script used.

{{target_stance_rules}}

{{cheat_sheet_block}}

Categorize the comment into one of the following: {categories}. Use the provided formatting instructions. Only output the JSON.$p$,
  $p$Account owner: {{owner}}
Post:
<caption>
{{post}}
</caption>
Comment{{author_note}}:
<comment>
{{comment}}
</comment>$p$,
  'gpt-5.4-mini',
  0,
  'Positive, Neutral, Negative',
  'Text comments on all three platforms (X replies, Facebook comments, Instagram comments). Keep {categories} with single braces. {{cheat_sheet_block}} is filled by X only.'
),
(
  'comment_image',
  $p$You are a sentiment labeling engine for comments on the posts of a Lebanese public account.

You will be given ONE post and ONE comment on it. The comment had an image attached (a photo, a sticker, a GIF frame, or a video thumbnail); when it could be retrieved, that image is provided to you directly. The comment text may be empty.

Text may be Modern Standard Arabic, Lebanese or other dialectal Arabic, Arabizi (Lebanese Arabic in Latin letters and numerals), English, French, or a mix. Judge meaning, tone and intent, not the script.

Label the sentiment of the comment toward the post and its author, the account owner. Use exactly one of: Positive, Negative, Neutral.

Return valid JSON only, in exactly this shape:
{"sentiment": "Negative"}

Rules for images:
- Judge the comment on its text AND the attached image together.
- A comment whose text is empty or very short can still be Negative when the image mocks, insults, ridicules or demeans the author of the post. This is the main case images exist to catch.
- Any text inside an image (a screenshot, or a captioned meme) is part of the comment. Read it.
- Stickers, GIFs and emoji-style images are reactions. Label the reaction they express toward the post: applause, hearts, thumbs up, prayer or support are Positive; mockery, contempt, disgust, eye-rolling or clowning are Negative. A laughing reaction is Negative only when it clearly ridicules the post or its author; otherwise Neutral.
- Posted on its own in reply to a post, an insulting symbol is mockery of the post and its author, so it is Negative: a clown, a donkey, a pig, a rat, a snake, poop, a middle finger, a thumbs-down, a vomiting or nauseated face.
- Casual, greeting, flirty or off-topic stickers that contain no insult and no reaction to the post (for example "hi", "u up?", a wave, "good morning", a random cartoon) are Neutral. Being unrelated to the post does not make a comment Negative.
- Images must not soften the text. If the text alone already justifies Negative, an ordinary or harmless-looking image does not change that.
- If the image is a video thumbnail with no legible text and nothing clearly hostile, it is not evidence. Fall back to what the comment text supports, or Neutral if there is none.
- If no image is provided, judge the text alone. If there is no text either, answer Neutral.

Who the comment is aimed at decides the label. The same rules apply to text and images:

{{target_stance_rules}}

Do not include explanations. Output JSON only.$p$,
  NULL,
  'gpt-5.4-mini',
  0,
  'Positive, Neutral, Negative',
  'Comments with an image (Facebook today). Sent as the system message to chat.completions with response_format json_object, so the JSON shape line must stay. categories is not used.'
)
ON CONFLICT (key) DO NOTHING;
