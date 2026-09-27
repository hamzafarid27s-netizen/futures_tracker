# Background Alerts — Setup

This adds real background price alerts: a server checks your rules once a
minute and sends a push notification even with the app fully closed. It's
optional — the app works exactly as before without doing any of this.

**Honest caveat before you start:** the Edge Function (step 4) could only be
syntax-checked here, not actually run — there's no Deno runtime available in
the environment I built this in. The logic mirrors the app's own
already-tested alert code closely, but treat the first live run as the real
test, and check the Supabase function logs (Dashboard → Edge Functions →
check-alerts → Logs) if notifications don't show up.

## What you'll need
- A free Supabase account (supabase.com) — separate from Vercel
- Node/npm locally (you already have this, from deploying the app itself)
- ~15 minutes

## 1. Create the Supabase project
1. Go to supabase.com/dashboard → New Project.
2. Pick any name/region, choose a database password (save it), free plan.
3. Wait ~2 minutes for it to finish provisioning.
4. Go to **Project Settings → API** and copy:
   - **Project URL** (looks like `https://xxxxx.supabase.co`)
   - **anon public** key
   - **service_role** key (keep this one secret — never put it client-side)
   Also note your **project ref** — the `xxxxx` part of the URL.

## 2. Create the database tables
1. In the Supabase dashboard, open **SQL Editor**.
2. Paste in the contents of `supabase/migrations/0001_init.sql` and run it.
   This creates the tables and a documented, intentional limitation: there's
   no login system in this app, so access control relies on your device's
   random ID being unguessable, not real per-user auth. Fine for a symbol
   watchlist; worth knowing.

## 3. Install the Supabase CLI
```
npm install -g supabase
supabase login
```
This opens a browser to authorize the CLI once.

## 4. Deploy the Edge Function
From inside this project folder:
```
supabase link --project-ref YOUR-PROJECT-REF
supabase secrets set VAPID_PUBLIC_KEY=BDfMCBaf7QnPBH7enYR6AKT84u9dA96S6TtEHqUQe2wYYZ8cP3d2ysFhUMd9YGUcONmqNFYZDNQQ9uHVfz8IOEc
supabase secrets set VAPID_PRIVATE_KEY=-8RTIRY08eysiR337Q99RaGbaq_2M8Yy29LFRUJ-i64
supabase secrets set FUNCTION_SECRET=4cf55bf3d34a0932847165c7a870a8c08aaf7a3e5bf459cc
supabase secrets set SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-from-step-1
supabase functions deploy check-alerts
```
The `FUNCTION_SECRET` and VAPID keys above were generated for you — you can
use them as-is, or generate your own (any random string works for
FUNCTION_SECRET; for your own VAPID pair, `npx web-push generate-vapid-keys`
works if you'd rather not reuse the ones here).

## 5. Schedule it to run every minute
1. Open `supabase/cron_setup.sql`, replace `YOUR-PROJECT-REF` and
   `YOUR-FUNCTION-SECRET-HERE` (use the same FUNCTION_SECRET from step 4).
2. Paste the result into the Supabase SQL Editor and run it.
3. Verify it's scheduled: `select * from cron.job;` should show
   `check-alerts-every-minute`.

## 6. Configure the app
Set these as Environment Variables in your Vercel project (Project Settings
→ Environment Variables), then redeploy:
```
VITE_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-public-key-from-step-1
VITE_VAPID_PUBLIC_KEY=BDfMCBaf7QnPBH7enYR6AKT84u9dA96S6TtEHqUQe2wYYZ8cP3d2ysFhUMd9YGUcONmqNFYZDNQQ9uHVfz8IOEc
```
(Never set `VITE_VAPID_PRIVATE_KEY` or the service-role key anywhere in
Vercel — those two are server-only secrets, already set in Supabase in step
4, and must never ship to the browser.)

## 7. Turn it on in the app
1. On your iPhone: add the app to your Home Screen and open it **from that
   icon**, not from Safari directly (this is a hard iOS requirement for
   push, not something in this app).
2. iOS 16.4 or later is required.
3. Go to the **Alerts** tab → **Background alerts** → **Turn on background
   alerts**, and allow the notification permission prompt.
4. You should see the status flip to **● ON**.

From then on, your watchlist's default rules, any 1h-or-under custom/global
alerts, and tracked-trade profit/loss flips all get checked server-side
every minute — notifications will arrive even with the app fully closed.

## Scope — what this covers and what it doesn't
- **Covered**: the four global rules, custom/global alerts set to 1h or
  under, tracked-trade PnL flips.
- **Not covered**: custom/global alerts set beyond 1h. Evaluating those
  server-side would mean downloading full kline history for every such
  alert on every device on every run — a much heavier, differently-shaped
  job. Those remain foreground-only for now, same as the in-app note says.
- Background alerts only fire while the app was installed to your Home
  Screen at least once to grant permission — after that, it works even with
  the app fully closed or your phone locked (subject to iOS's own delivery
  timing for backgrounded web push, which isn't always instant).

## Cost
Supabase's free tier comfortably covers this (a few hundred small rows,
one Edge Function call per minute). If you outgrow the free tier's limits,
that's a Supabase billing question, not something this app controls.
