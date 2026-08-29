-- Phase T1: tenancy schema
--
-- Implements Phase T1 of docs/architecture/multi-tenant-and-web-ui.md section 12b,
-- against the data model in sections 3 and 4.
--
-- WHAT THIS IS. The system today has an ownership key ("Tracked Users".telegram_chat_id)
-- and no enforcement of it. Section 12a records the two gaps that matter: alert routing
-- (both schedulers read the whole "Telegram Users" table, so every recipient gets every
-- client's posts) and authorization (every `Get Post For *` filters on post_id alone, and
-- post ids are public in X URLs). Neither is closed here. This migration only builds the
-- tenancy plane those fixes will stand on:
--
--   T1 (this file)  schema        -- Clients, Client Members, Staff, client_id everywhere
--   T2              authorization -- the security fix; reads "Client Members" and "Staff"
--   T3              alert routing -- reads "Client Members".receives_alerts
--
-- WHAT THIS IS NOT. It is schema-only and deliberately BEHAVIOUR-NEUTRAL. No n8n workflow
-- is changed by it and none needs to be: every new column is either populated by a trigger
-- or left nullable, so every existing INSERT and UPDATE keeps working with its current
-- column list. The system stays effectively single-tenant until T2 and T3 land. If applying
-- this file changes what any workflow does, that is a bug in this file.
--
-- WHY "Clients" RATHER THAN telegram_chat_id. Decided 2026-08-28 (section 12b, "The one
-- design call to make first"). Not for the extra capability -- for the edit count. Every
-- workflow needing routing or authorization has to be opened anyway; doing it once against
-- client_id costs almost nothing more than doing it against telegram_chat_id, and doing it
-- against telegram_chat_id now means opening all of them a second time later.
--
-- BOTH SUPABASE PROJECTS ARE SHARED WITH THE SIBLING FB MONITOR PROJECT. Every statement
-- below names its table explicitly. There is no schema-wide ALTER, no unqualified TRUNCATE,
-- and nothing here touches an "FB *" table, the Copycat/Muses tables, or "Run State".
--
-- "Telegram Users" IS LEFT IN PLACE, still written and still read. It remains the
-- scheduler's recipient source until T3 cuts over to "Client Members". Its rows are COPIED
-- here, not moved.
--
-- Idempotent; safe to re-run.
--
-- Applied to staging (npytqidroqxgikaqofmq) on 2026-08-29.
-- Applied to production (jxnzdxyhoakpfmkbjdeq) on 2026-08-29.


-- 1. Clients ---------------------------------------------------------------
--
-- The tenancy plane. One row per client; everything else hangs off id.
--
-- The tunables are the FB Monitor Config pattern: values the scheduler reads at the start
-- of a run rather than constants baked into a workflow. Nothing reads them yet -- T3 does,
-- when it starts resolving thresholds per client instead of per workflow. The defaults are
-- the values the workflows currently hard-code, so a client created with all defaults
-- behaves exactly as today.
--
-- Section 4.1 also lists max_posts_per_run and quiet_hours_start/end. They are NOT created
-- here: section 12b scopes T1 to lookback_days, min_replies, negative_threshold and
-- timezone, and a column no reader exists for is just drift. They are additive later.

CREATE TABLE IF NOT EXISTS public."Clients" (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text NOT NULL UNIQUE,
  name               text NOT NULL,
  is_active          boolean NOT NULL DEFAULT true,

  -- Runtime tunables, read at the start of every run from T3 onward.
  lookback_days      integer NOT NULL DEFAULT 7
                       CHECK (lookback_days > 0),
  min_replies        integer NOT NULL DEFAULT 10
                       CHECK (min_replies >= 0),
  negative_threshold numeric NOT NULL DEFAULT 0.50
                       CHECK (negative_threshold >= 0 AND negative_threshold <= 1),
  timezone           text NOT NULL DEFAULT 'Asia/Beirut',

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public."Clients" IS
  'Tenancy plane. One row per client; client_id on every owned table points here. '
  'lookback_days / min_replies / negative_threshold / timezone are per-client runtime '
  'tunables read by the scheduler from phase T3 onward.';


-- 2. Client Members --------------------------------------------------------
--
-- The Telegram identity plane (section 3). A membership of a client by a chat, not a
-- client for a chat: the unique constraint is (client_id, chat_id) and DELIBERATELY NOT
-- chat_id alone, because one chat may belong to several clients -- an operator team chat
-- that receives everything is the motivating case.
--
-- That is why authorization in T2 is phrased as "is this actor a member of the client that
-- owns this post, or staff?" and never as "which client is this chat?". The second question
-- has no answer.
--
-- chat_type is nullable with a default rather than NOT NULL (section 4.1 has it NOT NULL;
-- section 12b's T1 scope does not). Telegram does not tell us the chat type on every code
-- path that could create a member row, and a CHECK constraint passes on NULL, so a row
-- whose type is genuinely unknown records as unknown instead of being mislabelled
-- 'private'. Rows created here are private chats and say so.
--
-- app_user_id is the optional bridge to the web identity plane (section 3): it lets the
-- audit trail name one person acting via Telegram and via the web. Nothing populates it
-- until the web UI exists. "App Users" and "Client Access" are NOT created here -- they
-- belong to the web plane, which T1 does not build -- so this column references auth.users
-- directly, exactly as section 4.1 writes it.

CREATE TABLE IF NOT EXISTS public."Client Members" (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id       uuid NOT NULL REFERENCES public."Clients"(id) ON DELETE CASCADE,
  chat_id         text NOT NULL,
  chat_type       text DEFAULT 'private'
                    CHECK (chat_type IN ('private','group','supergroup','channel')),
  label           text,

  -- Decision #1: two roles, not four. 'operator' is the team acting on a client's behalf;
  -- 'client' is the client themselves. Cross-client power is "Staff", a separate table --
  -- it is not a third role here, because it is not a membership of any one client.
  role            text NOT NULL DEFAULT 'client'
                    CHECK (role IN ('operator','client')),

  receives_alerts boolean NOT NULL DEFAULT true,
  is_active       boolean NOT NULL DEFAULT true,
  app_user_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (client_id, chat_id)
);

-- T2's authorization probe is "rows for this chat", so chat_id leads. Partial on is_active
-- because an inactive membership must never authorise anything and there is no query that
-- wants both -- the same reasoning as tracked_users_active_owner_idx.
CREATE INDEX IF NOT EXISTS client_members_chat_idx
  ON public."Client Members" (chat_id)
  WHERE is_active;

-- T3's routing probe is "who receives alerts for this client".
CREATE INDEX IF NOT EXISTS client_members_client_alert_idx
  ON public."Client Members" (client_id)
  WHERE is_active AND receives_alerts;

COMMENT ON TABLE public."Client Members" IS
  'Telegram identity plane: a membership of a client by a chat. Unique on (client_id, '
  'chat_id) and deliberately NOT on chat_id alone, because one chat may belong to several '
  'clients. Copied from "Telegram Users" at T1; becomes the routing source at T3.';


-- 3. Staff -----------------------------------------------------------------
--
-- A chat that may act across EVERY client. This is the authorization override T2 reads
-- after the "Client Members" check fails, and it is its own table rather than a role on
-- "Client Members" because staff power is not a membership of any particular client --
-- modelling it as one would mean either a fake client row or a role whose client_id is
-- meaningless.
--
-- Per decision #5, staff receive NO post alerts (T3); developer alerts continue to go to
-- the dev chat through the existing error-alert workflows, which this does not touch.
--
-- Created EMPTY in both environments. Assignment of the two non-operator chats
-- (8677383067 and 7413776295 in production; 7413776295 in staging) was put to the owner on
-- 2026-08-29, who chose to leave both unassigned rather than grant cross-client power to a
-- chat that has never needed it. Adding one later is a single INSERT.

CREATE TABLE IF NOT EXISTS public."Staff" (
  chat_id    text PRIMARY KEY,
  label      text,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public."Staff" IS
  'Chats that may act across every client. Read by phase T2 as the authorization '
  'override when the "Client Members" check fails. Staff receive no post alerts '
  '(decision #5). Intentionally empty until a chat actually needs cross-client power.';


-- 4. updated_at maintenance ------------------------------------------------
--
-- "Clients" and "Client Members" both declare updated_at, and nothing would maintain it
-- without this. Same shape as the existing set_moderation_queue_updated_at.

CREATE OR REPLACE FUNCTION public.set_tenancy_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS clients_set_updated_at ON public."Clients";
CREATE TRIGGER clients_set_updated_at
  BEFORE UPDATE ON public."Clients"
  FOR EACH ROW EXECUTE FUNCTION public.set_tenancy_updated_at();

DROP TRIGGER IF EXISTS client_members_set_updated_at ON public."Client Members";
CREATE TRIGGER client_members_set_updated_at
  BEFORE UPDATE ON public."Client Members"
  FOR EACH ROW EXECUTE FUNCTION public.set_tenancy_updated_at();


-- 5. client_id columns -----------------------------------------------------
--
-- Expand / migrate / contract, the same shape as the 2026-08-24 soft-delete migration:
-- every column is added NULLABLE here, backfilled in section 7, and only then constrained
-- in section 9. Adding NOT NULL up front would break every insert in flight.
--
-- client_id on "Posts", "Replies" and "Order Info" is DENORMALIZED on purpose. It is
-- derivable -- Replies -> Posts -> Tracked Users -> client_id -- but a direct indexed
-- column keeps every tenant query, and every future RLS policy, a single equality instead
-- of a two- or three-table join. RLS runs per row, so the join cost would be paid per row.
-- Section 6 is what keeps the copies honest.

-- 5a. "Tracked Users" is the root of ownership.
--
-- ON DELETE RESTRICT, not CASCADE: deleting a client must never silently take tracked
-- accounts (and through them, by the old FK, posts and replies) with it. This is the same
-- instinct as Posts_user_id_fkey -> RESTRICT in the 2026-08-24 migration. Retiring a client
-- is is_active = false, not DELETE.
ALTER TABLE public."Tracked Users"
  ADD COLUMN IF NOT EXISTS client_id uuid
    REFERENCES public."Clients"(id) ON DELETE RESTRICT;

-- Section 4.2 specifies the partial index. Every reader of this column filters on
-- is_active, and an inactive account must not be routed or acted on.
CREATE INDEX IF NOT EXISTS tracked_users_client_idx
  ON public."Tracked Users" (client_id)
  WHERE is_active;

-- 5b. The three owned tables. CASCADE here is safe in a way it is not on "Tracked Users":
-- these rows are worthless without their client, and the RESTRICT above means a client
-- with any tracked account cannot be deleted in the first place.
ALTER TABLE public."Posts"
  ADD COLUMN IF NOT EXISTS client_id uuid
    REFERENCES public."Clients"(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS posts_client_idx
  ON public."Posts" (client_id);

ALTER TABLE public."Replies"
  ADD COLUMN IF NOT EXISTS client_id uuid
    REFERENCES public."Clients"(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS replies_client_idx
  ON public."Replies" (client_id);

ALTER TABLE public."Order Info"
  ADD COLUMN IF NOT EXISTS client_id uuid
    REFERENCES public."Clients"(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS order_info_client_idx
  ON public."Order Info" (client_id, created_at DESC);

-- 5c. "X Auth Accounts" -- nullable, and it STAYS nullable.
--
-- Not an oversight. Both environments hold auth rows with no matching tracked account:
-- production has 3 (two chats that track nothing), staging has 11 (one such chat plus 10
-- rows with no telegram_chat_id at all, from the account-manager work). These are real
-- authorised tokens, not junk, so NOT NULL would either fail outright or force a guess
-- about who owns them. T5 carries client_id through the OAuth PKCE state and can revisit.
ALTER TABLE public."X Auth Accounts"
  ADD COLUMN IF NOT EXISTS client_id uuid
    REFERENCES public."Clients"(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS x_auth_accounts_client_idx
  ON public."X Auth Accounts" (client_id);


-- 6. Denormalization integrity ---------------------------------------------
--
-- Section 4.3: keep the copies honest with a trigger rather than trusting every writer.
--
-- All three are SECURITY DEFINER with SET search_path = '' -- so no caller can shadow
-- public."Tracked Users" with something of their own, and so the lookup succeeds
-- regardless of what the writing role can read. Everything is schema-qualified because an
-- empty search_path resolves nothing implicitly except pg_catalog builtins.
--
-- These are also what makes this migration behaviour-neutral: no workflow supplies
-- client_id, and none has to. "Insert or update posts" and "Insert or update replies" both
-- write their key column on the ON CONFLICT branch too, which is why each trigger fires on
-- UPDATE OF that column as well as on INSERT.

-- 6a. "Posts".client_id <- "Tracked Users" via user_id.
--
-- Unconditional assignment, exactly as section 4.3 writes it: the trigger is authoritative
-- and a supplied value never survives. "Posts".user_id is nullable, and a NULL user_id
-- resolves to NULL and therefore fails the NOT NULL added in section 9. That is intended
-- fail-closed behaviour and costs nothing today -- both environments have zero posts with
-- a NULL user_id, Posts_user_id_fkey guarantees any non-NULL value exists in
-- "Tracked Users", and section 9 guarantees every such row has a client.
CREATE OR REPLACE FUNCTION public.set_post_client_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  SELECT tu.client_id INTO NEW.client_id
  FROM public."Tracked Users" tu
  WHERE tu.user_id = NEW.user_id;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS posts_set_client ON public."Posts";
CREATE TRIGGER posts_set_client
  BEFORE INSERT OR UPDATE OF user_id ON public."Posts"
  FOR EACH ROW EXECUTE FUNCTION public.set_post_client_id();

-- 6b. "Replies".client_id <- "Posts" via post_id. Same shape; Replies_post_id_fkey
-- guarantees a non-NULL post_id exists.
CREATE OR REPLACE FUNCTION public.set_reply_client_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  SELECT p.client_id INTO NEW.client_id
  FROM public."Posts" p
  WHERE p.post_id = NEW.post_id;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS replies_set_client ON public."Replies";
CREATE TRIGGER replies_set_client
  BEFORE INSERT OR UPDATE OF post_id ON public."Replies"
  FOR EACH ROW EXECUTE FUNCTION public.set_reply_client_id();

-- 6c. "Order Info".client_id -- the one that must never raise.
--
-- "Order Info" has NO foreign key to "Posts", deliberately: an order must survive its post
-- being deleted, or spend disappears with the post (limits-and-capacity.md section 7.1 #9).
-- So unlike 6a and 6b the post genuinely may be absent -- staging proves it, where all 5
-- existing orders reference posts that no longer exist.
--
-- Hence a resolution CHAIN, and hence a local variable rather than assigning straight into
-- NEW.client_id: a "SELECT ... INTO NEW.client_id" that matches no row writes NULL, which
-- would let a missing post erase a value the next step (or the caller) had every right to
-- provide.
--
--   1. the post, when it exists   -- authoritative, same source as "Posts" itself
--   2. else the chat, through an active "Client Members" row
--   3. else leave whatever is there, including NULL
--
-- Step 3 is why "Order Info".client_id is NOT made NOT NULL in section 9, on the owner's
-- call of 2026-08-29. With no cap on spend, the RECORD is the control (section 7 of
-- limits-and-capacity.md), and an order that fails to insert is an order that is not
-- recorded while the provider has already been charged -- strictly worse than an order
-- recorded with an unknown client. T5 stamps client_id at placement, from the tracked
-- account, and the column can be constrained then.
--
-- The ORDER BY on step 2 is not decoration: a chat may be a member of several clients, so
-- the query needs a deterministic answer. Oldest membership wins.
CREATE OR REPLACE FUNCTION public.set_order_info_client_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_client uuid;
BEGIN
  IF NEW.post_id IS NOT NULL THEN
    SELECT p.client_id INTO v_client
    FROM public."Posts" p
    WHERE p.post_id = NEW.post_id;
  END IF;

  IF v_client IS NULL AND NEW.telegram_chat_id IS NOT NULL THEN
    SELECT cm.client_id INTO v_client
    FROM public."Client Members" cm
    WHERE cm.chat_id = NEW.telegram_chat_id
      AND cm.is_active
    ORDER BY cm.id
    LIMIT 1;
  END IF;

  IF v_client IS NOT NULL THEN
    NEW.client_id := v_client;
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS order_info_set_client ON public."Order Info";
CREATE TRIGGER order_info_set_client
  BEFORE INSERT OR UPDATE OF post_id ON public."Order Info"
  FOR EACH ROW EXECUTE FUNCTION public.set_order_info_client_id();

-- 6d. "Tracked Users".client_id -- a COMPATIBILITY SHIM, not a denormalization.
--
-- Different in kind from 6a-6c. Those keep a derived copy honest and are therefore
-- authoritative: they overwrite whatever the writer supplied. This one supplies a ROOT
-- value that has no upstream to derive from, and it only ever FILLS IN A NULL.
--
-- WHY IT HAS TO EXIST. The router's "Upsert Tracked X User" writes exactly
--
--   INSERT INTO public."Tracked Users" (user_id, username, telegram_chat_id, is_active)
--
-- with no client_id. Section 9 makes client_id NOT NULL. Without this trigger, applying
-- this migration would break /track for every new handle -- a behaviour change, and
-- precisely the kind this file is forbidden to make. The alternative is editing the
-- router, which is T5's job and is out of scope here.
--
-- FILL-IF-NULL, deliberately. client_id on "Tracked Users" is ownership itself, not a
-- copy of anything, so the trigger must never override a value someone set on purpose.
-- When T5 teaches /track to take a client explicitly (staff-only, decision #3), it will
-- pass client_id and this trigger will simply stop firing on the branch that matters.
--
-- The chain:
--
--   1. the calling chat, through an active "Client Members" row -- the honest answer
--   2. else the sole active client, IF AND ONLY IF exactly one exists
--   3. else NULL, which section 9 turns into a loud failure
--
-- Step 2 is what makes today byte-for-byte identical. Right now there is exactly one
-- client, every tracked account already implicitly belongs to it, and /track from any chat
-- succeeds -- so it must keep succeeding. The moment a second active client exists, step 2
-- goes silent and an unattributable /track fails closed instead of guessing a tenant,
-- which is the correct behaviour and is what T5 replaces with an explicit choice.
CREATE OR REPLACE FUNCTION public.set_tracked_user_client_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_client uuid;
BEGIN
  IF NEW.client_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.telegram_chat_id IS NOT NULL THEN
    SELECT cm.client_id INTO v_client
    FROM public."Client Members" cm
    WHERE cm.chat_id = NEW.telegram_chat_id
      AND cm.is_active
    ORDER BY cm.id
    LIMIT 1;
  END IF;

  IF v_client IS NULL THEN
    SELECT c.id INTO v_client
    FROM public."Clients" c
    WHERE c.is_active
      AND (SELECT count(*) FROM public."Clients" x WHERE x.is_active) = 1;
  END IF;

  NEW.client_id := v_client;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS tracked_users_set_client ON public."Tracked Users";
CREATE TRIGGER tracked_users_set_client
  BEFORE INSERT OR UPDATE OF telegram_chat_id ON public."Tracked Users"
  FOR EACH ROW EXECUTE FUNCTION public.set_tracked_user_client_id();


-- 7. Backfill --------------------------------------------------------------
--
-- All existing data belongs to one client. Verified in both environments on 2026-08-28/29:
--
--                    production                staging
--   Tracked Users     3 (all chat 8372903693)   1 (chat 8677383067)
--   Posts            22                         2
--   Replies         929                       181
--   Order Info        3                         5 (all with absent posts)
--   Telegram Users    1 (8372903693)            1 (8677383067)
--
-- Every UPDATE is guarded on client_id IS NULL so a re-run is a no-op and so this can never
-- reassign a row that a later phase has deliberately moved.
--
-- Note that none of these UPDATEs fire the section 6 triggers: those fire on UPDATE OF
-- user_id / post_id, and these write client_id. The backfill and the triggers are
-- nonetheless written to agree -- each owned table derives through the same chain the
-- trigger uses -- so replaying this file against a multi-client database would produce the
-- same answer the triggers would.

-- 7a. The house client. The single tenant everything currently belongs to.
INSERT INTO public."Clients" (slug, name)
VALUES ('house', 'House Account')
ON CONFLICT (slug) DO NOTHING;

-- 7b. "Tracked Users" is the ONLY place the "it is all house" claim enters. Everything
-- below derives from here.
UPDATE public."Tracked Users"
SET client_id = (SELECT id FROM public."Clients" WHERE slug = 'house')
WHERE client_id IS NULL;

-- 7c. "Telegram Users" -> "Client Members". COPIED, not moved: "Telegram Users" is still
-- the scheduler's recipient source and stays that way until T3.
--
-- role 'operator' because the single existing chat is the team's own chat -- it owns every
-- tracked account and issues every command. label is role-only ('Operator') by the owner's
-- choice on 2026-08-29; "Telegram Users".label is empty in production, so there was nothing
-- to carry over and a friendly name would have been invented.
INSERT INTO public."Client Members" (client_id, chat_id, chat_type, label, role,
                                     receives_alerts, is_active)
SELECT (SELECT id FROM public."Clients" WHERE slug = 'house'),
       tu.chat_id,
       'private',
       'Operator',
       'operator',
       true,
       true
FROM public."Telegram Users" tu
WHERE tu.chat_id IS NOT NULL
ON CONFLICT (client_id, chat_id) DO NOTHING;

-- 7d. "Posts" <- "Tracked Users", the same chain as trigger 6a.
UPDATE public."Posts" p
SET client_id = t.client_id
FROM public."Tracked Users" t
WHERE t.user_id = p.user_id
  AND p.client_id IS NULL;

-- 7e. "Replies" <- "Posts", the same chain as trigger 6b.
UPDATE public."Replies" r
SET client_id = p.client_id
FROM public."Posts" p
WHERE p.post_id = r.post_id
  AND r.client_id IS NULL;

-- 7f. "Order Info" <- post, then chat: the same two steps, in the same order, as trigger
-- 6c. Production resolves entirely on the first; staging resolves entirely on the second,
-- because all 5 of its orders reference posts that no longer exist.
UPDATE public."Order Info" o
SET client_id = p.client_id
FROM public."Posts" p
WHERE p.post_id = o.post_id
  AND o.client_id IS NULL;

UPDATE public."Order Info" o
SET client_id = cm.client_id
FROM public."Client Members" cm
WHERE cm.chat_id = o.telegram_chat_id
  AND cm.is_active
  AND o.client_id IS NULL;

-- 7g. "X Auth Accounts" -- assigned by CHAT, not blanket-assigned to house.
--
-- This is the one table where "all existing data belongs to one client" is false. Rows
-- whose telegram_chat_id is an active member of some client get that client; everything
-- else is left NULL:
--
--   production  7 rows assigned (chat 8372903693); 3 left NULL
--               -- 8677383067 (@HamSad74041630, @RebelHam_) and 7413776295 (@Tarek_ismail_)
--   staging     2 rows assigned (chat 8677383067); 11 left NULL
--               -- 7413776295 (@Tarek_ismail_) and 10 rows with no chat at all
--
-- Leaving those chats unassigned is the owner's decision of 2026-08-29: neither tracks any
-- account, so neither needs a client today, and inventing a membership would grant
-- authorization in T2 that nobody asked for. Driven off "Client Members" rather than
-- literal chat ids so the same statement is correct in both environments.
UPDATE public."X Auth Accounts" a
SET client_id = cm.client_id
FROM public."Client Members" cm
WHERE cm.chat_id = a.telegram_chat_id
  AND cm.is_active
  AND a.telegram_chat_id IS NOT NULL
  AND a.client_id IS NULL;


-- 8. Row Level Security ----------------------------------------------------
--
-- Every existing table in this database has RLS ENABLED with ZERO POLICIES (verified in
-- both environments, 2026-08-29), so only service_role and the postgres role reach the
-- data. The new tables match that exactly -- a tenancy table readable by anon while
-- "Posts" is not would be a strange first hole to open.
--
-- Policies are deferred by decision (section 5): the console reads server-side with the
-- service key. They become necessary the day a client logs in, not before.

ALTER TABLE public."Clients"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Client Members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Staff"          ENABLE ROW LEVEL SECURITY;


-- 9. Contract: NOT NULL ----------------------------------------------------
--
-- The last step of expand/migrate/contract, and the point of the whole exercise: from here
-- on, a tracked account, a post or a reply CANNOT exist without a client. Run only after
-- section 7, and only while section 6's triggers exist -- they are what lets every current
-- writer keep its existing column list and still satisfy this. 6d in particular is load
-- bearing: without it this section breaks /track.
--
-- "Order Info" is deliberately absent. See 6c: with no spend cap, an unrecorded order is
-- worse than an unattributed one, so that column stays nullable until T5 stamps it at
-- placement.

ALTER TABLE public."Tracked Users" ALTER COLUMN client_id SET NOT NULL;
ALTER TABLE public."Posts"         ALTER COLUMN client_id SET NOT NULL;
ALTER TABLE public."Replies"       ALTER COLUMN client_id SET NOT NULL;


-- 10. What this file deliberately does not do ------------------------------
--
--   * No workflow change. Alert routing is T3; authorization is T2. Until T2, an
--     unauthorised chat can still act on any post it knows the id of -- this migration does
--     not narrow that, it only makes narrowing it possible.
--   * "App Users" / "Client Access" (section 4.1, the web identity plane) -- no web UI yet.
--   * "Action Log" -- explicitly out of the tenancy plan (section 12b), so
--     "Moderation Queue".action_id stays a free-floating uuid.
--   * "Moderation Queue".client_id is left unconstrained. Section 12b assigns populating it
--     to T5, and the queue is empty in both environments, so adding the foreign key now
--     would constrain nothing and pre-empt that phase.
--   * "Posts".status is NOT split into suppression_status / order_state, and
--     snooze_runs_remaining is NOT converted to snoozed_until. Both are section 4.2 work
--     that the console views currently decode in SQL; changing them would change behaviour,
--     which T1 must not.
--   * No column is dropped and no column is renamed. "Telegram Users",
--     "Tracked Users".telegram_chat_id and "Order Info".telegram_chat_id all keep working.
