CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public."Facebook Auth Sessions" (
  state text PRIMARY KEY,
  telegram_chat_id text,
  code_verifier text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS public."Facebook Auth Accounts" (
  facebook_user_id text PRIMARY KEY,
  telegram_chat_id text NOT NULL,
  facebook_user_name text,
  access_token text NOT NULL,
  expires_at timestamptz,
  scope text,
  connection_status text NOT NULL DEFAULT 'connected'
    CHECK (connection_status IN ('connected', 'needs_reconnect', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."Facebook Pages" (
  page_id text PRIMARY KEY,
  facebook_user_id text NOT NULL
    REFERENCES public."Facebook Auth Accounts" (facebook_user_id) ON DELETE CASCADE,
  page_name text NOT NULL,
  page_username text,
  page_access_token text NOT NULL,
  token_expires_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  minimum_comment_count integer NOT NULL DEFAULT 1
    CHECK (minimum_comment_count >= 1),
  negative_sentiment_threshold numeric(4,3) NOT NULL DEFAULT 0.600
    CHECK (negative_sentiment_threshold >= 0 AND negative_sentiment_threshold <= 1),
  last_polled_at timestamptz,
  last_poll_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."Facebook Telegram Users" (
  chat_id text PRIMARY KEY,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."Facebook Posts" (
  post_id text PRIMARY KEY,
  page_id text NOT NULL
    REFERENCES public."Facebook Pages" (page_id) ON DELETE CASCADE,
  post_message text,
  permalink_url text,
  published_at timestamptz,
  comment_count integer NOT NULL DEFAULT 0 CHECK (comment_count >= 0),
  reaction_count integer NOT NULL DEFAULT 0 CHECK (reaction_count >= 0),
  share_count integer NOT NULL DEFAULT 0 CHECK (share_count >= 0),
  engagement_count integer NOT NULL DEFAULT 0 CHECK (engagement_count >= 0),
  analyzed_comment_count integer NOT NULL DEFAULT 0 CHECK (analyzed_comment_count >= 0),
  negative_comment_count integer NOT NULL DEFAULT 0 CHECK (negative_comment_count >= 0),
  negative_ratio numeric(5,4),
  status text NOT NULL DEFAULT 'New'
    CHECK (status IN ('New', 'Alerted', 'Snoozed', 'Ignored', 'Moderating', 'Moderated')),
  snooze_runs_remaining integer NOT NULL DEFAULT 0 CHECK (snooze_runs_remaining >= 0),
  last_analyzed_at timestamptz,
  last_alert_sent_at timestamptz,
  alerted_negative_ratio numeric(5,4),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (negative_ratio IS NULL OR (negative_ratio >= 0 AND negative_ratio <= 1)),
  CHECK (alerted_negative_ratio IS NULL OR (alerted_negative_ratio >= 0 AND alerted_negative_ratio <= 1))
);

CREATE TABLE IF NOT EXISTS public."Facebook Comments" (
  comment_id text PRIMARY KEY,
  post_id text NOT NULL
    REFERENCES public."Facebook Posts" (post_id) ON DELETE CASCADE,
  parent_comment_id text,
  comment_message text,
  commenter_id text,
  commenter_name text,
  created_at_on_facebook timestamptz,
  sentiment text NOT NULL
    CHECK (sentiment IN ('Positive', 'Neutral', 'Negative')),
  sentiment_confidence numeric(4,3),
  moderation_status text NOT NULL DEFAULT 'pending'
    CHECK (moderation_status IN ('pending', 'hidden', 'deleted', 'hide_failed', 'delete_failed', 'skipped')),
  moderated_at timestamptz,
  last_moderation_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (sentiment_confidence IS NULL OR (sentiment_confidence >= 0 AND sentiment_confidence <= 1))
);

CREATE TABLE IF NOT EXISTS public."Facebook Alerts" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id text NOT NULL
    REFERENCES public."Facebook Posts" (post_id) ON DELETE CASCADE,
  telegram_chat_id text NOT NULL
    REFERENCES public."Facebook Telegram Users" (chat_id) ON DELETE CASCADE,
  telegram_message_id text,
  negative_ratio numeric(5,4) NOT NULL CHECK (negative_ratio >= 0 AND negative_ratio <= 1),
  negative_comment_count integer NOT NULL CHECK (negative_comment_count >= 0),
  analyzed_comment_count integer NOT NULL CHECK (analyzed_comment_count >= 0),
  sent_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, telegram_chat_id)
);

CREATE TABLE IF NOT EXISTS public."Facebook Moderation Actions" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id text NOT NULL
    REFERENCES public."Facebook Posts" (post_id) ON DELETE CASCADE,
  comment_id text NOT NULL
    REFERENCES public."Facebook Comments" (comment_id) ON DELETE CASCADE,
  telegram_chat_id text,
  action_type text NOT NULL CHECK (action_type IN ('hide', 'delete')),
  outcome text NOT NULL CHECK (outcome IN ('success', 'failed', 'skipped')),
  provider_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_category text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS facebook_pages_active_idx
  ON public."Facebook Pages" (is_active, page_name);

CREATE INDEX IF NOT EXISTS facebook_posts_page_published_idx
  ON public."Facebook Posts" (page_id, published_at DESC);

CREATE INDEX IF NOT EXISTS facebook_posts_status_idx
  ON public."Facebook Posts" (status, last_alert_sent_at);

CREATE INDEX IF NOT EXISTS facebook_comments_post_sentiment_idx
  ON public."Facebook Comments" (post_id, sentiment, moderation_status);

CREATE INDEX IF NOT EXISTS facebook_moderation_actions_post_created_idx
  ON public."Facebook Moderation Actions" (post_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.facebook_monitor_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.facebook_monitor_set_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.facebook_monitor_set_updated_at() FROM anon;
REVOKE ALL ON FUNCTION public.facebook_monitor_set_updated_at() FROM authenticated;

DROP TRIGGER IF EXISTS set_facebook_auth_accounts_updated_at ON public."Facebook Auth Accounts";
CREATE TRIGGER set_facebook_auth_accounts_updated_at
BEFORE UPDATE ON public."Facebook Auth Accounts"
FOR EACH ROW EXECUTE FUNCTION public.facebook_monitor_set_updated_at();

DROP TRIGGER IF EXISTS set_facebook_pages_updated_at ON public."Facebook Pages";
CREATE TRIGGER set_facebook_pages_updated_at
BEFORE UPDATE ON public."Facebook Pages"
FOR EACH ROW EXECUTE FUNCTION public.facebook_monitor_set_updated_at();

DROP TRIGGER IF EXISTS set_facebook_telegram_users_updated_at ON public."Facebook Telegram Users";
CREATE TRIGGER set_facebook_telegram_users_updated_at
BEFORE UPDATE ON public."Facebook Telegram Users"
FOR EACH ROW EXECUTE FUNCTION public.facebook_monitor_set_updated_at();

DROP TRIGGER IF EXISTS set_facebook_posts_updated_at ON public."Facebook Posts";
CREATE TRIGGER set_facebook_posts_updated_at
BEFORE UPDATE ON public."Facebook Posts"
FOR EACH ROW EXECUTE FUNCTION public.facebook_monitor_set_updated_at();

DROP TRIGGER IF EXISTS set_facebook_comments_updated_at ON public."Facebook Comments";
CREATE TRIGGER set_facebook_comments_updated_at
BEFORE UPDATE ON public."Facebook Comments"
FOR EACH ROW EXECUTE FUNCTION public.facebook_monitor_set_updated_at();

ALTER TABLE public."Facebook Auth Sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Facebook Auth Accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Facebook Pages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Facebook Telegram Users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Facebook Posts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Facebook Comments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Facebook Alerts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Facebook Moderation Actions" ENABLE ROW LEVEL SECURITY;
