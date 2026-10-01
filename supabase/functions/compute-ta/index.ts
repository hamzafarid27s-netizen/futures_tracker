// supabase/functions/compute-ta/index.ts
//
// Runs on a schedule (via pg_cron) and computes the TA screener (trend,
// trend strength, momentum, support/resistance, reversal signal) server
// side, writing results into the `ta_screener` table. This is what makes
// the Screener tab in the app keep filling in and staying current even
// when nobody has the app open — the scan used to run entirely in the
// browser, so it stopped the moment the tab was closed or backgrounded.
//
// Each run only refreshes a BATCH of symbols (whichever haven't been
// scanned yet, then whichever are the stalest), not the whole universe —
// that keeps each invocation fast and well under Binance's rate limits.
// Running every few minutes via pg_cron, the full symbol list cycles
// through in well under an hour, which is plenty fresh for 4h-candle
// indicators.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const FUNCTION_SECRET = Deno.env.get("FUNCTION_SECRET") ?? "";

const BATCH_SIZE = 60; // symbols refreshed per run
const CHUNK_SIZE = 5; // concurrent klines requests within a batch

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---- pure indicator math — mirrors the client (src/App.jsx) exactly, so
// server-computed and any client-computed screener rows never disagree ----

function emaSeries(values: number[], period: number): number[] {
  if (!values || values.length === 0) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function rsiValue(closes: number[], period = 14): number | null {
  if (!closes || closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function adxValue(highs: number[], lows: number[], closes: number[], period = 14): number | null {
  const n = highs.length;
  if (n < period * 2) return null;
  const trs: number[] = [],
    plusDMs: number[] = [],
    minusDMs: number[] = [];
  for (let i = 1; i < n; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trs.push(
      Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]))
    );
  }
  const wilderSmooth = (arr: number[]) => {
    const out: number[] = [];
    let sum = arr.slice(0, period).reduce((a, b) => a + b, 0);
    out.push(sum);
    for (let i = period; i < arr.length; i++) {
      sum = sum - sum / period + arr[i];
      out.push(sum);
    }
    return out;
  };
  const trSm = wilderSmooth(trs);
  const plusSm = wilderSmooth(plusDMs);
  const minusSm = wilderSmooth(minusDMs);
  const dxs: number[] = [];
  for (let i = 0; i < trSm.length; i++) {
    if (trSm[i] === 0) continue;
    const plusDI = (100 * plusSm[i]) / trSm[i];
    const minusDI = (100 * minusSm[i]) / trSm[i];
    const sum = plusDI + minusDI;
    dxs.push(sum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / sum);
  }
  if (dxs.length < period) return dxs.length ? dxs[dxs.length - 1] : null;
  const firstAdx = dxs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let adx = firstAdx;
  for (let i = period; i < dxs.length; i++) {
    adx = (adx * (period - 1) + dxs[i]) / period;
  }
  return adx;
}

function swingLevels(highs: number[], lows: number[], lookback = 60) {
  const h = highs.slice(-lookback);
  const l = lows.slice(-lookback);
  return { resistance: h.length ? Math.max(...h) : null, support: l.length ? Math.min(...l) : null };
}

async function fetchTAForSymbol(symbol: string) {
  const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=150`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length < 60) throw new Error("not enough history");

  const highs = data.map((k: any) => parseFloat(k[2]));
  const lows = data.map((k: any) => parseFloat(k[3]));
  const closes = data.map((k: any) => parseFloat(k[4]));
  const last = closes[closes.length - 1];

  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const lastEma20 = ema20[ema20.length - 1];
  const lastEma50 = ema50[ema50.length - 1];
  const emaGapPct = ((lastEma20 - lastEma50) / lastEma50) * 100;

  let trend = "Sideways";
  if (last > lastEma20 && lastEma20 > lastEma50 && emaGapPct > 0.15) trend = "Up";
  else if (last < lastEma20 && lastEma20 < lastEma50 && emaGapPct < -0.15) trend = "Down";

  const adx = adxValue(highs, lows, closes, 14);
  let trendStrength = "Weak";
  if (adx !== null) {
    if (adx >= 35) trendStrength = "Very strong";
    else if (adx >= 25) trendStrength = "Strong";
    else if (adx >= 15) trendStrength = "Moderate";
  }

  const rsi = rsiValue(closes, 14);
  let momentum = "Neutral";
  if (rsi !== null) {
    if (rsi >= 70) momentum = "Overbought";
    else if (rsi >= 55) momentum = "Bullish";
    else if (rsi <= 30) momentum = "Oversold";
    else if (rsi <= 45) momentum = "Bearish";
  }

  const { support, resistance } = swingLevels(highs, lows, 60);
  // Absolute distance either direction — price can sit just above OR just
  // below a level and still be "near" it.
  const nearRes = resistance ? (Math.abs(resistance - last) / last) * 100 : null;
  const nearSup = support ? (Math.abs(last - support) / last) * 100 : null;

  let reversal = "None";
  if (rsi !== null) {
    if (rsi >= 70 && nearRes !== null && nearRes <= 2) reversal = "Possible top";
    else if (rsi <= 30 && nearSup !== null && nearSup <= 2) reversal = "Possible bottom";
    else if (rsi >= 75) reversal = "Overextended up";
    else if (rsi <= 25) reversal = "Overextended down";
  }

  return {
    trend,
    trendStrength,
    adx,
    momentum,
    rsi,
    support,
    resistance,
    nearSupportPct: nearSup,
    nearResistancePct: nearRes,
    reversal,
    price: last,
  };
}

Deno.serve(async (req: Request) => {
  if (req.headers.get("Authorization") !== `Bearer ${FUNCTION_SECRET}`) {
    return json({ error: "unauthorized" }, 401);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    // ---- symbol universe ----
    const exRes = await fetch("https://fapi.binance.com/fapi/v1/exchangeInfo");
    if (!exRes.ok) return json({ error: `binance HTTP ${exRes.status}` }, 502);
    const exData = await exRes.json();
    const symbols: string[] = (exData.symbols ?? [])
      .filter((s: any) => s.contractType === "PERPETUAL" && s.quoteAsset === "USDT" && s.status === "TRADING")
      .map((s: any) => s.symbol as string);
    const symbolSet = new Set(symbols);

    // ---- pick this run's batch: never-scanned symbols first, then the
    // stalest ones — so every symbol eventually gets covered and the data
    // keeps refreshing forever without ever needing a "restart" ----
    const { data: existing } = await supabase.from("ta_screener").select("symbol, updated_at");
    const existingMap = new Map<string, string>((existing ?? []).map((r: any) => [r.symbol, r.updated_at]));

    // drop rows for symbols that no longer trade
    const stale = (existing ?? []).filter((r: any) => !symbolSet.has(r.symbol)).map((r: any) => r.symbol);
    if (stale.length) await supabase.from("ta_screener").delete().in("symbol", stale);

    const neverScanned = symbols.filter((s) => !existingMap.has(s));
    const scannedSorted = symbols
      .filter((s) => existingMap.has(s))
      .sort((a, b) => new Date(existingMap.get(a)!).getTime() - new Date(existingMap.get(b)!).getTime());
    const batch = [...neverScanned, ...scannedSorted].slice(0, BATCH_SIZE);

    let done = 0;
    let failed = 0;
    const nowIso = new Date().toISOString();
    for (let i = 0; i < batch.length; i += CHUNK_SIZE) {
      const chunk = batch.slice(i, i + CHUNK_SIZE);
      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.allSettled(
        chunk.map(async (sym) => ({ symbol: sym, ...(await fetchTAForSymbol(sym)) }))
      );
      const rows: Record<string, unknown>[] = [];
      for (const r of results) {
        if (r.status === "fulfilled") {
          const v = r.value;
          rows.push({
            symbol: v.symbol,
            price: v.price,
            trend: v.trend,
            trend_strength: v.trendStrength,
            adx: v.adx,
            momentum: v.momentum,
            rsi: v.rsi,
            support: v.support,
            resistance: v.resistance,
            near_support_pct: v.nearSupportPct,
            near_resistance_pct: v.nearResistancePct,
            reversal: v.reversal,
            updated_at: nowIso,
          });
          done += 1;
        } else {
          failed += 1;
        }
      }
      if (rows.length) {
        // eslint-disable-next-line no-await-in-loop
        await supabase.from("ta_screener").upsert(rows);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 200));
    }

    return json({
      ok: true,
      totalSymbols: symbols.length,
      batchSize: batch.length,
      done,
      failed,
    });
  } catch (e: any) {
    return json({ error: e?.message ?? String(e) }, 500);
  }
});
