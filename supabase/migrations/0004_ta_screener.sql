-- Server-side TA screener results, computed on a schedule by the
-- compute-ta Edge Function (via pg_cron) rather than in the browser — this
-- is what lets the screener keep scanning and stay fresh even when nobody
-- has the app open. Every row is public, non-personal market data (same
-- pair, same numbers for everyone), so it's readable by anyone with the
-- anon key; only the Edge Function's service-role key can write to it.
create table if not exists ta_screener (
  symbol text primary key,
  price numeric,
  trend text,
  trend_strength text,
  adx numeric,
  momentum text,
  rsi numeric,
  support numeric,
  resistance numeric,
  near_support_pct numeric,
  near_resistance_pct numeric,
  reversal text,
  updated_at timestamptz not null default now()
);

alter table ta_screener enable row level security;

create policy "ta_screener public read" on ta_screener
  for select
  using (true);
