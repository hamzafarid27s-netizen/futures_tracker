// Early Reversal & Possible Large-Player Activity detector — pure functions.
//
// Every value is labelled by where it comes from:
//   OFFICIAL  raw Binance public market data (candles, taker volume, OI history,
//             long/short ratio, funding history)
//   DERIVED   indicators and structure calculated here from OFFICIAL data
//   INFERRED  interpretations of several DERIVED/OFFICIAL values. They are
//             NOT proof of whale or "smart money" activity and never contain
//             positions, entry prices or PnL.
//   UNAVAILABLE  the data could not be loaded. It is never replaced by 0.
//
// Look-ahead rules: only CLOSED candles are used. A swing needs k candles on
// its right before it exists; a structure break must happen AFTER the swing it
// breaks was confirmed. The forming candle is never used for any signal.
//
// SCORES (heuristic rankings, NOT probabilities of profit). Max points:
//   regular/hidden RSI divergence 15, structure shift (CHOCH/BOS) 18, EMA shift 10,
//   MACD shift 10, volume + taker pressure 10, support/resistance reaction or
//   failed breakout 12, OI/funding/ratio flow 10, timeframe agreement 15.
//   A component whose data is UNAVAILABLE scores nothing and is listed as such,
//   so the highest possible score shrinks instead of being filled with guesses.
//   Penalties: stale data, low liquidity, strong opposing 4H trend, extreme volatility,
//   conflicting higher timeframe.
//
// EARLY vs CONFIRMED: a reversal is only CONFIRMED when a closed candle broke a
// confirmed swing against the prior structure (CHOCH) AND a second independent
// confirmation exists (EMA reclaim/cross or MACD flip) AND the score is high enough
// AND the opposite side is not close. Everything else is an early warning.

import {
  TF_MS,
  emaSeries,
  rsiSeries,
  relVolume,
  classifyStructure,
  findPivots,
  analyzeFrame,
} from "./entryRadar.js";

export const REV_STATE = {
  EARLY_BULL: "EARLY BULLISH REVERSAL",
  BULL_CONF: "BULLISH REVERSAL CONFIRMED",
  EARLY_BEAR: "EARLY BEARISH REVERSAL",
  BEAR_CONF: "BEARISH REVERSAL CONFIRMED",
  POT_BREAKOUT: "POTENTIAL BREAKOUT",
  BREAKOUT: "BREAKOUT CONFIRMED",
  POT_BREAKDOWN: "POTENTIAL BREAKDOWN",
  BREAKDOWN: "BREAKDOWN CONFIRMED",
  FALSE_RISK: "FALSE BREAKOUT RISK",
  NONE: "NO CLEAR SIGNAL",
  INSUFFICIENT: "INSUFFICIENT DATA",
  STALE: "DATA STALE",
};

export const FLOW = {
  ACCUM: "POSSIBLE ACCUMULATION",
  DISTRIB: "POSSIBLE DISTRIBUTION",
  LONGS: "LONGS BUILDING",
  SHORTS: "SHORTS BUILDING",
  COVER: "SHORT COVERING",
  LIQ: "LONG LIQUIDATION / DELEVERAGING",
  NONE: "NO CLEAR EVIDENCE",
};

export const REV_TFS = ["5m", "15m", "1h", "4h"];
export const TF_WEIGHT = { "4h": 0.4, "1h": 0.3, "15m": 0.2, "5m": 0.1 };

export const REV_DEFAULTS = {
  rsiPeriod: 14,
  divMinRsi: 2, // RSI points between the two pivots
  divMaxBars: 60,
  divRecent: 40, // the second pivot must be within this many candles
  shiftBars: 10, // a structure break counts for this many candles
  volSpike: 2.0, // relative volume that counts as a spike
  breakVol: 1.5, // relative volume needed for a confirmed breakout
  breakAtr: 0.15, // close must clear the level by this many ATR
  breakBars: 8,
  falseBars: 3, // close back inside within this many candles = failed breakout
  falseRecent: 6,
  earlyMin: 40,
  confirmMin: 60,
  conflictMargin: 10,
  oiMinPct: 1.0, // OI change (%) that counts as "rising/falling"
  takerBuy: 1.1, // buy/sell ratio considered buy-dominant (inverse = sell-dominant)
  fundExt: 0.0005, // |funding rate| of 0.05% per interval is "extreme"
  minQuoteVol: 10_000_000,
  staleMs: 5 * 60_000,
  deadMs: 20 * 60_000,
  highVolPct: 5,
  weights: { div: 15, structure: 18, ema: 10, macd: 10, volume: 10, sr: 12, flow: 10, agree: 15 },
};

const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round1 = (x) => Math.round(x * 10) / 10;

// "BTCUSDT", "BTC/USDT", "btc usdt", "btc-usdt", "BTC" -> "BTCUSDT"
export function normalizeSymbol(input) {
  if (typeof input !== "string") return null;
  let s = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!s) return null;
  if (!s.endsWith("USDT")) s += "USDT";
  return s.length > 4 ? s : null;
}

// ------------------------------------------------------------------ indicators

export function macdSeries(c, fast = 12, slow = 26, sig = 9) {
  const ef = emaSeries(c, fast), es = emaSeries(c, slow);
  const macd = c.map((_, i) => (ef[i] !== null && es[i] !== null && ef[i] !== undefined && es[i] !== undefined ? ef[i] - es[i] : null));
  const first = macd.findIndex((x) => x !== null);
  const signal = new Array(c.length).fill(null);
  const hist = new Array(c.length).fill(null);
  if (first >= 0) {
    const compact = macd.slice(first);
    const sg = emaSeries(compact, sig);
    for (let i = 0; i < compact.length; i++) {
      if (sg[i] !== null && sg[i] !== undefined) {
        signal[first + i] = sg[i];
        hist[first + i] = macd[first + i] - sg[i];
      }
    }
  }
  return { macd, signal, hist };
}

// ------------------------------------------------------------------ detectors

// Divergence between the last two CONFIRMED swing pivots and RSI at those pivots.
// regular bullish: lower low in price, higher low in RSI  (reversal warning)
// regular bearish: higher high in price, lower high in RSI
// hidden bullish: higher low in price, lower low in RSI   (trend continuation)
// hidden bearish: lower high in price, higher high in RSI
export function detectDivergence(closed, rsi, pivots, cfg = REV_DEFAULTS) {
  const out = [];
  const n = closed.length;
  const eq = 0.0005;
  const consider = (arr, isLow) => {
    if (arr.length < 2) return;
    const b = arr[arr.length - 1], a = arr[arr.length - 2];
    const bars = b.i - a.i;
    if (bars < 5 || bars > cfg.divMaxBars || n - 1 - b.i > cfg.divRecent) return;
    const ra = rsi[a.i], rb = rsi[b.i];
    if (!isNum(ra) || !isNum(rb)) return;
    const dr = rb - ra;
    const mk = (kind, dir) => out.push({ kind, dir, i1: a.i, i2: b.i, p1: a.price, p2: b.price, r1: ra, r2: rb, barsAgo: n - 1 - b.i });
    if (isLow) {
      if (b.price < a.price * (1 - eq) && dr >= cfg.divMinRsi) mk("regular", 1);
      else if (b.price > a.price * (1 + eq) && dr <= -cfg.divMinRsi) mk("hidden", 1);
    } else {
      if (b.price > a.price * (1 + eq) && dr <= -cfg.divMinRsi) mk("regular", -1);
      else if (b.price < a.price * (1 - eq) && dr >= cfg.divMinRsi) mk("hidden", -1);
    }
  };
  consider(pivots.lows, true);
  consider(pivots.highs, false);
  return out;
}

// Break of structure / change of character, judged candle by candle using ONLY
// swings that were already confirmed before the breaking candle.
//   CHOCH bullish: structure was bearish (last swing high lower than the one before) and a
//                  close takes out that lower high.
//   BOS bullish:   structure was bullish (HH+HL) and a close takes out the last swing high.
export function detectStructureShift(f, cfg = REV_DEFAULTS) {
  const out = { bullChoch: null, bullBos: null, bearChoch: null, bearBos: null };
  const { closed, pivots, atr } = f;
  const n = closed.length;
  const k = f.swingK || (f.tf === "15m" || f.tf === "5m" ? 2 : 3);
  if (!(atr > 0)) return out;
  const buf = atr * 0.05;
  for (let j = Math.max(1, n - cfg.shiftBars); j < n; j++) {
    const hs = pivots.highs.filter((p) => p.i + k <= j - 1);
    const ls = pivots.lows.filter((p) => p.i + k <= j - 1);
    if (hs.length < 2 || ls.length < 2) continue;
    const st = classifyStructure({ highs: hs, lows: ls });
    const lastH = hs[hs.length - 1], lastL = ls[ls.length - 1];
    const c = closed[j].c, pc = closed[j - 1].c;
    const barsAgo = n - 1 - j;
    if (c > lastH.price + buf && pc <= lastH.price + buf) {
      if (st.lh) out.bullChoch = { j, level: lastH.price, barsAgo, structure: st.label };
      else if (st.label === "BULLISH") out.bullBos = { j, level: lastH.price, barsAgo, structure: st.label };
    }
    if (c < lastL.price - buf && pc >= lastL.price - buf) {
      if (st.hl) out.bearChoch = { j, level: lastL.price, barsAgo, structure: st.label };
      else if (st.label === "BEARISH") out.bearBos = { j, level: lastL.price, barsAgo, structure: st.label };
    }
  }
  return out;
}

// A close beyond a zone that is reversed by a close back inside within
// `falseBars` candles (or a wick-only poke that closes back inside).
// dir +1 = bear trap (false breakdown, bullish evidence), -1 = bull trap (bearish evidence).
export function detectFalseBreakout(f, cfg = REV_DEFAULTS) {
  const out = [];
  const { closed, zones, atr } = f;
  const n = closed.length;
  if (!(atr > 0)) return out;
  for (const z of zones) {
    if (z.strength < 35) continue;
    for (let j = Math.max(1, n - cfg.falseRecent - cfg.falseBars); j < n; j++) {
      const cj = closed[j];
      // upward fake-out: bull trap
      const closeUp = cj.c > z.hi + atr * cfg.breakAtr && closed[j - 1].c <= z.hi;
      const wickUp = cj.h > z.hi + atr * 0.3 && cj.c < z.hi;
      if (closeUp) {
        const back = closed.slice(j + 1, j + 1 + cfg.falseBars).findIndex((x) => x.c < z.hi);
        if (back >= 0 && n - 1 - (j + 1 + back) <= cfg.falseRecent) out.push({ dir: -1, kind: "close-back", zone: z, j, back: j + 1 + back, barsAgo: n - 1 - (j + 1 + back) });
      } else if (wickUp && n - 1 - j <= cfg.falseRecent) out.push({ dir: -1, kind: "wick", zone: z, j, back: j, barsAgo: n - 1 - j });
      // downward fake-out: bear trap
      const closeDn = cj.c < z.lo - atr * cfg.breakAtr && closed[j - 1].c >= z.lo;
      const wickDn = cj.l < z.lo - atr * 0.3 && cj.c > z.lo;
      if (closeDn) {
        const back = closed.slice(j + 1, j + 1 + cfg.falseBars).findIndex((x) => x.c > z.lo);
        if (back >= 0 && n - 1 - (j + 1 + back) <= cfg.falseRecent) out.push({ dir: 1, kind: "close-back", zone: z, j, back: j + 1 + back, barsAgo: n - 1 - (j + 1 + back) });
      } else if (wickDn && n - 1 - j <= cfg.falseRecent) out.push({ dir: 1, kind: "wick", zone: z, j, back: j, barsAgo: n - 1 - j });
    }
  }
  out.sort((a, b) => a.barsAgo - b.barsAgo);
  return out;
}

// Breakouts above resistance / breakdowns below support using candle CLOSES.
export function detectBreakouts(f, cfg = REV_DEFAULTS, livePrice = null) {
  const res = { up: null, down: null };
  const { closed, zones, atr } = f;
  const n = closed.length;
  if (!(atr > 0) || n < 25) return res;
  const qv = closed.map((x) => x.qv);
  const rel = (j) => {
    const base = qv.slice(Math.max(0, j - 20), j);
    const m = base.length ? base.reduce((a, b) => a + b, 0) / base.length : 0;
    return m > 0 ? qv[j] / m : null;
  };
  const last = closed[n - 1];
  for (const z of zones) {
    if (z.strength < 40) continue;
    // ---- breakout over the zone's top ----
    let confirmed = null;
    for (let j = Math.max(21, n - cfg.breakBars); j < n; j++) {
      if (closed[j].c > z.hi + atr * cfg.breakAtr && closed[j - 1].c <= z.hi + atr * cfg.breakAtr * 0.5) {
        const rv = rel(j);
        const after = closed.slice(j + 1);
        const failed = after.some((x) => x.c < z.hi - atr * 0.1);
        if (failed) continue; // that is a failed breakout, handled by detectFalseBreakout
        const retestC = after.find((x) => x.l <= z.hi + atr * 0.25);
        confirmed = { status: "CONFIRMED", level: z.hi, zone: z, j, barsAgo: n - 1 - j, relVol: rv, volOk: rv !== null && rv >= cfg.breakVol, retest: retestC ? (retestC.c > z.hi ? "held" : "failed") : "none" };
      }
    }
    if (confirmed && (!res.up || confirmed.barsAgo < res.up.barsAgo)) res.up = confirmed;
    if (!confirmed && last.c <= z.hi && last.c >= z.lo - atr * 0.35 && (!res.up || res.up.status === "POTENTIAL")) {
      const rv = rel(n - 1);
      const provisional = isNum(livePrice) && livePrice > z.hi + atr * cfg.breakAtr;
      const pot = { status: "POTENTIAL", level: z.hi, zone: z, relVol: rv, volOk: rv !== null && rv >= cfg.breakVol, provisional, retest: "none" };
      if (!res.up || Math.abs(pot.level - last.c) < Math.abs(res.up.level - last.c)) res.up = pot;
    }
    // ---- breakdown under the zone's bottom ----
    let cd = null;
    for (let j = Math.max(21, n - cfg.breakBars); j < n; j++) {
      if (closed[j].c < z.lo - atr * cfg.breakAtr && closed[j - 1].c >= z.lo - atr * cfg.breakAtr * 0.5) {
        const rv = rel(j);
        const after = closed.slice(j + 1);
        const failed = after.some((x) => x.c > z.lo + atr * 0.1);
        if (failed) continue;
        const retestC = after.find((x) => x.h >= z.lo - atr * 0.25);
        cd = { status: "CONFIRMED", level: z.lo, zone: z, j, barsAgo: n - 1 - j, relVol: rv, volOk: rv !== null && rv >= cfg.breakVol, retest: retestC ? (retestC.c < z.lo ? "held" : "failed") : "none" };
      }
    }
    if (cd && (!res.down || cd.barsAgo < res.down.barsAgo)) res.down = cd;
    if (!cd && last.c >= z.lo && last.c <= z.hi + atr * 0.35 && (!res.down || res.down.status === "POTENTIAL")) {
      const rv = rel(n - 1);
      const provisional = isNum(livePrice) && livePrice < z.lo - atr * cfg.breakAtr;
      const pot = { status: "POTENTIAL", level: z.lo, zone: z, relVol: rv, volOk: rv !== null && rv >= cfg.breakVol, provisional, retest: "none" };
      if (!res.down || Math.abs(pot.level - last.c) < Math.abs(res.down.level - last.c)) res.down = pot;
    }
  }
  return res;
}

// Wick rejection at a confirmed zone within the last 3 closed candles.
export function detectSrReaction(f) {
  const out = [];
  const { closed, zones, atr } = f;
  const n = closed.length;
  if (!(atr > 0)) return out;
  for (let j = Math.max(0, n - 3); j < n; j++) {
    const c = closed[j];
    const range = c.h - c.l;
    if (!(range > 0)) continue;
    for (const z of zones) {
      if (z.strength < 40) continue;
      const lowerWick = Math.min(c.o, c.c) - c.l;
      const upperWick = c.h - Math.max(c.o, c.c);
      if (c.l <= z.hi + atr * 0.1 && c.l >= z.lo - atr * 0.5 && c.c > z.hi && lowerWick >= range * 0.45) out.push({ dir: 1, zone: z, j, barsAgo: n - 1 - j });
      if (c.h >= z.lo - atr * 0.1 && c.h <= z.hi + atr * 0.5 && c.c < z.lo && upperWick >= range * 0.45) out.push({ dir: -1, zone: z, j, barsAgo: n - 1 - j });
    }
  }
  return out;
}

// Relative volume of each of the last `m` closed candles (vs the 20 before it).
export function volumeSpikes(closed, m = 3) {
  const out = [];
  const n = closed.length;
  const qv = closed.map((x) => x.qv);
  for (let j = Math.max(21, n - m); j < n; j++) {
    const base = qv.slice(j - 20, j);
    const mean = base.reduce((a, b) => a + b, 0) / base.length;
    if (mean > 0) out.push({ j, rel: qv[j] / mean, up: closed[j].c >= closed[j].o, barsAgo: n - 1 - j });
  }
  return out;
}

// Taker buy share over the last `m` closed candles from the official kline field.
// null when any candle lacks it (UNAVAILABLE, not 0).
export function takerShare(closed, m = 3) {
  const s = closed.slice(-m);
  if (s.length < m || s.some((c) => c.tb === null || c.tb === undefined || !(c.v > 0))) return null;
  const buy = s.reduce((a, c) => a + c.tb, 0);
  const vol = s.reduce((a, c) => a + c.v, 0);
  return vol > 0 ? buy / vol : null;
}

// --------------------------------------------------------------- flow proxies

const pctChange = (a, b) => (isNum(a) && isNum(b) && b !== 0 ? ((a - b) / Math.abs(b)) * 100 : null);

// Interpretation of public positioning/volume data. INFERRED — never proof.
export function classifyFlow(m, cfg = REV_DEFAULTS) {
  const reasons = [];
  const missing = [];
  if (m.oiChg5 === null) missing.push("open interest");
  if (m.takerRatio === null && m.takerShareKline === null) missing.push("taker buy/sell");
  if (m.funding === null) missing.push("funding");
  if (m.lsChg5 === null) missing.push("long/short ratio");
  const buyDom = m.takerRatio !== null ? m.takerRatio >= cfg.takerBuy : m.takerShareKline !== null ? m.takerShareKline >= 0.54 : null;
  const sellDom = m.takerRatio !== null ? m.takerRatio <= 1 / cfg.takerBuy : m.takerShareKline !== null ? m.takerShareKline <= 0.46 : null;
  const volHigh = m.relVolMax !== null && m.relVolMax >= 1.5;
  const oiUp = m.oiChg5 !== null ? m.oiChg5 >= cfg.oiMinPct : null;
  const oiDown = m.oiChg5 !== null ? m.oiChg5 <= -cfg.oiMinPct : null;
  const priceUp = m.priceMoveAtr >= 0.5, priceDown = m.priceMoveAtr <= -0.5;
  const flat = !priceUp && !priceDown;

  // accumulation: base near support / after a decline, price no longer falling, buyers absorbing on volume
  const accum = [
    [m.nearSupport || m.afterDecline, "price is near support or after a decline"],
    [!priceDown, "price has stopped falling (flat or higher)"],
    [volHigh, `volume above normal (${m.relVolMax !== null ? m.relVolMax.toFixed(1) + "×" : "n/a"})`],
    [buyDom === true, "taker buying dominates"],
    [oiUp === true || (oiUp === false && oiDown === false), "open interest stable or rising"],
    [m.funding === null ? null : m.funding <= cfg.fundExt, "funding is not extremely positive"],
  ];
  const dist = [
    [m.nearResistance || m.afterAdvance, "price is near resistance or after an advance"],
    [!priceUp, "price has stopped rising (flat or lower)"],
    [volHigh, `volume above normal (${m.relVolMax !== null ? m.relVolMax.toFixed(1) + "×" : "n/a"})`],
    [sellDom === true, "taker selling dominates"],
    [oiUp === true || (oiUp === false && oiDown === false), "open interest stable or rising"],
    [m.funding === null ? null : m.funding >= cfg.fundExt * 0.4, "funding leans positive (longs paying)"],
  ];
  const score = (rows) => rows.filter((r) => r[0] === true).length;
  const known = (rows) => rows.filter((r) => r[0] !== null).length;
  const aScore = score(accum), dScore = score(dist);
  const needVolTaker = (rows) => rows[2][0] === true && rows[3][0] === true;
  let label = FLOW.NONE;
  if (aScore >= 5 && needVolTaker(accum) && aScore > dScore && known(accum) >= 5) {
    label = FLOW.ACCUM;
    accum.forEach((r) => r[0] === true && reasons.push(r[1]));
  } else if (dScore >= 5 && needVolTaker(dist) && dScore > aScore && known(dist) >= 5) {
    label = FLOW.DISTRIB;
    dist.forEach((r) => r[0] === true && reasons.push(r[1]));
  } else if (m.oiChg5 !== null && (oiUp || oiDown) && !flat) {
    if (priceUp && oiUp) {
      label = FLOW.LONGS;
      reasons.push(`price up ${m.priceMoveAtr.toFixed(1)} ATR while open interest rose ${m.oiChg5.toFixed(1)}%`);
    } else if (priceDown && oiUp) {
      label = FLOW.SHORTS;
      reasons.push(`price down ${Math.abs(m.priceMoveAtr).toFixed(1)} ATR while open interest rose ${m.oiChg5.toFixed(1)}%`);
    } else if (priceUp && oiDown) {
      label = FLOW.COVER;
      reasons.push(`price up ${m.priceMoveAtr.toFixed(1)} ATR while open interest fell ${Math.abs(m.oiChg5).toFixed(1)}%`);
    } else if (priceDown && oiDown) {
      label = FLOW.LIQ;
      reasons.push(`price down ${Math.abs(m.priceMoveAtr).toFixed(1)} ATR while open interest fell ${Math.abs(m.oiChg5).toFixed(1)}%`);
    }
  }
  if (m.fundingExtreme) reasons.push(`funding is extreme (${(m.funding * 100).toFixed(3)}%)`);
  if (m.lsChg5 !== null && Math.abs(m.lsChg5) >= 5) reasons.push(`long/short account ratio changed ${m.lsChg5.toFixed(1)}%`);
  return { label, kind: "INFERRED", reasons, missing, accumScore: aScore, distScore: dScore, note: "An interpretation of public data. It is not proof of whale activity and shows no positions, entries or PnL." };
}

// Derived derivative metrics for one timeframe from the scanner's extended data.
export function derivMetrics(ext, closed, f, cfg = REV_DEFAULTS) {
  const n = closed.length;
  const atr = f.atr;
  const out = { available: false, oiChg1: null, oiChg5: null, oiSeries: null, takerRatio: null, takerSeries: null, lsRatio: null, lsChg5: null, lsSeries: null, funding: null, fundingPrev: null, fundingChg: null, fundingExtreme: false, errors: [] };
  if (!ext) {
    out.errors.push("derivatives not loaded");
    return out;
  }
  out.errors = ext.errors || [];
  if (ext.oi && ext.oi.length >= 2) {
    const v = ext.oi.map((x) => x.v).filter(isNum);
    if (v.length >= 2) {
      out.oiChg1 = pctChange(v[v.length - 1], v[v.length - 2]);
      out.oiChg5 = v.length >= 6 ? pctChange(v[v.length - 1], v[v.length - 6]) : null;
      out.oiSeries = v;
    }
  }
  if (ext.taker && ext.taker.length) {
    const r = ext.taker.slice(-3).map((x) => x.ratio).filter(isNum);
    if (r.length) out.takerRatio = r.reduce((a, b) => a + b, 0) / r.length;
    out.takerSeries = ext.taker.map((x) => x.ratio).filter(isNum);
  }
  if (ext.ls && ext.ls.length) {
    const r = ext.ls.map((x) => x.ratio).filter(isNum);
    if (r.length) {
      out.lsRatio = r[r.length - 1];
      out.lsChg5 = r.length >= 6 ? pctChange(r[r.length - 1], r[r.length - 6]) : null;
      out.lsSeries = r;
    }
  }
  if (ext.funding && ext.funding.length) {
    const r = ext.funding.map((x) => x.rate).filter(isNum);
    if (r.length) {
      out.funding = r[r.length - 1];
      out.fundingPrev = r.length >= 2 ? r[r.length - 2] : null;
      out.fundingChg = out.fundingPrev !== null ? out.funding - out.fundingPrev : null;
      out.fundingExtreme = Math.abs(out.funding) >= cfg.fundExt;
    }
  }
  out.available = out.oiChg5 !== null || out.takerRatio !== null || out.funding !== null || out.lsChg5 !== null;
  return out;
}

// ------------------------------------------------------------ per-timeframe analysis

function crossUp(a, b, i, bars) {
  // series a crossed above series b within the last `bars` candles ending at i
  for (let j = i - bars + 1; j <= i; j++) {
    if (j < 1) continue;
    if (isNum(a[j]) && isNum(b[j]) && isNum(a[j - 1]) && isNum(b[j - 1]) && a[j - 1] <= b[j - 1] && a[j] > b[j]) return i - j;
  }
  return null;
}
function crossDown(a, b, i, bars) {
  for (let j = i - bars + 1; j <= i; j++) {
    if (j < 1) continue;
    if (isNum(a[j]) && isNum(b[j]) && isNum(a[j - 1]) && isNum(b[j - 1]) && a[j - 1] >= b[j - 1] && a[j] < b[j]) return i - j;
  }
  return null;
}

export function analyzeTimeframe(f, ctx, cfgIn = {}) {
  const cfg = { ...REV_DEFAULTS, ...cfgIn, weights: { ...REV_DEFAULTS.weights, ...(cfgIn.weights || {}) } };
  const W = cfg.weights;
  const tf = f.tf;
  const closed = f.closed;
  const n = closed.length;
  const c = closed.map((x) => x.c), h = closed.map((x) => x.h), l = closed.map((x) => x.l);
  const i = n - 1;
  const atr = f.atr;
  const rsi = rsiSeries(c, cfg.rsiPeriod);
  const ema20 = emaSeries(c, 20), ema50 = emaSeries(c, 50), ema200 = emaSeries(c, 200);
  const mc = macdSeries(c);
  const price = ctx.price;

  const div = detectDivergence(closed, rsi, f.pivots, cfg);
  const shift = detectStructureShift(f, cfg);
  const falseBo = detectFalseBreakout(f, cfg);
  const brk = detectBreakouts(f, cfg, price);
  const react = detectSrReaction(f);
  const spikes = volumeSpikes(closed, 3);
  const tShare = takerShare(closed, 3);
  const dm = derivMetrics(ctx.deriv, closed, f, cfg);

  // movement in ATR units
  const move5 = n > 6 ? (c[i] - c[i - 5]) / atr : 0;
  const hi30 = Math.max(...h.slice(-30)), lo30 = Math.min(...l.slice(-30));
  const drop30 = (hi30 - c[i]) / atr, rise30 = (c[i] - lo30) / atr;
  const lastRange = (h[i] - l[i]) / atr;

  // EMA / MACD events
  const ev = {
    reclaim20Up: crossUp(c, ema20, i, 3), reclaim20Dn: crossDown(c, ema20, i, 3),
    reclaim50Up: crossUp(c, ema50, i, 3), reclaim50Dn: crossDown(c, ema50, i, 3),
    reclaim200Up: crossUp(c, ema200, i, 3), reclaim200Dn: crossDown(c, ema200, i, 3),
    cross2050Up: crossUp(ema20, ema50, i, 5), cross2050Dn: crossDown(ema20, ema50, i, 5),
    slopeUp: isNum(ema20[i]) && isNum(ema20[i - 3]) && isNum(ema20[i - 6]) && ema20[i] > ema20[i - 3] && ema20[i - 3] <= ema20[i - 6],
    slopeDn: isNum(ema20[i]) && isNum(ema20[i - 3]) && isNum(ema20[i - 6]) && ema20[i] < ema20[i - 3] && ema20[i - 3] >= ema20[i - 6],
    macdFlipUp: null, macdFlipDn: null, macdCrossUp: crossUp(mc.macd, mc.signal, i, 3), macdCrossDn: crossDown(mc.macd, mc.signal, i, 3),
    histRisingNeg: false, histFallingPos: false,
  };
  for (let j = i - 2; j <= i; j++) {
    if (j < 1 || !isNum(mc.hist[j]) || !isNum(mc.hist[j - 1])) continue;
    if (mc.hist[j - 1] < 0 && mc.hist[j] > 0) ev.macdFlipUp = i - j;
    if (mc.hist[j - 1] > 0 && mc.hist[j] < 0) ev.macdFlipDn = i - j;
  }
  if (isNum(mc.hist[i]) && isNum(mc.hist[i - 1]) && isNum(mc.hist[i - 2])) {
    ev.histRisingNeg = mc.hist[i] < 0 && mc.hist[i] > mc.hist[i - 1] && mc.hist[i - 1] > mc.hist[i - 2];
    ev.histFallingPos = mc.hist[i] > 0 && mc.hist[i] < mc.hist[i - 1] && mc.hist[i - 1] < mc.hist[i - 2];
  }

  // flow metrics (kline-derived parts exist without the derivative endpoints)
  const zones = f.zones;
  const nearSupport = zones.some((z) => c[i] >= z.lo - atr * 0.5 && c[i] <= z.hi + atr * 0.6 && z.mid < c[i] + atr * 0.3 && z.strength >= 40);
  const nearResistance = zones.some((z) => c[i] <= z.hi + atr * 0.5 && c[i] >= z.lo - atr * 0.6 && z.mid > c[i] - atr * 0.3 && z.strength >= 40);
  const relMax = spikes.length ? Math.max(...spikes.map((s) => s.rel)) : null;
  const flowIn = {
    oiChg5: dm.oiChg5,
    takerRatio: dm.takerRatio,
    takerShareKline: tShare,
    funding: dm.funding,
    fundingExtreme: dm.fundingExtreme,
    lsChg5: dm.lsChg5,
    relVolMax: relMax,
    priceMoveAtr: move5,
    nearSupport, nearResistance,
    afterDecline: drop30 >= 3, afterAdvance: rise30 >= 3,
  };
  const flow = classifyFlow(flowIn, cfg);

  // context: a REVERSAL needs something to reverse
  const structLabel = f.structure.label;
  const ctxBull = structLabel === "BEARISH" || (isNum(ema50[i]) && c[i] < ema50[i]) || drop30 >= 3;
  const ctxBear = structLabel === "BULLISH" || (isNum(ema50[i]) && c[i] > ema50[i]) || rise30 >= 3;

  // ---------------- scoring per direction ----------------
  const build = (dir) => {
    const bull = dir === 1;
    const comps = [];
    const sup = [];
    const add = (key, name, points, max, note, extra = {}) => comps.push({ key, name, points: round1(Math.min(points, max)), max, note, available: true, ...extra });
    const evid = (family, text, kind, confirmed, pts) => sup.push({ family, text, kind, confirmed: !!confirmed, pts });

    // divergence
    {
      const reg = div.find((d) => d.kind === "regular" && d.dir === dir);
      const hid = div.find((d) => d.kind === "hidden" && d.dir === dir);
      let pts = 0, note = "none found";
      if (reg) {
        const f = reg.barsAgo <= 10 ? 1 : reg.barsAgo <= 25 ? 0.8 : 0.6;
        pts = W.div * f;
        note = `regular ${bull ? "bullish" : "bearish"}: price ${bull ? "lower low" : "higher high"} ${reg.p1.toPrecision(6)}→${reg.p2.toPrecision(6)}, RSI ${reg.r1.toFixed(0)}→${reg.r2.toFixed(0)} (${reg.barsAgo} candles ago)`;
        evid("div", note, "DERIVED", false, pts);
      } else if (hid) {
        pts = W.div * 0.27;
        note = `hidden ${bull ? "bullish" : "bearish"} (trend continuation, not a reversal): RSI ${hid.r1.toFixed(0)}→${hid.r2.toFixed(0)}`;
        evid("div", note, "DERIVED", false, pts);
      }
      add("div", "RSI divergence", pts, W.div, note);
    }
    // structure
    {
      const choch = bull ? shift.bullChoch : shift.bearChoch;
      const bos = bull ? shift.bullBos : shift.bearBos;
      let pts = 0, note = "no recent break of a confirmed swing";
      if (choch) {
        pts = W.structure;
        note = `CHOCH: a closed candle took out the ${bull ? "lower high" : "higher low"} at ${choch.level.toPrecision(6)} (${choch.barsAgo} candles ago)`;
        evid("structure", note, "DERIVED", true, pts);
      } else if (bos) {
        pts = W.structure * 0.45;
        note = `BOS (continuation): a closed candle took out the swing ${bull ? "high" : "low"} at ${bos.level.toPrecision(6)}`;
        evid("structure", note, "DERIVED", false, pts);
      } else {
        const ps = bull ? f.pivots.lows : f.pivots.highs;
        if (ps.length >= 2) {
          const a = ps[ps.length - 2].price, b = ps[ps.length - 1].price;
          const early = bull ? b > a * 1.001 && (f.structure.lh || f.structure.label === "BEARISH") : b < a * 0.999 && (f.structure.hl || f.structure.label === "BULLISH");
          if (early) {
            pts = W.structure * 0.35;
            note = bull ? "a higher low formed inside a down structure (early)" : "a lower high formed inside an up structure (early)";
            evid("structure", note, "DERIVED", false, pts);
          }
        }
      }
      add("structure", "Structure shift", pts, W.structure, note);
    }
    // EMA
    {
      let pts = 0;
      const notes = [];
      const r20 = bull ? ev.reclaim20Up : ev.reclaim20Dn;
      const r50 = bull ? ev.reclaim50Up : ev.reclaim50Dn;
      const r200 = bull ? ev.reclaim200Up : ev.reclaim200Dn;
      const x = bull ? ev.cross2050Up : ev.cross2050Dn;
      const sl = bull ? ev.slopeUp : ev.slopeDn;
      if (r20 !== null) { pts += 3; notes.push(`price closed ${bull ? "above" : "below"} EMA20`); }
      if (x !== null) { pts += 4; notes.push(`EMA20 crossed ${bull ? "above" : "below"} EMA50`); }
      if (r50 !== null) { pts += 3; notes.push(`price closed ${bull ? "above" : "below"} EMA50`); }
      if (r200 !== null) { pts += 3; notes.push(`price closed ${bull ? "above" : "below"} EMA200`); }
      if (sl && !notes.length) { pts += 2; notes.push("EMA20 slope turned " + (bull ? "up" : "down")); }
      if (notes.length) evid("ema", notes.join("; "), "DERIVED", x !== null || r50 !== null, pts);
      add("ema", "EMA 20/50/200 shift", pts, W.ema, notes.length ? notes.join("; ") : "no recent EMA reclaim or cross" + (ema200[i] === null ? " (EMA200 UNAVAILABLE: < 200 candles)" : ""));
    }
    // MACD
    {
      let pts = 0;
      const notes = [];
      const fl = bull ? ev.macdFlipUp : ev.macdFlipDn;
      const cx = bull ? ev.macdCrossUp : ev.macdCrossDn;
      const rising = bull ? ev.histRisingNeg : ev.histFallingPos;
      if (fl !== null) { pts += 7; notes.push(`MACD histogram flipped ${bull ? "positive" : "negative"}`); }
      if (cx !== null) { pts += 3; notes.push(`MACD crossed ${bull ? "above" : "below"} its signal`); }
      if (rising && fl === null) { pts += 4; notes.push(`histogram ${bull ? "rising" : "falling"} for 3 candles (early)`); }
      if (notes.length) evid("macd", notes.join("; "), "DERIVED", fl !== null, pts);
      add("macd", "MACD momentum shift", pts, W.macd, notes.length ? notes.join("; ") : "no momentum shift");
    }
    // volume + taker
    {
      let pts = 0;
      const notes = [];
      const sp = spikes.find((s) => s.rel >= cfg.volSpike && (bull ? s.up || closed[s.j].c > (closed[s.j].h + closed[s.j].l) / 2 : !s.up || closed[s.j].c < (closed[s.j].h + closed[s.j].l) / 2));
      if (sp) { pts += 5; notes.push(`volume spike ${sp.rel.toFixed(1)}× on a ${bull ? "bullish" : "bearish"}-leaning candle`); }
      const share = tShare;
      if (share !== null && (bull ? share >= 0.54 : share <= 0.46)) { pts += 5; notes.push(`taker ${bull ? "buy" : "sell"} share ${(100 * (bull ? share : 1 - share)).toFixed(0)}% (kline field)`); }
      if (notes.length) evid("volume", notes.join("; "), "OFFICIAL", false, pts);
      const unavailable = share === null && !spikes.length;
      comps.push({ key: "volume", name: "Volume & taker pressure", points: round1(Math.min(pts, W.volume)), max: W.volume, available: !unavailable, note: notes.length ? notes.join("; ") : unavailable ? "UNAVAILABLE — no volume baseline / taker field" : "no unusual volume or one-sided taker flow" });
    }
    // support/resistance reaction + failed breakout
    {
      const rej = react.find((r) => r.dir === dir);
      const trap = falseBo.find((t) => t.dir === dir);
      let pts = 0, note = "no reaction at a confirmed zone";
      if (trap) {
        pts = W.sr;
        note = `${bull ? "bear trap" : "bull trap"}: ${trap.kind === "wick" ? "a wick pierced" : "a close broke"} the zone ${trap.zone.lo.toPrecision(6)}–${trap.zone.hi.toPrecision(6)} and price returned (${trap.barsAgo} candles ago)`;
        evid("sr", note, "DERIVED", false, pts);
      } else if (rej) {
        pts = W.sr * 0.67;
        note = `${bull ? "bullish" : "bearish"} wick rejection at ${bull ? "support" : "resistance"} ${rej.zone.lo.toPrecision(6)}–${rej.zone.hi.toPrecision(6)}`;
        evid("sr", note, "DERIVED", false, pts);
      }
      add("sr", "S/R reaction / failed breakout", pts, W.sr, note);
    }
    // flow
    {
      if (!dm.available && tShare === null) {
        comps.push({ key: "flow", name: "OI / funding / ratio flow", points: 0, max: W.flow, available: false, note: "UNAVAILABLE — derivative data not loaded or failed" + (dm.errors.length ? ` (${dm.errors.join("; ")})` : "") });
      } else if (!dm.available) {
        comps.push({ key: "flow", name: "OI / funding / ratio flow", points: 0, max: W.flow, available: false, note: "UNAVAILABLE — open interest, funding and ratios not loaded" + (dm.errors.length ? ` (${dm.errors.join("; ")})` : "") });
      } else {
        let pts = 0;
        const notes = [];
        const lab = flow.label;
        if (bull) {
          if (lab === FLOW.ACCUM) pts += 10;
          else if (lab === FLOW.LONGS) pts += 6;
          else if (lab === FLOW.COVER) pts += 5;
          if (dm.funding !== null && dm.funding <= -cfg.fundExt) { pts += 2; notes.push("funding very negative (shorts are paying — crowded shorts)"); }
        } else {
          if (lab === FLOW.DISTRIB) pts += 10;
          else if (lab === FLOW.SHORTS) pts += 6;
          else if (lab === FLOW.LIQ) pts += 5;
          if (dm.funding !== null && dm.funding >= cfg.fundExt) { pts += 2; notes.push("funding very positive (longs are paying — crowded longs)"); }
        }
        if (pts > 0) notes.unshift(`${lab}: ${flow.reasons.join("; ")}`);
        if (notes.length) evid("flow", notes.join("; "), "INFERRED", false, pts);
        comps.push({ key: "flow", name: "OI / funding / ratio flow", points: round1(Math.min(pts, W.flow)), max: W.flow, available: true, note: notes.length ? notes.join("; ") : `${lab} — nothing supports this direction` });
      }
    }
    return { dir, comps, sup };
  };

  const B = build(1), S = build(-1);
  const coreSum = (x) => x.comps.reduce((a, c) => a + c.points, 0);
  const flags = [];
  if (ema200[i] === null || ema200[i] === undefined) flags.push("EMA200 UNAVAILABLE");
  if (tShare === null) flags.push("TAKER FIELD UNAVAILABLE");
  if (!dm.available) flags.push("OI/FUNDING/RATIO UNAVAILABLE");

  // chart payload (aligned slices)
  const N = 90;
  const start = Math.max(0, n - N);
  const chart = {
    tf,
    candles: closed.slice(start).map((x) => ({ t: x.t, o: x.o, h: x.h, l: x.l, c: x.c })),
    forming: f.forming ? { t: f.forming.t, o: f.forming.o, h: f.forming.h, l: f.forming.l, c: f.forming.c } : null,
    ema20: ema20.slice(start), ema50: ema50.slice(start), ema200: ema200.slice(start),
    zones: zones.filter((z) => z.strength >= 35).map((z) => ({ lo: z.lo, hi: z.hi, strength: z.strength })),
    divergences: div.filter((d) => d.i1 >= start).map((d) => ({ kind: d.kind, dir: d.dir, i1: d.i1 - start, i2: d.i2 - start, p1: d.p1, p2: d.p2 })),
    shifts: [shift.bullChoch && { t: "CHOCH ↑", j: shift.bullChoch.j - start, level: shift.bullChoch.level }, shift.bearChoch && { t: "CHOCH ↓", j: shift.bearChoch.j - start, level: shift.bearChoch.level }, shift.bullBos && { t: "BOS ↑", j: shift.bullBos.j - start, level: shift.bullBos.level }, shift.bearBos && { t: "BOS ↓", j: shift.bearBos.j - start, level: shift.bearBos.level }].filter(Boolean),
    breakLevels: [brk.up && { label: brk.up.status === "CONFIRMED" ? "Breakout level" : "Resistance", level: brk.up.level, dir: 1 }, brk.down && { label: brk.down.status === "CONFIRMED" ? "Breakdown level" : "Support", level: brk.down.level, dir: -1 }].filter(Boolean),
  };

  // invalidation: beyond the structure that would prove the idea wrong
  const sLow = f.lastSwingLow ? f.lastSwingLow.price : lo30;
  const sHigh = f.lastSwingHigh ? f.lastSwingHigh.price : hi30;
  const recentLow = Math.min(...l.slice(-12)), recentHigh = Math.max(...h.slice(-12));
  const invBull = Math.min(sLow, recentLow) - atr * 0.25;
  const invBear = Math.max(sHigh, recentHigh) + atr * 0.25;

  return {
    tf, ok: true, n, atr, atrPct: (atr / c[i]) * 100, lastClosed: closed[i].t, lastClosedAt: closed[i].ct,
    structure: structLabel, price, closePrice: c[i],
    detections: { div, shift, falseBo, brk, react, spikes, takerShare: tShare, events: ev },
    deriv: dm, flow, flags,
    ctx: { bull: ctxBull, bear: ctxBear, drop30, rise30, move5, nearSupport, nearResistance, lastRange },
    core: { bull: B, bear: S, bullPts: coreSum(B), bearPts: coreSum(S) },
    invalidation: { bull: invBull, bear: invBear },
    rsi: rsi[i], macdHist: mc.hist[i],
    chart,
  };
}

// ------------------------------------------------------------ states & scoring

function maxAvailable(comps, agreeMax) {
  return comps.filter((c) => c.available !== false).reduce((a, c) => a + c.max, 0) + agreeMax;
}

// settings: REV_DEFAULTS overrides. frames: { "5m","15m","1h","4h" } from analyzeFrame.
// live:   { ticker:{lastPrice, priceChangePercent, quoteVolume} }
// derivByTf: { tf: extendedDerivData | undefined }
// ages:   { tf: behindMs, ticker: ms }
export function evaluateReversal({ symbol, frames, live, derivByTf = {}, ages = {}, settings: user, now }) {
  const cfg = { ...REV_DEFAULTS, ...(user || {}), weights: { ...REV_DEFAULTS.weights, ...((user && user.weights) || {}) } };
  const tk = live && live.ticker;
  const price = tk ? parseFloat(tk.lastPrice) : NaN;
  const quoteVolume = tk ? parseFloat(tk.quoteVolume) : NaN;
  const res = { symbol, price: isNum(price) ? price : null, change24h: tk ? parseFloat(tk.priceChangePercent) : null, quoteVolume: isNum(quoteVolume) ? quoteVolume : null, evaluatedAt: now, byTf: {}, cfg };
  const priceOk = isNum(price) && price > 0;

  // pass 1: raw analysis per timeframe
  const raw = {};
  for (const tf of REV_TFS) {
    const f = frames[tf];
    const age = ages[tf] ?? 0;
    const tickerAge = ages.ticker ?? 0;
    if (!priceOk) {
      raw[tf] = { tf, ok: false, state: REV_STATE.INSUFFICIENT, reason: "No valid price" };
    } else if (!f) {
      raw[tf] = { tf, ok: false, state: REV_STATE.INSUFFICIENT, reason: `${tf} candles not loaded` };
    } else if (!f.ok || f.n < 60) {
      raw[tf] = { tf, ok: false, state: REV_STATE.INSUFFICIENT, reason: `Only ${f.n} closed ${tf} candles (need ≥ 60)` };
    } else if (Math.max(age, tickerAge) > cfg.deadMs) {
      raw[tf] = { tf, ok: false, state: REV_STATE.INSUFFICIENT, reason: `Data is ${Math.round(Math.max(age, tickerAge) / 60000)} min old` };
    } else {
      const a = analyzeTimeframe(f, { price, deriv: derivByTf[tf] || null }, cfg);
      a.ageMs = Math.max(age, tickerAge);
      a.stale = a.ageMs > cfg.staleMs;
      raw[tf] = a;
    }
  }

  // pass 2: agreement, penalties, states
  for (const tf of REV_TFS) {
    const a = raw[tf];
    if (!a.ok) {
      res.byTf[tf] = a;
      continue;
    }
    const others = REV_TFS.filter((t) => t !== tf && raw[t].ok);
    const wSum = others.reduce((s, t) => s + TF_WEIGHT[t], 0);
    const finalize = (dir) => {
      const mine = dir === 1 ? a.core.bull : a.core.bear;
      const myPts = dir === 1 ? a.core.bullPts : a.core.bearPts;
      let agreeW = 0;
      const agreeTfs = [], conflictTfs = [];
      others.forEach((t) => {
        const o = raw[t];
        const oMine = dir === 1 ? o.core.bullPts : o.core.bearPts;
        const oOpp = dir === 1 ? o.core.bearPts : o.core.bullPts;
        if (oMine >= 20 && oMine > oOpp + 5) {
          agreeW += TF_WEIGHT[t];
          agreeTfs.push(t);
        } else if (oOpp >= 20 && oOpp > oMine + 5) conflictTfs.push(t);
      });
      const agreePts = wSum > 0 ? cfg.weights.agree * (agreeW / wSum) : 0;
      const comps = [...mine.comps, { key: "agree", name: "Timeframe agreement", points: round1(agreePts), max: cfg.weights.agree, available: wSum > 0, note: wSum > 0 ? `agrees: ${agreeTfs.join(", ") || "none"}${conflictTfs.length ? " · conflicts: " + conflictTfs.join(", ") : ""}` : "UNAVAILABLE — other timeframes not loaded" }];
      const pen = [];
      if (a.stale) pen.push({ name: "Stale data", points: 10, note: `${Math.round(a.ageMs / 60000)} min behind` });
      if (res.quoteVolume !== null && res.quoteVolume < cfg.minQuoteVol) pen.push({ name: "Low liquidity", points: 8, note: `24h volume ${(res.quoteVolume / 1e6).toFixed(1)}M` });
      const f4 = raw["4h"];
      if (tf !== "4h" && f4 && f4.ok) {
        const opp4 = dir === 1 ? f4.core.bearPts : f4.core.bullPts;
        const my4 = dir === 1 ? f4.core.bullPts : f4.core.bearPts;
        if (opp4 >= 25 && opp4 > my4 + 8) pen.push({ name: "Opposing 4H evidence", points: 6, note: `4H shows ${dir === 1 ? "bearish" : "bullish"} evidence` });
      }
      if (a.atrPct >= cfg.highVolPct) pen.push({ name: "Extreme volatility", points: 4, note: `ATR ${a.atrPct.toFixed(1)}% of price` });
      const sum = comps.reduce((s, c) => s + c.points, 0) - pen.reduce((s, p) => s + p.points, 0);
      const score = Math.round(clamp(sum, 0, 100));
      const maxAvail = maxAvailable(comps, 0) + 0;
      return { dir, score, comps, penalties: pen, supporting: mine.sup, agreeTfs, conflictTfs, maxPossible: Math.round(maxAvail) };
    };
    const bull = finalize(1), bear = finalize(-1);
    // conflicting evidence = what the other side has, plus penalties
    bull.conflicting = [...bear.supporting.map((e) => ({ ...e, text: "Bearish: " + e.text })), ...bull.penalties.map((p) => ({ family: "penalty", text: `${p.name}: ${p.note}`, kind: "DERIVED" }))];
    bear.conflicting = [...bull.supporting.map((e) => ({ ...e, text: "Bullish: " + e.text })), ...bear.penalties.map((p) => ({ family: "penalty", text: `${p.name}: ${p.note}`, kind: "DERIVED" }))];

    // ---- reversal status per direction ----
    const status = (side, opp) => {
      const dir = side.dir;
      const shift = dir === 1 ? a.detections.shift.bullChoch : a.detections.shift.bearChoch;
      const ev = a.detections.events;
      const second = dir === 1 ? ev.cross2050Up !== null || ev.reclaim50Up !== null || ev.reclaim20Up !== null || ev.macdFlipUp !== null : ev.cross2050Dn !== null || ev.reclaim50Dn !== null || ev.reclaim20Dn !== null || ev.macdFlipDn !== null;
      const volOk = a.detections.spikes.some((s) => s.rel >= 1.0) || (a.detections.takerShare !== null && (dir === 1 ? a.detections.takerShare >= 0.5 : a.detections.takerShare <= 0.5));
      const context = dir === 1 ? a.ctx.bull : a.ctx.bear;
      const families = new Set(side.supporting.map((e) => e.family));
      const separated = side.score - opp.score >= cfg.conflictMargin;
      if (!context) return { kind: null, why: "no prior move to reverse" };
      if (shift && second && volOk && side.score >= cfg.confirmMin && separated) return { kind: "confirmed", why: "closed-candle CHOCH + a second confirmation + volume, and clearly ahead of the opposite side" };
      if (side.score >= cfg.earlyMin && families.size >= 2) return { kind: "early", why: shift ? "structure shifted but confirmation is incomplete" : "early warning — no closed-candle structure break yet" };
      return { kind: null, why: "not enough independent evidence" };
    };
    const sBull = status(bull, bear), sBear = status(bear, bull);
    bull.status = sBull;
    bear.status = sBear;

    // ---- final state for this timeframe ----
    const brk = a.detections.brk;
    const fb = a.detections.falseBo;
    const reasons = [];
    let state = REV_STATE.NONE;
    let dir = 0;
    const conflicting = bull.score >= cfg.earlyMin && bear.score >= cfg.earlyMin && Math.abs(bull.score - bear.score) < cfg.conflictMargin;
    if (a.stale) {
      state = REV_STATE.STALE;
      reasons.push("Market data is older than the stale limit — no signal is issued.");
    } else if (sBull.kind === "confirmed" && !conflicting && bull.score >= bear.score) {
      state = REV_STATE.BULL_CONF; dir = 1;
    } else if (sBear.kind === "confirmed" && !conflicting && bear.score > bull.score) {
      state = REV_STATE.BEAR_CONF; dir = -1;
    } else if (brk.up && brk.up.status === "CONFIRMED" && brk.up.volOk && brk.up.retest !== "failed" && (!brk.down || brk.down.status !== "CONFIRMED")) {
      state = REV_STATE.BREAKOUT; dir = 1;
    } else if (brk.down && brk.down.status === "CONFIRMED" && brk.down.volOk && brk.down.retest !== "failed") {
      state = REV_STATE.BREAKDOWN; dir = -1;
    } else if (!conflicting && sBull.kind === "early" && bull.score > bear.score) {
      state = REV_STATE.EARLY_BULL; dir = 1;
    } else if (!conflicting && sBear.kind === "early" && bear.score > bull.score) {
      state = REV_STATE.EARLY_BEAR; dir = -1;
    } else if (brk.up && brk.up.status === "CONFIRMED" && !brk.up.volOk) {
      state = REV_STATE.FALSE_RISK; dir = 1;
      reasons.push("Breakout closed beyond resistance but volume is below the threshold — higher false-breakout risk.");
    } else if (brk.down && brk.down.status === "CONFIRMED" && !brk.down.volOk) {
      state = REV_STATE.FALSE_RISK; dir = -1;
      reasons.push("Breakdown closed below support but volume is below the threshold — higher false-breakout risk.");
    } else if (fb.length && fb[0].barsAgo <= 3) {
      state = REV_STATE.FALSE_RISK; dir = fb[0].dir;
      reasons.push(`${fb[0].dir === 1 ? "A breakdown" : "A breakout"} failed ${fb[0].barsAgo} candle(s) ago — trapped traders can move price the other way.`);
    } else if (brk.up && brk.up.status === "POTENTIAL" && !(brk.down && brk.down.status === "POTENTIAL" && brk.down.relVol > (brk.up.relVol || 0))) {
      state = REV_STATE.POT_BREAKOUT; dir = 1;
    } else if (brk.down && brk.down.status === "POTENTIAL") {
      state = REV_STATE.POT_BREAKDOWN; dir = -1;
    } else {
      state = REV_STATE.NONE;
      reasons.push(conflicting ? `Bullish ${bull.score} and bearish ${bear.score} evidence are too close — conflicting.` : "No reversal, breakout or breakdown evidence strong enough.");
    }
    // every condition that is currently true (the headline `state` is the most important one)
    const signals = [];
    if (!a.stale) {
      if (sBull.kind) signals.push({ state: sBull.kind === "confirmed" ? REV_STATE.BULL_CONF : REV_STATE.EARLY_BULL, dir: 1 });
      if (sBear.kind) signals.push({ state: sBear.kind === "confirmed" ? REV_STATE.BEAR_CONF : REV_STATE.EARLY_BEAR, dir: -1 });
      if (brk.up) signals.push({ state: brk.up.status === "CONFIRMED" ? (brk.up.volOk ? REV_STATE.BREAKOUT : REV_STATE.FALSE_RISK) : REV_STATE.POT_BREAKOUT, dir: 1 });
      if (brk.down) signals.push({ state: brk.down.status === "CONFIRMED" ? (brk.down.volOk ? REV_STATE.BREAKDOWN : REV_STATE.FALSE_RISK) : REV_STATE.POT_BREAKDOWN, dir: -1 });
      if (fb.length && fb[0].barsAgo <= 3) signals.push({ state: REV_STATE.FALSE_RISK, dir: fb[0].dir });
    }
    const prov = (state === REV_STATE.POT_BREAKOUT && brk.up && brk.up.provisional) || (state === REV_STATE.POT_BREAKDOWN && brk.down && brk.down.provisional);

    res.byTf[tf] = {
      ...a,
      state,
      dir,
      signals,
      reasons,
      conflicting,
      provisional: !!prov,
      bull,
      bear,
      invalidationLevel: dir === 1 ? a.invalidation.bull : dir === -1 ? a.invalidation.bear : null,
      breakout: brk,
    };
    delete res.byTf[tf].core;
  }
  // best timeframe = the most important actionable state, then highest score
  const rank = (s) => ({ [REV_STATE.BULL_CONF]: 9, [REV_STATE.BEAR_CONF]: 9, [REV_STATE.BREAKOUT]: 7, [REV_STATE.BREAKDOWN]: 7, [REV_STATE.EARLY_BULL]: 6, [REV_STATE.EARLY_BEAR]: 6, [REV_STATE.POT_BREAKOUT]: 4, [REV_STATE.POT_BREAKDOWN]: 4, [REV_STATE.FALSE_RISK]: 3, [REV_STATE.NONE]: 1 }[s] || 0);
  let best = null;
  for (const tf of REV_TFS) {
    const t = res.byTf[tf];
    if (!t || !t.ok) continue;
    const sc = Math.max(t.bull.score, t.bear.score);
    const key = rank(t.state) * 1000 + sc * 10 + TF_WEIGHT[tf];
    if (!best || key > best.key) best = { tf, key };
  }
  res.bestTf = best ? best.tf : null;
  return res;
}

// ------------------------------------------------------------ signal history

// Records a signal only when the state for (symbol, timeframe) CHANGES, so one
// condition never produces a stream of identical entries.
export function createSignalLog(limit = 200) {
  const last = new Map();
  const entries = [];
  const actionable = (s) => s !== REV_STATE.NONE && s !== REV_STATE.INSUFFICIENT && s !== REV_STATE.STALE;
  return {
    entries,
    record({ symbol, tf, state, dir, bull, bear, price, candleTime, at }) {
      const key = `${symbol}|${tf}`;
      const prev = last.get(key);
      if (prev === state) return null;
      last.set(key, state);
      if (!actionable(state)) return null;
      const e = { id: `${key}|${state}|${candleTime}`, at, candleTime, symbol, tf, state, dir, bull, bear, price };
      if (entries.some((x) => x.id === e.id)) return null;
      entries.unshift(e);
      if (entries.length > limit) entries.length = limit;
      return e;
    },
    load(list) {
      entries.length = 0;
      (Array.isArray(list) ? list : []).slice(0, limit).forEach((e) => e && e.id && entries.push(e));
      entries.forEach((e) => !last.has(`${e.symbol}|${e.tf}`) && last.set(`${e.symbol}|${e.tf}`, e.state));
    },
    clear() {
      entries.length = 0;
      last.clear();
    },
  };
}

export { analyzeFrame, TF_MS };
