// src/entryRadar.js
//
// Entry Radar analysis engine. Pure functions — no network, no React, no
// clock reads (callers pass `now`) — so every rule here can be unit-tested.
//
// Philosophy
//  * Indicators and structure are computed on CLOSED candles only. The
//    current, still-forming candle is split off and used only for a
//    clearly-labelled PROVISIONAL read. Swing points need `k` closed candles
//    on each side, so nothing here can see the future.
//  * Correlated indicators are grouped into families and counted once
//    (EMA stack + EMA slope = one "EMA" family; swing structure = another;
//    ADX only scales trend STRENGTH, it never adds direction).
//  * The score is a heuristic ranking number, not a probability of winning.
//  * Derivatives data (OI, funding, long/short ratio) is context. It is
//    labelled UNAVAILABLE when missing and never fabricated. Values computed
//    here from raw data are labelled DERIVED by the UI.
//
// Raw candle shape (Binance kline): [openTime, open, high, low, close,
// volume, closeTime, quoteVolume, trades, takerBuyBase, takerBuyQuote, _].

export const STATUS = {
  LONG_WAIT: "LONG SETUP—WAIT FOR ENTRY",
  LONG_TRIGGERED: "LONG ENTRY TRIGGERED",
  SHORT_WAIT: "SHORT SETUP—WAIT FOR ENTRY",
  SHORT_TRIGGERED: "SHORT ENTRY TRIGGERED",
  TOO_FAR: "WAIT—PRICE TOO FAR FROM ZONE",
  NO_TRADE: "NO TRADE—CONFLICTING SIGNALS",
  INSUFFICIENT: "INSUFFICIENT DATA",
};

export const TF_MS = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000 };

export const DEFAULT_SETTINGS = {
  feePct: 0.05, // taker fee per side, % of notional (configurable)
  slippagePct: 0.03, // assumed slippage per side, % of price (configurable)
  minScore: 55, // a side must reach this to be treated as a setup
  minQuoteVol: 10_000_000, // 24h USDT volume below this is "poor liquidity"
  maxSpreadPct: 0.05, // best bid/ask spread above this is penalised
  maxChaseAtr: 1.0, // price further than this many 1H ATR beyond the zone = too far
  conflictMargin: 8, // LONG vs SHORT scores closer than this = conflicting
  staleMs: 5 * 60_000, // data older than this is flagged STALE and penalised
  deadMs: 20 * 60_000, // data older than this is unusable -> INSUFFICIENT DATA
  highVolPct: 5, // 1H ATR as % of price
  extremeVolPct: 8,
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const isNum = (x) => typeof x === "number" && Number.isFinite(x);

// ------------------------------------------------------------------ candles

// Raw kline rows -> clean candle objects. Invalid rows (non-finite, zero or
// negative prices, high < low) are dropped, duplicates removed, order fixed.
export function parseCandles(raw) {
  if (!Array.isArray(raw)) return { candles: [], dropped: 0 };
  const out = [];
  let dropped = 0;
  for (const k of raw) {
    if (!Array.isArray(k) || k.length < 7) {
      dropped++;
      continue;
    }
    const c = {
      t: Number(k[0]),
      o: parseFloat(k[1]),
      h: parseFloat(k[2]),
      l: parseFloat(k[3]),
      c: parseFloat(k[4]),
      v: parseFloat(k[5]),
      ct: Number(k[6]),
      qv: parseFloat(k[7]),
    };
    const ok =
      [c.t, c.o, c.h, c.l, c.c, c.ct].every(isNum) &&
      c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0 &&
      c.h >= c.l && c.h >= Math.max(c.o, c.c) - 1e-12 && c.l <= Math.min(c.o, c.c) + 1e-12;
    if (!ok) {
      dropped++;
      continue;
    }
    if (!isNum(c.v) || c.v < 0) c.v = 0;
    if (!isNum(c.qv) || c.qv < 0) c.qv = 0;
    out.push(c);
  }
  out.sort((a, b) => a.t - b.t);
  const dedup = [];
  for (const c of out) {
    if (dedup.length && dedup[dedup.length - 1].t === c.t) dedup[dedup.length - 1] = c;
    else dedup.push(c);
  }
  return { candles: dedup, dropped };
}

// A candle is closed once `now` is past its closeTime. The last (still
// open) candle is returned separately as `forming`.
export function splitClosed(candles, now) {
  const closed = [];
  let forming = null;
  for (const c of candles) {
    if (c.ct < now) closed.push(c);
    else forming = c;
  }
  return { closed, forming };
}

// Count missing candles inside the last `window` closed candles.
export function countGaps(closed, tfMs, window = 60) {
  const slice = closed.slice(-window);
  let gaps = 0;
  for (let i = 1; i < slice.length; i++) if (slice[i].t - slice[i - 1].t > tfMs * 1.5) gaps++;
  return gaps;
}

// --------------------------------------------------------------- indicators

// EMA seeded with the SMA of the first `p` values (null before that).
export function emaSeries(values, p) {
  const out = new Array(values.length).fill(null);
  if (values.length < p || p < 1) return out;
  let e = mean(values.slice(0, p));
  out[p - 1] = e;
  const k = 2 / (p + 1);
  for (let i = p; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

// Wilder RSI (null until `p` changes exist).
export function rsiSeries(c, p = 14) {
  const out = new Array(c.length).fill(null);
  if (c.length <= p) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) {
    const d = c[i] - c[i - 1];
    if (d >= 0) g += d;
    else l -= d;
  }
  let ag = g / p, al = l / p;
  const val = () => (al === 0 ? (ag === 0 ? 50 : 100) : 100 - 100 / (1 + ag / al));
  out[p] = val();
  for (let i = p + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
    al = (al * (p - 1) + (d < 0 ? -d : 0)) / p;
    out[i] = val();
  }
  return out;
}

export function trueRange(h, l, c, i) {
  if (i === 0) return h[0] - l[0];
  return Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
}

// Wilder ATR (null until `p` true ranges exist).
export function atrSeries(h, l, c, p = 14) {
  const n = h.length;
  const out = new Array(n).fill(null);
  if (n <= p) return out;
  let a = 0;
  for (let i = 1; i <= p; i++) a += trueRange(h, l, c, i);
  a /= p;
  out[p] = a;
  for (let i = p + 1; i < n; i++) {
    a = (a * (p - 1) + trueRange(h, l, c, i)) / p;
    out[i] = a;
  }
  return out;
}

// Wilder ADX (needs 2p+1 candles; null before that).
export function adxSeries(h, l, c, p = 14) {
  const n = h.length;
  const out = new Array(n).fill(null);
  if (n < p * 2 + 1) return out;
  const tr = new Array(n).fill(0), pdm = new Array(n).fill(0), mdm = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = h[i] - h[i - 1];
    const dn = l[i - 1] - l[i];
    pdm[i] = up > dn && up > 0 ? up : 0;
    mdm[i] = dn > up && dn > 0 ? dn : 0;
    tr[i] = trueRange(h, l, c, i);
  }
  let trS = 0, pS = 0, mS = 0;
  for (let i = 1; i <= p; i++) {
    trS += tr[i];
    pS += pdm[i];
    mS += mdm[i];
  }
  const dx = new Array(n).fill(null);
  const calc = () => {
    if (trS === 0) return 0;
    const pdi = (100 * pS) / trS, mdi = (100 * mS) / trS;
    return pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
  };
  dx[p] = calc();
  for (let i = p + 1; i < n; i++) {
    trS = trS - trS / p + tr[i];
    pS = pS - pS / p + pdm[i];
    mS = mS - mS / p + mdm[i];
    dx[i] = calc();
  }
  const first = 2 * p - 1;
  let adx = mean(dx.slice(p, first + 1));
  out[first] = adx;
  for (let i = first + 1; i < n; i++) {
    adx = (adx * (p - 1) + dx[i]) / p;
    out[i] = adx;
  }
  return out;
}

// Last value of `vols` relative to the average of the `lookback` values
// BEFORE it (the candle being judged is not part of its own baseline).
export function relVolume(vols, lookback = 20) {
  if (vols.length < lookback + 1) return null;
  const base = mean(vols.slice(-lookback - 1, -1));
  if (!(base > 0)) return null;
  return vols[vols.length - 1] / base;
}

// Confirmed swing points. A pivot at i needs k candles on each side, so the
// newest k candles can never be pivots (no look-ahead).
export function findPivots(h, l, k) {
  const highs = [], lows = [];
  for (let i = k; i < h.length - k; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= k; j++) {
      if (!(h[i] >= h[i - j] && h[i] > h[i + j])) isH = false;
      if (!(l[i] <= l[i - j] && l[i] < l[i + j])) isL = false;
    }
    if (isH) highs.push({ i, price: h[i] });
    if (isL) lows.push({ i, price: l[i] });
  }
  return { highs, lows };
}

const EQ = 0.0005;
const rel = (a, b) => (b ? (a - b) / b : 0);

// BULLISH = last two swing highs AND lows both higher; BEARISH = both lower.
export function classifyStructure(pivots) {
  const hs = pivots.highs, ls = pivots.lows;
  if (hs.length < 2 || ls.length < 2) return { label: "UNKNOWN", hh: false, hl: false, lh: false, ll: false };
  const dh = rel(hs[hs.length - 1].price, hs[hs.length - 2].price);
  const dl = rel(ls[ls.length - 1].price, ls[ls.length - 2].price);
  const hh = dh > EQ, lh = dh < -EQ, hl = dl > EQ, ll = dl < -EQ;
  const label = hh && hl ? "BULLISH" : lh && ll ? "BEARISH" : "RANGE";
  return { label, hh, hl, lh, ll };
}

// Cluster nearby swing prices into zones. Strength rewards repeated touches
// and recent activity.
export function clusterZones(points, tol, n) {
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters = [];
  for (const p of sorted) {
    const cur = clusters[clusters.length - 1];
    if (cur && p.price - cur.hi <= tol && p.price - cur.lo <= tol * 2) {
      cur.pts.push(p);
      cur.hi = Math.max(cur.hi, p.price);
    } else clusters.push({ lo: p.price, hi: p.price, pts: [p] });
  }
  return clusters.map((cl) => {
    const touches = cl.pts.length;
    const lastIdx = Math.max(...cl.pts.map((p) => p.i));
    const recency = n > 1 ? lastIdx / (n - 1) : 1;
    const strength = Math.round(clamp(0.6 * Math.min(1, touches / 4) + 0.4 * recency, 0, 1) * 100);
    return { lo: cl.lo, hi: cl.hi, mid: (cl.lo + cl.hi) / 2, touches, lastIdx, strength };
  });
}

// ------------------------------------------------------------------ frames

// Everything computed from ONE timeframe's candles (closed only).
export function analyzeFrame(rawCandles, now, tf, opts = {}) {
  const tfMs = TF_MS[tf];
  const parsed = rawCandles && rawCandles.candles ? rawCandles : parseCandles(rawCandles);
  const { closed, forming } = splitClosed(parsed.candles, now);
  const n = closed.length;
  const frame = { tf, tfMs, n, closed, forming, dropped: parsed.dropped || 0, gaps: countGaps(closed, tfMs), ok: false };
  if (n < 30) return frame;
  const h = closed.map((c) => c.h), l = closed.map((c) => c.l), c = closed.map((x) => x.c), qv = closed.map((x) => x.qv);
  const ema20s = emaSeries(c, 20), ema50s = emaSeries(c, 50), ema200s = emaSeries(c, 200);
  const rsis = rsiSeries(c, 14), atrs = atrSeries(h, l, c, 14), adxs = adxSeries(h, l, c, 14);
  const lastI = n - 1;
  const k = opts.swingK || (tf === "15m" || tf === "5m" ? 2 : 3);
  const pivots = findPivots(h, l, k);
  const atr = atrs[lastI];
  const price = c[lastI];
  const lookback = Math.min(n, 150);
  const off = n - lookback;
  const pts = [];
  pivots.highs.forEach((p) => p.i >= off && pts.push({ price: p.price, i: p.i - off }));
  pivots.lows.forEach((p) => p.i >= off && pts.push({ price: p.price, i: p.i - off }));
  const tol = Math.max((atr || price * 0.005) * 0.35, price * 0.0015);
  const zones = clusterZones(pts, tol, lookback).map((z) => ({ ...z, lastIdx: z.lastIdx + off }));
  const e50prev = ema50s[lastI - 6];
  Object.assign(frame, {
    ok: atr !== null && atr !== undefined && ema50s[lastI] !== null,
    last: closed[lastI],
    price,
    ema20: ema20s[lastI],
    ema50: ema50s[lastI],
    ema200: ema200s[lastI], // null with < 200 closed candles (reported UNAVAILABLE)
    ema50SlopeAtr: e50prev !== null && e50prev !== undefined && atr ? (ema50s[lastI] - e50prev) / atr : null,
    rsi: rsis[lastI],
    rsiPrev: rsis[lastI - 3] ?? null,
    atr,
    adx: adxs[lastI],
    relVol: relVolume(qv, 20),
    pivots,
    structure: classifyStructure(pivots),
    zones,
    lastSwingHigh: pivots.highs.length ? pivots.highs[pivots.highs.length - 1] : null,
    lastSwingLow: pivots.lows.length ? pivots.lows[pivots.lows.length - 1] : null,
    series: { ema20: ema20s, c, h, l, qv },
  });
  return frame;
}

// ---------------------------------------------------------------- 4H trend

export function trendFromFrame(f) {
  if (!f || !f.ok) return { dir: 0, label: "UNKNOWN", strength: 0, notes: ["4H data missing"] };
  const { price, ema20, ema50, ema200 } = f;
  // EMA family (stack + slope count once)
  let stack = 0;
  if (price > ema20 && ema20 > ema50 && (ema200 === null || ema50 > ema200)) stack = 1;
  else if (price < ema20 && ema20 < ema50 && (ema200 === null || ema50 < ema200)) stack = -1;
  else if (price > ema50) stack = 0.4;
  else if (price < ema50) stack = -0.4;
  const slope = f.ema50SlopeAtr === null ? 0 : clamp(f.ema50SlopeAtr / 0.5, -1, 1);
  const emaFam = 0.65 * stack + 0.35 * slope;
  const st = f.structure.label === "BULLISH" ? 1 : f.structure.label === "BEARISH" ? -1 : 0;
  const dirScore = 0.5 * emaFam + 0.5 * st;
  const dir = Math.abs(dirScore) >= 0.45 ? Math.sign(dirScore) : 0;
  const adxN = f.adx === null ? 0.3 : clamp(f.adx / 40, 0, 1);
  const strength = Math.round(100 * (0.6 * Math.min(1, Math.abs(dirScore)) + 0.4 * adxN) * (dir === 0 ? 0.5 : 1));
  const notes = [
    `EMA family ${emaFam >= 0 ? "+" : ""}${emaFam.toFixed(2)}`,
    `structure ${f.structure.label}`,
    f.adx === null ? "ADX UNAVAILABLE" : `ADX ${f.adx.toFixed(0)}`,
    ema200 === null ? "EMA200 UNAVAILABLE (history < 200 candles)" : `price ${price > ema200 ? "above" : "below"} EMA200`,
  ];
  return { dir, label: dir === 1 ? "UP" : dir === -1 ? "DOWN" : "RANGE", strength, dirScore, notes };
}

// ----------------------------------------------------- breakout / retest (1H)

// Look for a recent CLOSE through a zone with volume, that has held, and
// whether it has been retested. dir=+1 breakout up, -1 breakdown.
export function detectBreak(f, dir, lookback = 12) {
  if (!f || !f.ok) return null;
  const { closed, zones, atr } = f;
  const n = closed.length;
  const qv = closed.map((x) => x.qv);
  let best = null;
  for (const z of zones) {
    const edge = dir === 1 ? z.hi : z.lo;
    for (let j = Math.max(21, n - lookback); j < n; j++) {
      const beyond = dir === 1 ? closed[j].c > edge + atr * 0.15 : closed[j].c < edge - atr * 0.15;
      const prevInside = dir === 1 ? closed[j - 1].c <= edge : closed[j - 1].c >= edge;
      if (!(beyond && prevInside)) continue;
      const base = mean(qv.slice(j - 20, j));
      const volOk = base > 0 && qv[j] >= base * 1.2;
      let holds = true, retested = false, retestFailed = false;
      for (let q = j + 1; q < n; q++) {
        if (dir === 1 ? closed[q].c < edge - atr * 0.1 : closed[q].c > edge + atr * 0.1) holds = false;
        const touched = dir === 1 ? closed[q].l <= edge + atr * 0.25 : closed[q].h >= edge - atr * 0.25;
        if (touched) {
          if (dir === 1 ? closed[q].c > edge : closed[q].c < edge) retested = true;
          else retestFailed = true;
        }
      }
      if (!holds || retestFailed) continue;
      const cand = { zone: z, idx: j, volOk, retested, barsAgo: n - 1 - j };
      if (!best || (cand.volOk && !best.volOk) || (cand.volOk === best.volOk && cand.idx > best.idx)) best = cand;
    }
  }
  return best;
}

// ----------------------------------------------------------- entry plan

export function costPerUnit(entry, settings) {
  // round trip: fee + slippage on entry AND exit
  return entry * ((2 * settings.feePct + 2 * settings.slippagePct) / 100);
}

// Reward:risk NET of fees/slippage. Returns null for a non-positive risk.
export function rrNet(entry, stop, target, settings) {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  const cost = costPerUnit(entry, settings);
  const reward = Math.abs(target - entry) - cost;
  return reward / (risk + cost);
}

// side: +1 long, -1 short
export function buildPlan(side, ctx) {
  const { f1, f15, price, settings } = ctx;
  const s = side;
  const atr = f1.atr;
  const issues = [];
  const plan = { side: s, valid: false, issues, zone: null, entry: null, stop: null, invalidation: null, targets: [], rr1: null, rr2: null, rr3: null, riskPct: null, trigger: null };

  // ---- entry zone candidates (1H structure) ----
  const brk = detectBreak(f1, s);
  const retestZone = brk ? { lo: brk.zone.lo, hi: brk.zone.hi, type: "Breakout retest", strength: brk.zone.strength, retested: brk.retested, volOk: brk.volOk } : null;
  const emaOk = s === 1 ? f1.ema20 > f1.ema50 : f1.ema20 < f1.ema50;
  const emaZone = emaOk ? { lo: Math.min(f1.ema20, f1.ema50), hi: Math.max(f1.ema20, f1.ema50), type: "EMA20/50 pullback" } : null;
  let levelZone = null;
  const levelPool = f1.zones.filter((z) => (s === 1 ? z.hi <= price + atr * 0.25 && price - z.mid <= atr * 5 : z.lo >= price - atr * 0.25 && z.mid - price <= atr * 5));
  if (levelPool.length) {
    levelZone = levelPool.reduce((a, b) => (Math.abs(a.mid - price) <= Math.abs(b.mid - price) ? a : b));
    levelZone = { lo: levelZone.lo, hi: levelZone.hi, type: s === 1 ? "Support zone" : "Resistance zone", strength: levelZone.strength };
  }
  // an EMA zone is only usable if it sits on the correct side of price
  const emaUsable = emaZone && (s === 1 ? emaZone.hi <= price + atr * 0.5 : emaZone.lo >= price - atr * 0.5);
  let zone = null;
  if (retestZone && Math.abs(retestZone.hi - price) <= atr * 6) zone = retestZone;
  else if (emaUsable && levelZone && Math.abs((emaZone.lo + emaZone.hi) / 2 - (levelZone.lo + levelZone.hi) / 2) <= atr * 0.5) {
    zone = { lo: Math.min(emaZone.lo, levelZone.lo), hi: Math.max(emaZone.hi, levelZone.hi), type: "EMA + S/R confluence", strength: levelZone.strength };
  } else if (emaUsable && levelZone) {
    const ed = Math.abs((emaZone.lo + emaZone.hi) / 2 - price), ld = Math.abs((levelZone.lo + levelZone.hi) / 2 - price);
    zone = ed <= ld ? emaZone : levelZone;
  } else zone = emaUsable ? emaZone : levelZone;
  if (!zone) {
    issues.push("No structural entry zone (no pullback zone or support/resistance on the right side of price)");
    return plan;
  }
  // normalise width: at least 0.3 ATR, at most 1.6 ATR (keep the part nearest price)
  let { lo, hi } = zone;
  if (hi - lo < atr * 0.3) {
    const mid = (lo + hi) / 2;
    lo = mid - atr * 0.15;
    hi = mid + atr * 0.15;
  }
  if (hi - lo > atr * 1.6) {
    if (s === 1) lo = hi - atr * 1.6;
    else hi = lo + atr * 1.6;
  }
  plan.zone = { lo, hi, type: zone.type, strength: zone.strength ?? null };
  const entry = (lo + hi) / 2;
  plan.entry = entry;

  // ---- invalidation + stop (structure first, ATR buffer) ----
  let inval;
  if (s === 1) {
    const sw = f1.lastSwingLow && f1.lastSwingLow.price < hi ? f1.lastSwingLow.price : null;
    inval = sw !== null && hi - sw <= atr * 4 ? Math.min(lo, sw) : lo;
  } else {
    const sw = f1.lastSwingHigh && f1.lastSwingHigh.price > lo ? f1.lastSwingHigh.price : null;
    inval = sw !== null && sw - lo <= atr * 4 ? Math.max(hi, sw) : hi;
  }
  let stop = inval - s * atr * 0.25;
  if (Math.abs(entry - stop) < atr * 0.8) stop = entry - s * atr * 0.8;
  const stopDist = Math.abs(entry - stop);
  if (stopDist > atr * 5) {
    issues.push("Stop would be more than 5 ATR away — structure too wide to trade");
    plan.invalidation = inval;
    plan.stop = stop;
    return plan;
  }
  if (stopDist > atr * 3.5) issues.push("Wide stop (> 3.5 ATR)");
  plan.invalidation = inval;
  plan.stop = stop;
  plan.riskPct = (stopDist / entry) * 100;

  // ---- targets: opposing structure first, ATR ladder as fallback ----
  const levels = f1.zones
    .filter((z) => (s === 1 ? z.lo > entry + atr * 0.5 : z.hi < entry - atr * 0.5))
    .sort((a, b) => (s === 1 ? a.lo - b.lo : b.hi - a.hi));
  const targets = [];
  for (const z of levels) {
    const p = s === 1 ? z.lo : z.hi;
    const prev = targets.length ? targets[targets.length - 1].price : entry;
    if (Math.abs(p - prev) >= atr * 0.8) targets.push({ price: p, source: `${s === 1 ? "resistance" : "support"} zone (strength ${z.strength})` });
    if (targets.length === 3) break;
  }
  const ladder = [1.5, 2.8, 4.5];
  for (let q = targets.length; q < 3; q++) {
    const prev = targets.length ? targets[targets.length - 1].price : entry;
    const base = entry + s * atr * ladder[q];
    const p = s === 1 ? Math.max(base, prev + atr * 0.6) : Math.min(base, prev - atr * 0.6);
    targets.push({ price: p, source: `ATR ladder (${ladder[q]}× 1H ATR)` });
  }
  plan.targets = targets.map((t, i) => ({ label: `TP${i + 1}`, ...t, rr: rrNet(entry, stop, t.price, settings) }));
  plan.rr1 = plan.targets[0].rr;
  plan.rr2 = plan.targets[1].rr;
  plan.rr3 = plan.targets[2].rr;
  plan.costPct = settings.feePct * 2 + settings.slippagePct * 2;
  // nearby opposing level between entry and 1 ATR beyond it
  const near = f1.zones.find((z) => (s === 1 ? z.lo > entry && z.lo - entry < atr * 1.0 : z.hi < entry && entry - z.hi < atr * 1.0));
  plan.nearOpposing = near ? { lo: near.lo, hi: near.hi, strength: near.strength } : null;

  // ---- 15m trigger: close beyond the last confirmed 15m swing, judged on
  // candles BEFORE the candle that must do the closing (no look-ahead) ----
  plan.trigger = f15 && f15.ok ? triggerFrom15m(f15, s) : null;
  plan.valid = true;
  return plan;
}

// Trigger level + whether the LAST CLOSED 15m candle already confirmed it.
export function triggerFrom15m(f15, s) {
  const { closed, atr } = f15;
  const n = closed.length;
  if (n < 12) return null;
  const hist = closed.slice(0, n - 1); // everything before the confirming candle
  const h = hist.map((c) => c.h), l = hist.map((c) => c.l);
  const piv = findPivots(h, l, 2);
  const arr = s === 1 ? piv.highs : piv.lows;
  let level = null;
  if (arr.length) level = arr[arr.length - 1].price;
  else level = s === 1 ? Math.max(...h.slice(-4)) : Math.min(...l.slice(-4));
  const lastC = closed[n - 1];
  const emaOk = s === 1 ? lastC.c > f15.ema20 : lastC.c < f15.ema20;
  const beyond = s === 1 ? lastC.c > level : lastC.c < level;
  const volOk = f15.relVol !== null && f15.relVol >= 1.0;
  const closedConfirm = beyond && emaOk && volOk;
  return {
    level,
    closedConfirm,
    parts: { beyond, emaOk, volOk },
    text: `15m candle CLOSES ${s === 1 ? "above" : "below"} ${level} and ${s === 1 ? "above" : "below"} EMA20, on volume ≥ its 20-candle average`,
    atr15: atr,
  };
}

// ----------------------------------------------------------------- scoring

const W = { trend: 25, setup: 20, confirm: 15, rr: 15, momentum: 10, volume: 5, deriv: 10 };

export function scoreSide(side, ctx) {
  const { t4, f1, f15, plan, price, settings } = ctx;
  const s = side;
  const comps = [];
  const add = (key, name, weight, value, note, extra = {}) => {
    const v = clamp(value, 0, 1);
    comps.push({ key, name, weight, value: v, points: +(weight * v).toFixed(1), note, ...extra });
  };

  // 1. 4H trend alignment (EMA family + structure; ADX scales strength only)
  add("trend", "4H trend alignment", W.trend, t4.dir === s ? 0.55 + 0.45 * (t4.strength / 100) : t4.dir === 0 ? 0.25 : 0, `4H ${t4.label}, strength ${t4.strength}`);

  // 2. 1H setup structure + how close price is to the entry zone
  const want = s === 1 ? "BULLISH" : "BEARISH";
  const stv = f1.structure.label === want ? 0.6 : f1.structure.label === "RANGE" ? 0.3 : f1.structure.label === "UNKNOWN" ? 0.15 : 0;
  let prox = 0.2;
  if (plan.zone) {
    const dist = s === 1 ? Math.max(0, price - plan.zone.hi, plan.zone.lo - price) : Math.max(0, plan.zone.lo - price, price - plan.zone.hi);
    prox = dist === 0 ? 1 : dist <= f1.atr ? 0.6 : 0.2;
  }
  add("setup", "1H structure & location", W.setup, stv + 0.4 * prox, `1H structure ${f1.structure.label}; zone ${plan.zone ? plan.zone.type : "none"}`);

  // 3. 15m confirmation (each item is a different kind of evidence)
  let conf = 0;
  const notes15 = [];
  if (f15 && f15.ok) {
    const lc = f15.last;
    const aboveEma = s === 1 ? lc.c > f15.ema20 : lc.c < f15.ema20;
    if (aboveEma) conf += 0.3, notes15.push("closed " + (s === 1 ? "above" : "below") + " EMA20");
    if (f15.rsi !== null && (s === 1 ? f15.rsi > 50 : f15.rsi < 50)) conf += 0.2, notes15.push("RSI " + f15.rsi.toFixed(0));
    if (s === 1 ? lc.c > lc.o : lc.c < lc.o) conf += 0.2, notes15.push("last close with the direction");
    if (f15.relVol !== null && f15.relVol >= 1) conf += 0.15, notes15.push("volume ≥ average");
    if (plan.trigger && plan.trigger.closedConfirm) conf += 0.15, notes15.push("trigger confirmed on a closed candle");
  } else notes15.push("15m data UNAVAILABLE");
  add("confirm", "15m confirmation", W.confirm, conf, notes15.join(", ") || "no confirmation yet");

  // 4. reward:risk (net of fees/slippage)
  const rr2 = plan.rr2;
  add("rr", "Reward : risk (to TP2, net of costs)", W.rr, rr2 === null || rr2 === undefined ? 0 : (rr2 - 1) / 2, rr2 === null || rr2 === undefined ? "no plan" : `${rr2.toFixed(2)} : 1`);

  // 5. 1H momentum health — not exhausted / not extended
  let mom = 0.4;
  if (f1.rsi !== null) {
    const r = s === 1 ? f1.rsi : 100 - f1.rsi;
    mom = r >= 45 && r <= 65 ? 1 : r > 65 && r <= 72 ? 0.5 : r > 72 ? 0.1 : r >= 38 ? 0.4 : 0.2;
    const ext = Math.abs(price - f1.ema20) / f1.atr;
    if (ext > 2.5) mom *= 0.5;
  }
  add("momentum", "1H momentum health", W.momentum, mom, f1.rsi === null ? "RSI UNAVAILABLE" : `1H RSI ${f1.rsi.toFixed(0)}`);

  // 6. volume vs rolling baseline
  const rv = Math.max(f1.relVol ?? 0, f15 && f15.ok ? f15.relVol ?? 0 : 0);
  add("volume", "Volume vs baseline", W.volume, rv / 1.5, rv ? `${rv.toFixed(2)}× 20-candle average` : "UNAVAILABLE");

  // 7. derivatives context (OI / funding / long-short ratio)
  const d = ctx.deriv;
  const fund = ctx.funding;
  if (d && d.oiChange1hPct !== null && d.oiChange1hPct !== undefined) {
    const pxChg = ctx.priceChange1hPct ?? 0;
    const oiUp = d.oiChange1hPct > 0.3, oiDn = d.oiChange1hPct < -0.3;
    const pxUp = pxChg > 0.15, pxDn = pxChg < -0.15;
    let oiTerm = 0, why = "price/OI mixed";
    if (pxUp && oiUp) (oiTerm = s * 0.6), (why = "price↑ OI↑: possible new longs");
    else if (pxUp && oiDn) (oiTerm = s * 0.2), (why = "price↑ OI↓: possible short covering (weaker)");
    else if (pxDn && oiUp) (oiTerm = s * -0.6), (why = "price↓ OI↑: possible new shorts");
    else if (pxDn && oiDn) (oiTerm = s * -0.2), (why = "price↓ OI↓: possible long liquidation");
    const fr = fund ? fund.rate * 100 : null;
    const fTerm = fr === null ? 0 : s === 1 ? (fr > 0.05 ? -1 : fr < 0 ? 0.5 : 0) : fr < -0.05 ? -1 : fr > 0 ? 0.5 : 0;
    const lsTerm = d.longPct === null || d.longPct === undefined ? 0 : s === 1 ? (d.longPct > 62 ? -1 : 0) : d.longPct < 38 ? -1 : d.longPct > 62 ? 0.5 : 0;
    add("deriv", "Derivatives context (OI · funding · L/S)", W.deriv, 0.5 + 0.35 * oiTerm + 0.15 * fTerm + 0.15 * lsTerm, `${why}; funding ${fr === null ? "UNAVAILABLE" : fr.toFixed(4) + "%"}; longs ${d.longPct == null ? "UNAVAILABLE" : d.longPct.toFixed(0) + "%"}`, { derived: true });
  } else {
    add("deriv", "Derivatives context (OI · funding · L/S)", W.deriv, 0.4, "UNAVAILABLE (not fetched yet) — neutral value used", { unavailable: true });
  }

  // ---- penalties ----
  const pen = [];
  const addPen = (name, points, note) => points > 0 && pen.push({ name, points: +points.toFixed(1), note });
  if (t4.dir === -s) addPen("4H trend conflicts", 25, `4H is ${t4.label}`);
  if (f1.structure.label === (s === 1 ? "BEARISH" : "BULLISH")) addPen("1H structure conflicts", 12, `1H ${f1.structure.label}`);
  if (f15 && f15.ok && f15.structure.label === (s === 1 ? "BEARISH" : "BULLISH")) addPen("15m structure conflicts", 8, `15m ${f15.structure.label}`);
  if (ctx.quoteVolume !== null && ctx.quoteVolume !== undefined && ctx.quoteVolume < settings.minQuoteVol) addPen("Poor liquidity", 25, `24h volume ${(ctx.quoteVolume / 1e6).toFixed(1)}M < ${(settings.minQuoteVol / 1e6).toFixed(0)}M`);
  if (ctx.spreadPct !== null && ctx.spreadPct !== undefined && ctx.spreadPct > settings.maxSpreadPct) addPen("Wide spread", Math.min(15, 5 + (ctx.spreadPct / settings.maxSpreadPct - 1) * 5), `spread ${ctx.spreadPct.toFixed(3)}%`);
  if (ctx.stale) addPen("Stale data", 20, "market data older than the freshness limit");
  const volPct = (f1.atr / price) * 100;
  if (volPct > settings.extremeVolPct) addPen("Extreme volatility", 20, `1H ATR ${volPct.toFixed(1)}% of price`);
  else if (volPct > settings.highVolPct) addPen("High volatility", 10, `1H ATR ${volPct.toFixed(1)}% of price`);
  if (plan.nearOpposing) addPen(s === 1 ? "Resistance just above entry" : "Support just below entry", 15, `${plan.nearOpposing.lo.toFixed(6)}–${plan.nearOpposing.hi.toFixed(6)}, within 1 ATR`);
  if (rr2 !== null && rr2 !== undefined) {
    if (rr2 < 1.2) addPen("Poor reward:risk", 20, `${rr2.toFixed(2)} : 1 to TP2`);
    else if (rr2 < 1.5) addPen("Weak reward:risk", 10, `${rr2.toFixed(2)} : 1 to TP2`);
  }
  if (plan.issues.some((i) => i.startsWith("Wide stop"))) addPen("Wide stop", 8, "stop > 3.5 ATR");

  const gross = comps.reduce((a, c) => a + c.points, 0);
  const penalty = pen.reduce((a, p) => a + p.points, 0);
  const score = Math.round(clamp(gross - penalty, 0, 100));
  return { side: s, score, gross: +gross.toFixed(1), penalty: +penalty.toFixed(1), components: comps, penalties: pen };
}

// ------------------------------------------------------------------ status

// Status transitions (evaluated top to bottom, first match wins):
//  1. data unusable / too short / stale beyond deadMs         -> INSUFFICIENT DATA
//  2. no side reaches minScore with a valid plan and a 4H
//     trend that does not oppose it, OR both sides qualify
//     within conflictMargin, OR price broke the invalidation   -> NO TRADE—CONFLICTING SIGNALS
//  3. closed 15m candle confirmed the trigger AND price is
//     still within the chase band of the zone                 -> <SIDE> ENTRY TRIGGERED
//  4. price already moved more than maxChaseAtr (1H ATR) away
//     from the zone in the trade direction                    -> WAIT—PRICE TOO FAR FROM ZONE
//                                                                 (hint: WAIT FOR PULLBACK / WAIT FOR RETEST)
//  5. otherwise                                                -> <SIDE> SETUP—WAIT FOR ENTRY
// A trigger seen only on the still-forming candle never reaches step 3: it
// stays step 5 with provisional=true.
export function classifyStatus({ scores, plans, t4, price, f1, trig, provisional, dataState, settings }) {
  if (dataState.insufficient) return { status: STATUS.INSUFFICIENT, side: null, reason: dataState.reason };
  const eligible = (s) => scores[s].score >= settings.minScore && plans[s].valid && t4.dir !== -s;
  const el = { 1: eligible(1), [-1]: eligible(-1) };
  if (!el[1] && !el[-1]) {
    return { status: STATUS.NO_TRADE, side: null, reason: `No side clears score ${settings.minScore} with a valid plan and a non-opposing 4H trend (LONG ${scores[1].score}, SHORT ${scores[-1].score})` };
  }
  if (el[1] && el[-1] && Math.abs(scores[1].score - scores[-1].score) < settings.conflictMargin) {
    return { status: STATUS.NO_TRADE, side: null, reason: `LONG ${scores[1].score} and SHORT ${scores[-1].score} are too close — conflicting` };
  }
  const s = el[1] && el[-1] ? (scores[1].score > scores[-1].score ? 1 : -1) : el[1] ? 1 : -1;
  const plan = plans[s];
  const atr = f1.atr;
  const invalidated = s === 1 ? price <= plan.invalidation : price >= plan.invalidation;
  if (invalidated) return { status: STATUS.NO_TRADE, side: s, reason: "Price broke the invalidation level — setup is no longer valid" };
  // distance beyond the zone in the trade direction (positive = moved away)
  const away = s === 1 ? price - plan.zone.hi : plan.zone.lo - price;
  const chase = settings.maxChaseAtr * atr;
  if (trig && trig.closedConfirm && away <= chase) {
    return { status: s === 1 ? STATUS.LONG_TRIGGERED : STATUS.SHORT_TRIGGERED, side: s, reason: "Closed 15m candle confirmed the trigger while price is still near the zone" };
  }
  if (away > chase) {
    const retest = plan.zone.type === "Breakout retest";
    return { status: STATUS.TOO_FAR, side: s, hint: retest ? "WAIT FOR RETEST" : "WAIT FOR PULLBACK", reason: `Price is ${(away / atr).toFixed(1)} ATR beyond the zone — do not chase` };
  }
  return { status: s === 1 ? STATUS.LONG_WAIT : STATUS.SHORT_WAIT, side: s, provisional: !!provisional, reason: provisional ? "Live (unclosed) 15m candle shows the trigger — PROVISIONAL until it closes" : "Waiting for price to reach the zone and a closed 15m confirmation" };
}

// A stable ID for a setup so alerts can be de-duplicated. The zone midpoint is
// bucketed by half a 1H ATR so small drifts keep the same ID.
export function setupId(symbol, side, plan, atr) {
  const bucket = atr > 0 ? Math.round(((plan.zone.lo + plan.zone.hi) / 2) / (atr * 0.5)) : 0;
  return `${symbol}:${side === 1 ? "L" : "S"}:${plan.zone.type.replace(/\W+/g, "")}:${bucket}`;
}

// ---------------------------------------------------------- main evaluator

// frames: { "4h": frame, "1h": frame, "15m": frame, "5m"?: frame } from analyzeFrame
// live:   { ticker:{lastPrice, priceChangePercent, quoteVolume}, book:{bid,ask}|null,
//           funding:{rate,nextFundingTime}|null, deriv:{...}|null }
// ages:   { "4h": ms, "1h": ms, "15m": ms, ticker: ms, deriv: ms|null }  (data age at `now`)
export function evaluateSymbol({ symbol, frames, live, ages, settings: userSettings, now }) {
  const settings = { ...DEFAULT_SETTINGS, ...(userSettings || {}) };
  const f4 = frames["4h"], f1 = frames["1h"], f15 = frames["15m"], f5 = frames["5m"] || null;
  const tk = live.ticker || null;
  const flags = [];
  const base = { symbol, settings, flags, ages: ages || {}, deriv: live.deriv || null, funding: live.funding || null };

  // ---- data sufficiency ----
  let reason = null;
  if (!tk || !isNum(parseFloat(tk.lastPrice)) || parseFloat(tk.lastPrice) <= 0) reason = "No valid ticker price";
  else if (!f4 || !f1 || !f15) reason = "Missing timeframe data";
  else if (!f4.ok || !f1.ok || !f15.ok) reason = `Not enough closed candles (4H ${f4.n}, 1H ${f1.n}, 15m ${f15.n}; need ≥ 55)`;
  else if (f4.n < 55 || f1.n < 55 || f15.n < 55) reason = `Not enough closed candles (4H ${f4.n}, 1H ${f1.n}, 15m ${f15.n}; need ≥ 55)`;
  else if (countGaps(f1.closed, TF_MS["1h"], 30) >= 3 || countGaps(f15.closed, TF_MS["15m"], 30) >= 3) reason = "Too many missing candles";
  const oldest = ages ? Math.max(ages["4h"] ?? 0, ages["1h"] ?? 0, ages["15m"] ?? 0, ages.ticker ?? 0) : 0;
  if (!reason && oldest > settings.deadMs) reason = `Data is ${Math.round(oldest / 60000)} min old`;
  const stale = !reason && oldest > settings.staleMs;
  if (stale) flags.push("STALE");
  if (reason) {
    return { ...base, status: STATUS.INSUFFICIENT, side: null, reason, score: { long: 0, short: 0 }, price: tk ? parseFloat(tk.lastPrice) : null };
  }

  const price = parseFloat(tk.lastPrice);
  const quoteVolume = parseFloat(tk.quoteVolume);
  const change24h = parseFloat(tk.priceChangePercent);
  const spreadPct = live.book && live.book.bid > 0 && live.book.ask > 0 ? ((live.book.ask - live.book.bid) / ((live.book.ask + live.book.bid) / 2)) * 100 : null;
  if (quoteVolume < settings.minQuoteVol) flags.push("LOW LIQUIDITY");
  if (spreadPct !== null && spreadPct > settings.maxSpreadPct) flags.push("WIDE SPREAD");
  if (f4.ema200 === null) flags.push("EMA200 UNAVAILABLE");
  if (!live.deriv) flags.push("OI/L-S UNAVAILABLE");

  // 1h price change from closed 1H candles (DERIVED)
  const c1 = f1.series.c;
  const priceChange1hPct = c1.length >= 2 ? ((price - c1[c1.length - 2]) / c1[c1.length - 2]) * 100 : null;

  const t4 = trendFromFrame(f4);
  const plans = {}, scores = {};
  for (const s of [1, -1]) {
    plans[s] = buildPlan(s, { f1, f15, price, settings });
    scores[s] = scoreSide(s, { t4, f1, f15, plan: plans[s], price, settings, deriv: live.deriv, funding: live.funding, quoteVolume, spreadPct, stale, priceChange1hPct });
  }

  // preliminary best side for the trigger/provisional read
  const prelim = scores[1].score >= scores[-1].score ? 1 : -1;
  const trig = plans[prelim].trigger;
  // provisional: the FORMING 15m candle (using the live price) is already beyond the trigger level
  const provisional = !!(trig && !trig.closedConfirm && (prelim === 1 ? price > trig.level : price < trig.level));
  // the engine only treats a trigger as confirmed using CLOSED candles
  const st = classifyStatus({ scores, plans, t4, price, f1, trig: plans[prelim === 1 ? 1 : -1].trigger, provisional, dataState: { insufficient: false }, settings });
  // classifyStatus may pick the other side; re-check the trigger for the chosen side
  let status = st;
  if (st.side && st.side !== prelim) {
    const tr2 = plans[st.side].trigger;
    const prov2 = !!(tr2 && !tr2.closedConfirm && (st.side === 1 ? price > tr2.level : price < tr2.level));
    status = classifyStatus({ scores, plans, t4, price, f1, trig: tr2, provisional: prov2, dataState: { insufficient: false }, settings });
  }

  // optional 5m fine-entry read (information only — not scored, so it can't double count 15m)
  let fine = null;
  if (f5 && f5.ok && status.side) {
    const ok = status.side === 1 ? f5.last.c > f5.ema20 : f5.last.c < f5.ema20;
    fine = { aligned: ok, text: `5m closed ${status.side === 1 ? (ok ? "above" : "below") : ok ? "below" : "above"} EMA20` };
  }

  const best = status.side ? { side: status.side, score: scores[status.side].score, plan: plans[status.side] } : null;
  return {
    ...base,
    status: status.status,
    hint: status.hint || null,
    side: status.side,
    reason: status.reason,
    provisional: !!status.provisional,
    price,
    change24h,
    quoteVolume,
    spreadPct,
    t4,
    structure1h: f1.structure.label,
    structure15m: f15.structure.label,
    atr1h: f1.atr,
    score: { long: scores[1].score, short: scores[-1].score },
    detail: { long: scores[1], short: scores[-1] },
    plans: { long: plans[1], short: plans[-1] },
    best,
    id: best ? setupId(symbol, best.side, best.plan, f1.atr) : null,
    fine,
    formingCandle15m: f15.forming ? { o: f15.forming.o, c: f15.forming.c, closesAt: f15.forming.ct } : null,
    stale,
  };
}
