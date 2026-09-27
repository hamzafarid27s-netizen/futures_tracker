// supabase/functions/check-alerts/index.ts
//
// Runs on a schedule (via pg_cron) — NOT tied to any user's browser being
// open. Authenticated by a shared FUNCTION_SECRET checked in the handler
// itself (verify_jwt is off because pg_cron calls this with that secret,
// not a Supabase user JWT).
//
// Each run:
//   1. Fetches current Binance USDT-M futures prices (one request, done by
//      this server — not by every user's phone).
//   2. Maintains its own rolling price history so it can compute % change
//      over whatever intervals are actually configured, without needing
//      kline history per symbol.
//   3. Loads every device's alert config + saved trades from the database.
//   4. Evaluates default rules, global alerts, custom alerts (any interval
//      up to GLOBAL_BG_MAX_MIN), and tracked-trade PnL flips, sending a real
//      Web Push notification (via VAPID) for anything that fires.
//
// The retention window and the set of intervals actually computed are both
// DYNAMIC — sized to whatever the current configs actually need (at least
// the default rules' 60 minutes), rather than a fixed constant. An interval
// nobody has configured costs nothing; a 16h global alert costs keeping 16h
// of samples for every pair for as long as that alert exists.

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const FUNCTION_SECRET = Deno.env.get("FUNCTION_SECRET") ?? "";

const DEFAULT_MINUTES = [5, 15, 30, 60];
const GLOBAL_BG_MAX_MIN = 1440; // 24h hard ceiling — matches the client's cap
const RETENTION_BUFFER_MIN = 10; // small safety margin past the longest needed interval

// Supabase/PostgREST caps a single .select() at 1000 rows by default. With
// ~700+ pairs, even a 60-70 minute retention window is tens of thousands of
// rows — an unpaginated fetch silently returned only the first 1000,
// leaving most pairs with zero price history and every interval computing
// as null for them (found via live trace output, not assumed). Paginating
// through .range() retrieves the complete window regardless of size.
async function fetchAllSamples(supabase: any, cutoffIso: string) {
  const pageSize = 1000;
  let from = 0;
  const all: Array<{ symbol: string; price: number; sampled_at: string }> = [];
  while (true) {
    const { data, error } = await supabase
      .from("price_samples")
      .select("symbol, price, sampled_at")
      .gte("sampled_at", cutoffIso)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Nearest-sample % change lookup. Samples arrive once a minute (this
// function's own cron cadence), so a genuine match should always be within
// a couple of minutes of the target — tolerance stays tight and roughly
// constant regardless of how far back the target is, instead of scaling up
// to hours of slack for long intervals (which would make "16h ago" match
// almost anything from the last day).
function changeFromSamples(
  samples: { t: number; price: number }[],
  minutesAgo: number
): number | null {
  if (samples.length < 2) return null;
  const target = Date.now() - minutesAgo * 60_000;
  let closest = samples[0];
  let closestDiff = Math.abs(samples[0].t - target);
  for (const s of samples) {
    const diff = Math.abs(s.t - target);
    if (diff < closestDiff) {
      closest = s;
      closestDiff = diff;
    }
  }
  const toleranceMs = Math.min(30 * 60_000, Math.max(3 * 60_000, minutesAgo * 60_000 * 0.05));
  if (closestDiff > toleranceMs) return null;
  const last = samples[samples.length - 1].price;
  return ((last - closest.price) / closest.price) * 100;
}

Deno.serve(async (req: Request) => {
  if (req.headers.get("Authorization") !== `Bearer ${FUNCTION_SECRET}`) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return json({ error: "VAPID keys not configured" }, 500);
  }

  webpush.setVapidDetails(
    "mailto:alerts@futures-tracker.app",
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    // ---- 1. load configs FIRST — needed to know how far back to retain ----
    const { data: configs, error: cfgErr } = await supabase.from("alert_configs").select("*");
    if (cfgErr) throw cfgErr;
    const { data: subs, error: subErr } = await supabase.from("push_subscriptions").select("*");
    if (subErr) throw subErr;
    const subByDevice: Record<string, { endpoint: string; p256dh: string; auth: string }> = {};
    (subs ?? []).forEach((s: any) => {
      subByDevice[s.device_id] = { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth };
    });

    const neededMinutes = new Set<number>(DEFAULT_MINUTES);
    (configs ?? []).forEach((cfg: any) => {
      ((cfg.global_alerts ?? []) as Array<{ min: number }>).forEach((g) => {
        neededMinutes.add(Math.max(5, Math.min(GLOBAL_BG_MAX_MIN, Math.round(g.min))));
      });
      ((cfg.custom_alerts ?? []) as Array<{ min: number }>).forEach((c) => {
        neededMinutes.add(Math.max(5, Math.min(GLOBAL_BG_MAX_MIN, Math.round(c.min))));
      });
    });
    const maxMinutes = Math.max(...neededMinutes);
    const retentionMin = Math.min(GLOBAL_BG_MAX_MIN + RETENTION_BUFFER_MIN, maxMinutes + RETENTION_BUFFER_MIN);

    // ---- 2. current prices ----
    const tickerRes = await fetch("https://fapi.binance.com/fapi/v1/ticker/24hr");
    if (!tickerRes.ok) return json({ error: `binance HTTP ${tickerRes.status}` }, 502);
    const tickers = (await tickerRes.json()) as Array<{ symbol: string; lastPrice: string }>;
    const usdtTickers = tickers.filter((t) => t.symbol.endsWith("USDT"));
    const currentPrice: Record<string, number> = {};
    usdtTickers.forEach((t) => {
      currentPrice[t.symbol] = parseFloat(t.lastPrice);
    });

    // ---- 3. record this run's samples, then load the dynamic window ----
    const nowMs = Date.now();
    const sampleRows = usdtTickers.map((t) => ({
      symbol: t.symbol,
      price: currentPrice[t.symbol],
      sampled_at: new Date(nowMs).toISOString(),
    }));
    for (let i = 0; i < sampleRows.length; i += 500) {
      await supabase.from("price_samples").insert(sampleRows.slice(i, i + 500));
    }

    const cutoffIso = new Date(nowMs - retentionMin * 60_000).toISOString();
    const recentSamples = await fetchAllSamples(supabase, cutoffIso);

    // prune anything older than the (dynamic) retention window
    await supabase.from("price_samples").delete().lt("sampled_at", cutoffIso);

    const bySymbol: Record<string, { t: number; price: number }[]> = {};
    (recentSamples ?? []).forEach((row: { symbol: string; price: number; sampled_at: string }) => {
      const t = new Date(row.sampled_at).getTime();
      (bySymbol[row.symbol] ||= []).push({ t, price: Number(row.price) });
    });
    Object.values(bySymbol).forEach((arr) => arr.sort((a, b) => a.t - b.t));

    const changes: Record<string, Record<number, number | null>> = {};
    Object.keys(currentPrice).forEach((sym) => {
      changes[sym] = {};
      neededMinutes.forEach((min) => {
        changes[sym][min] = changeFromSamples(bySymbol[sym] ?? [], min);
      });
    });

    // ---- 4. cooldown state ----
    // Prune anything older than the longest possible cooldown (24h, since
    // GLOBAL_BG_MAX_MIN caps every interval there) BEFORE reading — keeps
    // this table bounded by "how many rules are active" rather than growing
    // forever, so it never approaches the same 1000-row fetch limit that
    // caused the price_samples bug above.
    await supabase.from("alert_fired_log").delete().lt("fired_at", new Date(nowMs - 25 * 60 * 60_000).toISOString());
    const { data: fired } = await supabase
      .from("alert_fired_log")
      .select("device_id, rule_key, fired_at");
    const lastFired: Record<string, number> = {};
    (fired ?? []).forEach((f: any) => {
      lastFired[`${f.device_id}|${f.rule_key}`] = new Date(f.fired_at).getTime();
    });

    const toFire: Array<{ deviceId: string; ruleKey: string; title: string; body: string }> = [];
    const toRemoveSubs: string[] = [];

    const cooldownOk = (deviceId: string, ruleKey: string, minutes: number) => {
      const key = `${deviceId}|${ruleKey}`;
      const cooldownMs = Math.max(minutes * 60_000, 60_000);
      const prev = lastFired[key];
      if (prev && nowMs - prev < cooldownMs) return false;
      return true;
    };

    const labelFor = (min: number) => {
      if (min < 60) return `${min}m`;
      const h = Math.floor(min / 60);
      const m = min % 60;
      return m ? `${h}h${m}m` : `${h}h`;
    };

    for (const cfg of configs ?? []) {
      const deviceId = cfg.device_id as string;
      if (!subByDevice[deviceId]) continue; // no subscription, nothing to send to

      const rulesEnabled = cfg.rules_enabled ?? {};
      const customAlerts = (cfg.custom_alerts ?? []) as Array<{ id: string; symbol: string; min: number; pct: number; dir: string }>;
      const globalAlerts = (cfg.global_alerts ?? []) as Array<{ id: string; min: number; pct: number; dir: string }>;
      const savedTrades = (cfg.saved_trades ?? []) as Array<{ id: string; symbol: string; entry: number; margin: number; leverage: number; dir: string }>;

      const DEFAULT_RULES = [
        { min: 5, pct: 4 },
        { min: 15, pct: 6 },
        { min: 30, pct: 8 },
        { min: 60, pct: 10 },
      ];

      // default rules — every symbol
      for (const rule of DEFAULT_RULES) {
        if (!rulesEnabled[String(rule.min)]) continue;
        for (const sym of Object.keys(currentPrice)) {
          const chg = changes[sym]?.[rule.min];
          if (chg === null || chg === undefined) continue;
          if (Math.abs(chg) >= rule.pct) {
            const ruleKey = `default:${rule.min}|${sym}`;
            if (cooldownOk(deviceId, ruleKey, rule.min)) {
              toFire.push({
                deviceId,
                ruleKey,
                title: `${sym.replace("USDT", "/USDT")} ${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%`,
                body: `Moved ${chg >= 0 ? "up" : "down"} more than ${rule.pct}% in ${rule.min}m`,
              });
              lastFired[`${deviceId}|${ruleKey}`] = nowMs;
            }
          }
        }
      }

      // global alerts — any pair, any interval up to GLOBAL_BG_MAX_MIN
      for (const g of globalAlerts) {
        const min = Math.max(5, Math.min(GLOBAL_BG_MAX_MIN, Math.round(g.min)));
        for (const sym of Object.keys(currentPrice)) {
          const chg = changes[sym]?.[min];
          if (chg === null || chg === undefined) continue;
          const passes = g.dir === "either" ? Math.abs(chg) >= g.pct : g.dir === "up" ? chg >= g.pct : -chg >= g.pct;
          if (passes) {
            const ruleKey = `global:${g.id}|${sym}`;
            if (cooldownOk(deviceId, ruleKey, min)) {
              toFire.push({
                deviceId,
                ruleKey,
                title: `${sym.replace("USDT", "/USDT")} ${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%`,
                body: `Passed your ±${g.pct}% / ${labelFor(min)} alert`,
              });
              lastFired[`${deviceId}|${ruleKey}`] = nowMs;
            }
          }
        }
      }

      // custom alerts — one specific pair, any interval up to GLOBAL_BG_MAX_MIN
      for (const c of customAlerts) {
        const min = Math.max(5, Math.min(GLOBAL_BG_MAX_MIN, Math.round(c.min)));
        const chg = changes[c.symbol]?.[min];
        if (chg === null || chg === undefined) continue;
        const passes = c.dir === "either" ? Math.abs(chg) >= c.pct : c.dir === "up" ? chg >= c.pct : -chg >= c.pct;
        if (passes) {
          const ruleKey = `custom:${c.id}`;
          if (cooldownOk(deviceId, ruleKey, min)) {
            toFire.push({
              deviceId,
              ruleKey,
              title: `${c.symbol.replace("USDT", "/USDT")} ${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%`,
              body: `Passed your ±${c.pct}% / ${labelFor(min)} alert`,
            });
            lastFired[`${deviceId}|${ruleKey}`] = nowMs;
          }
        }
      }

      // tracked-trade PnL flip alerts + custom ROI%/PNL$ target alerts
      if (savedTrades.length) {
        const { data: pnlStates } = await supabase
          .from("trade_pnl_state")
          .select("trade_id, was_positive")
          .eq("device_id", deviceId);
        const stateByTrade: Record<string, boolean> = {};
        (pnlStates ?? []).forEach((r: any) => {
          stateByTrade[r.trade_id] = r.was_positive;
        });

        for (const t of savedTrades as Array<{
          id: string; symbol: string; entry: number; margin: number; leverage: number; dir: string;
          roiAlerts?: Array<{ id: string; pct: number }>; pnlAlerts?: Array<{ id: string; value: number }>;
        }>) {
          const cur = currentPrice[t.symbol];
          if (!cur) continue;
          const sizeUsdt = t.margin * t.leverage;
          const pnl = t.dir === "long" ? ((cur - t.entry) / t.entry) * sizeUsdt : ((t.entry - cur) / t.entry) * sizeUsdt;
          const roi = t.margin ? (pnl / t.margin) * 100 : null;
          const nowPositive = pnl >= 0;
          const prev = stateByTrade[t.id];
          if (prev !== undefined && prev !== nowPositive) {
            const ruleKey = `trade:${t.id}`;
            toFire.push({
              deviceId,
              ruleKey,
              title: `${t.symbol.replace("USDT", "/USDT")} trade ${nowPositive ? "flipped to profit" : "flipped to loss"}`,
              body: `PnL is now ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDT`,
            });
          }
          await supabase
            .from("trade_pnl_state")
            .upsert({ device_id: deviceId, trade_id: t.id, was_positive: nowPositive, updated_at: new Date(nowMs).toISOString() });

          // Custom ROI% targets — signed threshold: positive fires on reaching
          // that gain, negative fires on dropping to that loss. 15-minute
          // cooldown (fixed, since these aren't tied to a lookback window).
          for (const a of t.roiAlerts ?? []) {
            if (roi === null) continue;
            const hit = a.pct >= 0 ? roi >= a.pct : roi <= a.pct;
            if (!hit) continue;
            const ruleKey = `roi:${t.id}:${a.id}`;
            if (cooldownOk(deviceId, ruleKey, 15)) {
              toFire.push({
                deviceId,
                ruleKey,
                title: `${t.symbol.replace("USDT", "/USDT")} ROI target hit`,
                body: `Target ${a.pct >= 0 ? "+" : ""}${a.pct}% · now ${roi >= 0 ? "+" : ""}${roi.toFixed(2)}%`,
              });
              lastFired[`${deviceId}|${ruleKey}`] = nowMs;
            }
          }

          // Custom PNL (USDT) targets — same signed-threshold convention.
          for (const a of t.pnlAlerts ?? []) {
            const hit = a.value >= 0 ? pnl >= a.value : pnl <= a.value;
            if (!hit) continue;
            const ruleKey = `pnl:${t.id}:${a.id}`;
            if (cooldownOk(deviceId, ruleKey, 15)) {
              toFire.push({
                deviceId,
                ruleKey,
                title: `${t.symbol.replace("USDT", "/USDT")} PNL target hit`,
                body: `Target ${a.value >= 0 ? "+" : ""}${a.value} USDT · now ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDT`,
              });
              lastFired[`${deviceId}|${ruleKey}`] = nowMs;
            }
          }
        }
      }
    }

    // ---- 5. send pushes ----
    let sent = 0;
    let failed = 0;
    for (const f of toFire) {
      const sub = subByDevice[f.deviceId];
      if (!sub) continue;
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify({ title: f.title, body: f.body })
        );
        sent += 1;
      } catch (e: any) {
        failed += 1;
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          toRemoveSubs.push(f.deviceId);
        }
      }
    }

    // ---- 6. persist cooldown records + cleanup dead subscriptions ----
    if (toFire.length) {
      await supabase.from("alert_fired_log").upsert(
        toFire.map((f) => ({ device_id: f.deviceId, rule_key: f.ruleKey, fired_at: new Date(nowMs).toISOString() }))
      );
    }
    if (toRemoveSubs.length) {
      await supabase.from("push_subscriptions").delete().in("device_id", [...new Set(toRemoveSubs)]);
    }

    return json({
      ok: true,
      evaluatedDevices: (configs ?? []).length,
      retentionMin,
      intervalsChecked: [...neededMinutes].sort((a, b) => a - b),
      fired: toFire.length,
      sent,
      failed,
    });
  } catch (e: any) {
    return json({ error: e?.message ?? String(e) }, 500);
  }
});
