-- Switches alert firing from "cooldown timer" to true edge-triggered
-- crossing detection, fixing two reported bugs:
--
--   1. The same alert (global rule, custom alert, or default rule) kept
--      re-firing every time its cooldown expired for as long as the
--      condition stayed true, instead of firing once per crossing.
--   2. ROI%/PNL($) trade-target alerts never notified when a value crossed
--      back down through a threshold it had previously crossed above
--      (or back up through a threshold it had dropped below).
--
-- This table replaces alert_fired_log's cooldown role for all rule types:
-- it stores whether a rule is CURRENTLY in its "passing" state for a given
-- device, so a notification only fires on the true/false transition
-- (the edge), not on every evaluation while the state is unchanged.
create table if not exists alert_rule_state (
  device_id text not null,
  rule_key text not null,
  is_active boolean not null,
  updated_at timestamptz not null default now(),
  primary key (device_id, rule_key)
);

alter table alert_rule_state enable row level security;
-- Only ever touched by the edge function using the service-role key.
