-- Adds the per-device settings needed for:
--   1. A master on/off switch for the 4 default "global rules" as a group.
--   2. A single master on/off switch shared between global alerts and
--      custom alerts.
--   3. User-editable % thresholds for the 5m/15m/30m/1h default rules
--      (replacing the hardcoded 4/6/8/10).
-- All three default to "on" / the original hardcoded percentages so
-- existing configs keep behaving exactly as before until a user changes
-- them.
alter table alert_configs
  add column if not exists global_rules_master_on boolean not null default true,
  add column if not exists other_alerts_master_on boolean not null default true,
  add column if not exists default_rule_pcts jsonb not null default '{"5":4,"15":6,"30":8,"60":10}'::jsonb;
