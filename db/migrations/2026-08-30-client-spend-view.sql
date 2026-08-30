-- "Client Spend": the spend record decision #9 chose instead of a cap
--
-- Implements the view in docs/architecture/limits-and-capacity.md section 7 ("no cap.
-- Record spend instead"). With no cap, the record IS the control, so section 7.1 lists
-- what the record has to get right. Three of those items are this view's whole job:
--
--   gap 2 (section 7)     `quantity` is NULL on comment orders -- the count lives in
--                         `comment_count`, so units must coalesce(quantity, comment_count).
--   gap 3 (section 7)     `charge` arrives only on the FIRST POLL, up to 30 minutes after
--                         placement. A fresh order is unpriced, not free. It is counted
--                         separately as `awaiting_price` and is never summed as zero --
--                         `charged` sums only rows that actually have a charge.
--   fix 8 (section 7.1)   `currency` comes from the provider and nothing enforces it.
--                         Every row today is USD. Grouping by it means a second currency
--                         can never silently distort a total.
--
-- WHAT THIS IS NOT. It reads; it does not enforce. There is deliberately no cap here --
-- if one is ever wanted, section 7 says the action executor is the single place to put it.
--
-- NULL CURRENCY IS EXPECTED AND CORRECT. `currency` is written by the same poll that
-- writes `charge`, so an order that is awaiting_price also has no currency yet and lands
-- in its own `currency IS NULL` group. That is honest -- we do not know what an unpriced
-- order will be billed in -- and it keeps the unpriced count from being folded into a
-- priced total. Render it as "--", not as a currency.
--
-- security_invoker = true so the view runs under the CALLER's RLS rather than the owner's.
-- Without it the view is a tenancy hole the moment a client logs in. Matches the existing
-- console_posts and console_x_connections views, both of which already carry it.
--
-- BOTH SUPABASE PROJECTS ARE SHARED WITH THE SIBLING FB MONITOR PROJECT. This view names
-- public."Order Info" only. The sibling's spend lives in "FB Order Info" and is untouched.
--
-- Applied: staging npytqidroqxgikaqofmq, then production jxnzdxyhoakpfmkbjdeq, 2026-08-30.

begin;

create or replace view public."Client Spend"
with (security_invoker = true) as
select
  o.client_id,
  date_trunc('month', o.created_at)                    as month,
  o.order_type,
  o.currency,
  count(*)                                             as orders,
  sum(coalesce(o.quantity, o.comment_count))           as units,
  sum(o.charge) filter (where o.charge is not null)    as charged,
  count(*) filter (
    where o.charge is null
      and o.normalized_status not in ('failed','canceled')
  )                                                    as awaiting_price
from public."Order Info" o
group by o.client_id, date_trunc('month', o.created_at), o.order_type, o.currency;

comment on view public."Client Spend" is
  'Month-to-date spend per client, order type and currency. Decision #9 '
  '(multi-tenant-and-web-ui.md section 11); definition and reasoning in '
  'limits-and-capacity.md section 7. `charged` sums only priced orders; unpriced orders '
  'are counted in `awaiting_price` and never as zero. Grouped by currency so two '
  'currencies can never be silently summed. A NULL currency group holds orders whose '
  'first poll has not landed yet.';

commit;
