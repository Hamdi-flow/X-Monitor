-- Operator chat 8372903693 is labelled "Tarek -- operator" wherever the console reads it
--
-- The console groups by CHAT today and will group by CLIENT after T6, so the label has to
-- agree in both places it is read from, or the same human appears under two names
-- depending on which screen you are on:
--
--   "Telegram Users".label   -- NULL (nothing)
--   "Client Members".label   -- 'Operator' (something else)
--
-- Data-only. No schema change, no behaviour change: nothing routes, authorizes or alerts
-- on either column -- alert routing keys on "Client Members".receives_alerts (T3) and
-- authorization on chat_id (T2). This only changes what a human reads.
--
-- ENVIRONMENT NOTE. Chat 8372903693 is the PRODUCTION operator chat. Staging talks to a
-- different Telegram bot, so the same person has a different chat id there (8677383067)
-- and no row for 8372903693 exists in staging at all. This file is written to match on
-- chat_id, so applying it to staging is a deliberate no-op (0 rows) rather than an
-- invented row. Whether staging's own operator chat should be relabelled to match is a
-- separate call, left to the user.
--
-- BOTH SUPABASE PROJECTS ARE SHARED WITH THE SIBLING FB MONITOR PROJECT. Both statements
-- name their table and filter on a single chat_id. No FB * or IG * table is touched.
--
-- Applied: staging npytqidroqxgikaqofmq (0 rows, expected), then production
-- jxnzdxyhoakpfmkbjdeq, 2026-08-30.

begin;

update public."Telegram Users"
   set label = 'Tarek — operator'
 where chat_id = '8372903693';

update public."Client Members"
   set label      = 'Tarek — operator',
       updated_at = now()
 where chat_id = '8372903693';

commit;
