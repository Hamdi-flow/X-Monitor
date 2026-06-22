CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public."Order Info" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'smmwiz',
  provider_order_id text NOT NULL,
  order_type text NOT NULL CHECK (order_type IN ('likes', 'comments')),
  post_id text NOT NULL,
  telegram_chat_id text,
  x_username text,
  link text,
  service_id text,
  quantity integer,
  comment_count integer,
  request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_add_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_status text,
  normalized_status text NOT NULL DEFAULT 'pending'
    CHECK (normalized_status IN ('pending', 'in_progress', 'completed', 'partial', 'canceled', 'failed')),
  status_response jsonb,
  charge numeric,
  start_count integer,
  remains integer,
  currency text,
  poll_attempts integer NOT NULL DEFAULT 0,
  last_checked_at timestamptz,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  notified_at timestamptz,
  CONSTRAINT order_info_provider_order_unique UNIQUE (provider, provider_order_id)
);

CREATE INDEX IF NOT EXISTS order_info_status_next_check_idx
  ON public."Order Info" (normalized_status, next_check_at);

CREATE INDEX IF NOT EXISTS order_info_provider_order_idx
  ON public."Order Info" (provider, provider_order_id);

CREATE INDEX IF NOT EXISTS order_info_post_id_idx
  ON public."Order Info" (post_id);

ALTER TABLE public."Order Info" ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.update_order_info_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.update_order_info_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_order_info_updated_at() FROM anon;
REVOKE ALL ON FUNCTION public.update_order_info_updated_at() FROM authenticated;

DROP TRIGGER IF EXISTS set_order_info_updated_at ON public."Order Info";
CREATE TRIGGER set_order_info_updated_at
BEFORE UPDATE ON public."Order Info"
FOR EACH ROW
EXECUTE FUNCTION public.update_order_info_updated_at();
