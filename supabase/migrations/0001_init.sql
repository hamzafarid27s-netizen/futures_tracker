-- Futures Tracker — background alerts schema
-- Run this once in the Supabase SQL Editor (or via `supabase db push`).

-- One row per device that has enabled background alerts. device_id is a
-- random UUID generated and stored client-side (localStorage) — there is no
-- login system in this app, so a device is the unit of identity.
create table if not exists push_subscriptions (
  device_id text primary key,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Mirrors the alert configuration the app already keeps in localStorage, so
-- the background job can evaluate the same rules while the app is closed.
create table if not exists alert_configs (
  device_id text primary key references push_subscriptions(device_id) on delete cascade,
  rules_enabled jsonb not null default '{}'::jsonb,   -- {"5":true,"15":true,"30":true,"60":true}
  custom_alerts jsonb not null default '[]'::jsonb,   -- [{id,symbol,min,pct,dir}] — min<=60 supported in background mode
  global_alerts jsonb not null default '[]'::jsonb,   -- [{id,min,pct,dir}] — min<=60 supported in background mode
  saved_trades jsonb not null default '[]'::jsonb,    -- [{id,symbol,entry,margin,leverage,dir}] for PnL flip alerts
  updated_at timestamptz not null default now()
);

-- Rolling price history the background job maintains itself (independent of
-- any single device's browser tab), so it can compute 5/15/30/60-minute
-- changes without re-downloading klines every run. Pruned to the last ~65
-- minutes by the edge function on every invocation.
create table if not exists price_samples (
  symbol text not null,
  price numeric not null,
  sampled_at timestamptz not null default now()
);
create index if not exists price_samples_symbol_time on price_samples (symbol, sampled_at desc);

-- Cooldown / dedup so the same condition firing every minute doesn't spam a
-- notification every minute — mirrors the app's own cooldown logic.
create table if not exists alert_fired_log (
  device_id text not null,
  rule_key text not null,
  fired_at timestamptz not null default now(),
  primary key (device_id, rule_key)
);

-- Last known PnL sign per tracked trade, for flip detection across runs.
create table if not exists trade_pnl_state (
  device_id text not null,
  trade_id text not null,
  was_positive boolean not null,
  updated_at timestamptz not null default now(),
  primary key (device_id, trade_id)
);

alter table push_subscriptions enable row level security;
alter table alert_configs enable row level security;
alter table price_samples enable row level security;
alter table alert_fired_log enable row level security;
alter table trade_pnl_state enable row level security;

-- IMPORTANT — known, intentional limitation: this app has no login system,
-- so there's no server-side way to prove a request "owns" a given
-- device_id. These policies allow the anon key to read/write ANY row,
-- relying on device_id being an unguessable random UUID (128 bits) as the
-- only access control. That's adequate for non-sensitive data (a symbol
-- watchlist and % thresholds) but is NOT the same as real per-user security.
-- Anyone who obtained another device's UUID could read or overwrite its
-- config. If that ever matters, this needs real Supabase Auth instead.
drop policy if exists "anon full access" on push_subscriptions;
create policy "anon full access" on push_subscriptions for all using (true) with check (true);

drop policy if exists "anon full access" on alert_configs;
create policy "anon full access" on alert_configs for all using (true) with check (true);

-- price_samples, alert_fired_log, trade_pnl_state are only ever touched by
-- the edge function using the service-role key, which bypasses RLS —
-- no policy needed for the anon key to access these.
