-- Run this AFTER deploying the check-alerts Edge Function (step 4 in SETUP.md).
-- Run once in the Supabase SQL Editor.

-- pg_net lets Postgres make HTTP calls; pg_cron schedules the SQL that does it.
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Store the project URL and the function's own shared secret so the schedule
-- doesn't need them hardcoded in plain SQL (visible to anyone with SQL
-- Editor read access otherwise).
select vault.create_secret('https://YOUR-PROJECT-REF.supabase.co', 'project_url');
select vault.create_secret('YOUR-FUNCTION-SECRET-HERE', 'function_secret');
-- ^ Replace YOUR-PROJECT-REF and YOUR-FUNCTION-SECRET-HERE before running —
--   the function secret is the same value you set as FUNCTION_SECRET when
--   deploying the Edge Function (step 4).

select
  cron.schedule(
    'check-alerts-every-minute',
    '* * * * *', -- every minute — Supabase's pg_cron supports this on the free tier
    $$
    select
      net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/check-alerts',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'function_secret')
        ),
        body := '{}'::jsonb
      ) as request_id;
    $$
  );

-- To check it's running: select * from cron.job_run_details order by start_time desc limit 20;
-- To stop it:            select cron.unschedule('check-alerts-every-minute');
