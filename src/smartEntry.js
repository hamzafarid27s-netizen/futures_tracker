// Smart Entry Zone engine — pure functions, no network, no React.
//
// Builds on the Entry Radar primitives (entryRadar.js): closed-candle frames,
// confirmed pivots, ATR/EMA/RSI, 4H trend, net R:R. Everything here is
// DERIVED from public Binance candles; nothing is a prediction, a win
// probability, or "smart money" data.
//
// FORMULAS / ASSUMPTIONS (also shown in the UI "How it works"):
//   * Only CLOSED candles feed levels, zones and triggers. A swing is
//     confirmed only after k candles exist on its right (k=3 on 1H) — no
//     look-ahead. The forming candle is used only for the live price and for
//     a clearly marked PROVISIONAL read.
//   * Candidate levels (each tagged with a "family"):
//       sr      clustered confirmed swing highs/lows (also covers raw swings)
//       retest  a broken S/R zone that held after a volume-confirmed close
//       sd      supply/demand: a small base candle followed by an impulse
//               (>= 1.5 ATR body, or >= 2 ATR net move in 3 candles) that
//               has not been closed through since
//       ema     1H EMA20 / EMA50 / EMA200 (+ 4H EMA50)
//       fib     0.382 / 0.5 / 0.618 retracement of the latest confirmed
//               swing leg (>= 2 ATR tall)
//       vwap    VWAP anchored at the leg's confirmed swing low (long) / high
//               (short): sum((H+L+C)/3 * baseVolume) / sum(baseVolume) over
//               closed 1H candles from the anchor candle to the last close
//   * Levels are clustered when the gap between them is <= 0.35 x 1H ATR.
//     Confluence counts each family ONCE (EMA20/50/200 are one family, the
//     three fib ratios are one family) so correlated levels are not counted as
//     independent evidence. A zone needs >= 2 independent families, or one
//     strong structural zone (>= 3 touches), otherwise: NO VALID ZONE.
//   * Zone = union of the member ranges padded by 0.1 ATR, width clamped to
//     [0.3, 1.6] ATR. Preferred entry = the price inside the zone where most
//     member levels overlap (ties -> nearest to current price).
//   * Invalidation = beyond the zone / confirmed swing that protects it;
//     stop = invalidation -/+ 0.25 ATR (and at least 0.8 ATR from entry).
//   * Targets = confirmed opposing structure (>= 0.8 ATR from entry, spaced
//     >= 0.8 ATR), then explicit risk multiples (1.5R / 2.5R / 4R).
//   * R:R is NET: reward - round-trip (fees + slippage), risk + the same cost.
//   * Position size = (account x risk%) / (stop distance + cost per unit).
//     Leverage only changes margin and liquidation distance, never the price
//     distance to the stop. A stop order may fill worse than its price.
//   * Score (0-100, heuristic ranking — NOT a win probability):
//       trend 20 + confluence 20 + level quality 15 + volume/momentum 15
//       + volatility suitability 10 + net R:R 20, minus penalties
//       (stale, conflicting timeframes, low liquidity, wide spread,
//       nearby opposing level, poor R:R).

import {
  DEFAULT_SETTINGS,
  TF_MS,
  trendFromFrame,
  detectBreak,
  rrNet,
  costPerUnit,
  triggerFrom15m,
  countGaps,
} from "./entryRadar.js";

export const SMART_STATUS = {
  WAIT_ZONE: "WAIT FOR ZONE",
  IN_ZONE: "IN ZONE — WAIT FOR CONFIRMATION",
  LONG_TRIGGERED: "LONG TRIGGERED",
  SHORT_TRIGGERED: "SHORT TRIGGERED",
  MISSED: "MISSED ENTRY",
  INVALIDATED: "INVALIDATED",
  NO_TRADE: "NO TRADE",
  STALE: "DATA STALE",
};
export const NO_VALID_ZONE = "NO VALID ZONE";

export const SMART_DEFAULTS = {
  ...DEFAULT_SETTINGS,
  clusterAtr: 0.35, // level clustering distance, x 1H ATR
  zonePadAtr: 0.1,
  minZoneAtr: 0.3,
  maxZoneAtr: 1.6,
  maxZoneDistAtr: 6, // a zone further than this from price is not "actionable"
  stopAtrBuffer: 0.25,
  minStopAtr: 0.8,
  maxStopAtr: 5,
  minRR: 1.0, // net R:R (TP2) below this -> NO TRADE
  illiquidFactor: 0.2, // 24h volume below minQuoteVol x this -> NO TRADE
  touchLookback15m: 32, // closed 15m candles in which a zone touch counts as "recent"
  mmrPct: 0.5, // assumed maintenance margin rate for the ROUGH liquidation estimate
  account: 1000,
  riskPct: 1,
  leverage: 10,
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

// ------------------------------------------------------------ level collection

// Supply/demand zones inferred from candle structure (confirmed only: the
// impulse must be complete and the zone must still be unmitigated).
export function findSupplyDemand(closed, atr) {
  const out = { demand: [], supply: [] };
  const n = closed.length;
  if (!(atr > 0) || n < 20) return out;
  for (let i = Math.max(1, n - 120); i < n - 3; i++) {
    const b = closed[i];
    const range = b.h - b.l;
    const body = Math.abs(b.c - b.o);
    if (!(range > 0) || body > range * 0.55 || range > atr * 1.2) continue; // base candle: smallish, indecisive
    const imp = closed[i + 1];
    const up1 = imp.c - imp.o >= atr * 1.5;
    const dn1 = imp.o - imp.c >= atr * 1.5;
    const net3 = closed[i + 3].c - b.c;
    const up = up1 || net3 >= atr * 2;
    const dn = dn1 || -net3 >= atr * 2;
    if (up && !dn) {
      const lo = b.l, hi = Math.max(b.o, b.c);
      const mitigated = closed.slice(i + 2).some((x) => x.c < lo);
      if (!mitigated) out.demand.push({ lo, hi, idx: i });
    } else if (dn && !up) {
      const lo = Math.min(b.o, b.c), hi = b.h;
      const mitigated = closed.slice(i + 2).some((x) => x.c > hi);
      if (!mitigated) out.supply.push({ lo, hi, idx: i });
    }
  }
  out.demand = out.demand.slice(-3);
  out.supply = out.supply.slice(-3);
  return out;
}

// Latest confirmed swing LEG for fib/VWAP anchoring.
// side +1: a swing low followed by a later swing high (up-leg).
// side -1: a swing high followed by a later swing low (down-leg).
export function latestLeg(f, side, minAtr = 2) {
  const { pivots, atr } = f;
  if (!pivots || !(atr > 0)) return null;
  const A = side === 1 ? pivots.lows : pivots.highs; // anchor
  const B = side === 1 ? pivots.highs : pivots.lows; // extreme
  for (let b = B.length - 1; b >= 0; b--) {
    const ext = B[b];
    const anchors = A.filter((a) => a.i < ext.i);
    if (!anchors.length) continue;
    const anc = anchors[anchors.length - 1];
    const size = Math.abs(ext.price - anc.price);
    if (size >= atr * minAtr) return { anchor: anc, extreme: ext, size };
    // too small a leg: keep looking only at the very latest extreme
    if (b === B.length - 1) continue;
    break;
  }
  return null;
}

export function anchoredVwap(closed, anchorIdx) {
  let pv = 0, v = 0;
  for (let i = anchorIdx; i < closed.length; i++) {
    const c = closed[i];
    const vol = c.v;
    if (!(vol > 0)) continue;
    pv += ((c.h + c.l + c.c) / 3) * vol;
    v += vol;
  }
  return v > 0 && closed.length - anchorIdx >= 8 ? pv / v : null;
}

// All candidate levels for one side, with families. `side` +1 long (support
// side), -1 short (resistance side). Levels on the wrong side of price are
// dropped later in clustering.
export function collectLevels(side, ctx) {
  const { f1, f4, price } = ctx;
  const atr = f1.atr;
  const levels = [];
  const add = (lo, hi, family, source, weight, extra = {}) => {
    if (!isNum(lo) || !isNum(hi) || lo <= 0) return;
    levels.push({ lo: Math.min(lo, hi), hi: Math.max(lo, hi), family, source, weight, ...extra });
  };
  const brk = detectBreak(f1, side);
  for (const z of f1.zones) {
    const isRetest = brk && brk.zone === z;
    if (isRetest) continue; // the retest family supersedes the same zone (not double counted)
    add(z.lo, z.hi, "sr", `${side === 1 ? "Support" : "Resistance"} zone — ${z.touches} touch${z.touches === 1 ? "" : "es"}`, 2 + z.strength / 50, { touches: z.touches, strength: z.strength, historical: true });
  }
  if (brk) {
    add(brk.zone.lo, brk.zone.hi, "retest", `Broken ${side === 1 ? "resistance" : "support"} (retest${brk.retested ? " held" : " pending"}${brk.volOk ? ", volume-confirmed" : ""})`, 3 + (brk.volOk ? 1 : 0), { touches: brk.zone.touches, strength: brk.zone.strength, retested: brk.retested, volOk: brk.volOk, historical: true });
  }
  const sd = findSupplyDemand(f1.closed, atr);
  for (const z of side === 1 ? sd.demand : sd.supply) add(z.lo, z.hi, "sd", side === 1 ? "Demand zone (base before impulse, unmitigated)" : "Supply zone (base before impulse, unmitigated)", 2, { historical: true });
  const pt = (p, name, w) => isNum(p) && add(p, p, "ema", name, w);
  pt(f1.ema20, "1H EMA20", 1.5);
  pt(f1.ema50, "1H EMA50", 2);
  pt(f1.ema200, "1H EMA200", 2);
  if (f4 && f4.ok) pt(f4.ema50, "4H EMA50", 2);
  const leg = latestLeg(f1, side);
  if (leg) {
    const { anchor, extreme } = leg;
    for (const r of [0.382, 0.5, 0.618]) {
      const p = side === 1 ? extreme.price - r * (extreme.price - anchor.price) : extreme.price + r * (anchor.price - extreme.price);
      add(p, p, "fib", `Fib ${r} of confirmed 1H swing ${anchor.price}→${extreme.price}`, 1.5, { fib: r });
    }
    const vw = anchoredVwap(f1.closed, anchor.i);
    if (isNum(vw)) add(vw, vw, "vwap", `VWAP anchored at confirmed 1H swing ${side === 1 ? "low" : "high"} (${anchor.price})`, 1.5);
  }
  return { levels, leg, brk, sd };
}

// ------------------------------------------------------------ clustering

export function clusterLevels(levels, tol, maxSpan) {
  const sorted = [...levels].sort((a, b) => (a.lo + a.hi) / 2 - (b.lo + b.hi) / 2);
  const clusters = [];
  for (const L of sorted) {
    const cur = clusters[clusters.length - 1];
    if (cur && L.lo - cur.hi <= tol && Math.max(cur.hi, L.hi) - cur.lo <= maxSpan) {
      cur.members.push(L);
      cur.hi = Math.max(cur.hi, L.hi);
      cur.lo = Math.min(cur.lo, L.lo);
    } else clusters.push({ lo: L.lo, hi: L.hi, members: [L] });
  }
  return clusters.map((c) => {
    // each family counts once: keep its heaviest member
    const best = {};
    c.members.forEach((m) => {
      if (!best[m.family] || m.weight > best[m.family].weight) best[m.family] = m;
    });
    const families = Object.keys(best);
    const conf = families.reduce((s, f) => s + best[f].weight, 0);
    return { ...c, families, familyBest: best, conf };
  });
}

export function qualifies(c) {
  if (c.families.length >= 2) return true;
  const only = c.familyBest[c.families[0]];
  return !!(only && (only.family === "sr" || only.family === "retest") && (only.touches || 0) >= 3);
}

// ------------------------------------------------------------ zone + plan

function pickPreferred(zone, members, price, atr) {
  const steps = 9;
  let bestP = null, bestScore = -1, bestDist = Infinity;
  for (let i = 0; i < steps; i++) {
    const p = zone.lo + ((zone.hi - zone.lo) * i) / (steps - 1);
    const overlap = members.reduce((s, m) => s + (p >= m.lo - atr * 0.05 && p <= m.hi + atr * 0.05 ? 1 : 0), 0);
    const d = Math.abs(p - price);
    if (overlap > bestScore || (overlap === bestScore && d < bestDist)) {
      bestP = p;
      bestScore = overlap;
      bestDist = d;
    }
  }
  return { price: bestP, overlap: bestScore };
}

function emptyPlan(side, issues, extra = {}) {
  return { side, valid: false, issues, label: NO_VALID_ZONE, zone: null, entry: null, stop: null, invalidation: null, targets: [], rr1: null, rr2: null, rr3: null, riskPct: null, trigger: null, ...extra };
}

export function buildSmartPlan(side, ctx) {
  const { f1, price, settings } = ctx;
  const atr = f1.atr;
  const s = side;
  const issues = [];
  const { levels, leg, brk } = collectLevels(s, ctx);
  // keep levels on the actionable side of price (support below / resistance above, small overlap allowed)
  const usable = levels.filter((L) => (s === 1 ? L.hi <= price + atr * 0.25 : L.lo >= price - atr * 0.25)).filter((L) => Math.abs((L.lo + L.hi) / 2 - price) <= atr * settings.maxZoneDistAtr);
  const clusters = clusterLevels(usable, atr * settings.clusterAtr, atr * 1.2).filter(qualifies);
  if (!clusters.length) {
    issues.push("No meaningful zone: no cluster has 2+ independent confluence families or a strong (3+ touch) structural zone on the correct side of price.");
    return emptyPlan(s, issues, { levelsConsidered: levels.length });
  }
  const rank = (c) => c.conf - 0.35 * (Math.abs((c.lo + c.hi) / 2 - price) / atr);
  clusters.sort((a, b) => rank(b) - rank(a));
  const top = clusters[0];
  // zone = union of members, padded; clamp width
  let lo = top.lo - atr * settings.zonePadAtr, hi = top.hi + atr * settings.zonePadAtr;
  if (hi - lo < atr * settings.minZoneAtr) {
    const mid = (lo + hi) / 2;
    lo = mid - (atr * settings.minZoneAtr) / 2;
    hi = mid + (atr * settings.minZoneAtr) / 2;
  }
  if (hi - lo > atr * settings.maxZoneAtr) {
    if (s === 1) lo = hi - atr * settings.maxZoneAtr;
    else hi = lo + atr * settings.maxZoneAtr;
  }
  const pref = pickPreferred({ lo, hi }, top.members, price, atr);
  const entry = pref.price;
  const typeParts = top.families.map((f) => ({ sr: "S/R", retest: "Retest", sd: s === 1 ? "Demand" : "Supply", ema: "EMA", fib: "Fib", vwap: "VWAP" }[f]));
  const plan = {
    side: s,
    valid: false,
    issues,
    label: null,
    zone: { lo, hi, type: typeParts.join(" + "), families: top.families, confluence: Math.round(top.conf * 10) / 10, members: top.members.map((m) => ({ family: m.family, source: m.source, lo: m.lo, hi: m.hi, historical: !!m.historical })) },
    entry,
    entryMethod: `Price inside the zone where the most confluence levels overlap (${pref.overlap} of ${top.members.length}); ties go to the price nearest the market.`,
    stop: null,
    invalidation: null,
    targets: [],
    rr1: null,
    rr2: null,
    rr3: null,
    riskPct: null,
    trigger: null,
    leg: leg ? { anchor: leg.anchor.price, extreme: leg.extreme.price } : null,
    alternates: clusters.slice(1, 3).map((c) => ({ lo: c.lo, hi: c.hi, families: c.families, confluence: Math.round(c.conf * 10) / 10 })),
    retest: brk ? { retested: brk.retested, volOk: brk.volOk, barsAgo: brk.barsAgo } : null,
    costPct: settings.feePct * 2 + settings.slippagePct * 2,
  };

  // ---- invalidation + stop (structure first, ATR buffer, beyond invalidation) ----
  let inval;
  if (s === 1) {
    const sw = f1.lastSwingLow && f1.lastSwingLow.price < hi ? f1.lastSwingLow.price : null;
    inval = sw !== null && hi - sw <= atr * 4 ? Math.min(lo, sw) : lo;
  } else {
    const sw = f1.lastSwingHigh && f1.lastSwingHigh.price > lo ? f1.lastSwingHigh.price : null;
    inval = sw !== null && sw - lo <= atr * 4 ? Math.max(hi, sw) : hi;
  }
  let stop = inval - s * atr * settings.stopAtrBuffer;
  if (Math.abs(entry - stop) < atr * settings.minStopAtr) stop = entry - s * atr * settings.minStopAtr;
  plan.invalidation = inval;
  plan.stop = stop;
  const risk = Math.abs(entry - stop);
  if (risk > atr * settings.maxStopAtr) {
    issues.push(`Stop would be ${(risk / atr).toFixed(1)} ATR away (max ${settings.maxStopAtr}) — structure too wide`);
    plan.label = NO_VALID_ZONE;
    return plan;
  }
  if (risk > atr * 3.5) issues.push("Wide stop (> 3.5 ATR)");
  plan.riskPct = (risk / entry) * 100;

  // ---- targets: confirmed opposing structure, then explicit risk multiples ----
  const opp = f1.zones
    .filter((z) => (s === 1 ? z.lo > entry + atr * 0.8 : z.hi < entry - atr * 0.8))
    .sort((a, b) => (s === 1 ? a.lo - b.lo : b.hi - a.hi));
  const targets = [];
  for (const z of opp) {
    const p = s === 1 ? z.lo : z.hi;
    const prev = targets.length ? targets[targets.length - 1].price : entry;
    if (Math.abs(p - prev) >= atr * 0.8) targets.push({ price: p, source: `confirmed ${s === 1 ? "resistance" : "support"} zone (${z.touches} touches)`, kind: "structure" });
    if (targets.length === 3) break;
  }
  const mult = [1.5, 2.5, 4];
  for (let q = targets.length; q < 3; q++) {
    const prev = targets.length ? targets[targets.length - 1].price : entry;
    const base = entry + s * risk * mult[q];
    const p = s === 1 ? Math.max(base, prev + risk * 0.5) : Math.min(base, prev - risk * 0.5);
    targets.push({ price: p, source: `${mult[q]}R risk multiple`, kind: "multiple" });
  }
  plan.targets = targets.map((t, i) => ({ label: `TP${i + 1}`, ...t, rr: rrNet(entry, stop, t.price, settings), grossR: Math.abs(t.price - entry) / risk }));
  plan.rr1 = plan.targets[0].rr;
  plan.rr2 = plan.targets[1].rr;
  plan.rr3 = plan.targets[2].rr;
  const near = plan.targets[0].kind === "structure" && plan.targets[0].grossR < 1.2;
  plan.nearOpposing = near ? { price: plan.targets[0].price, grossR: plan.targets[0].grossR } : null;
  plan.valid = true;
  return plan;
}

// ------------------------------------------------------------ trigger

// A completed-candle trigger. Either (a) close beyond the last confirmed 15m
// swing + EMA20 + volume (reused from the Radar) or (b) a rejection candle at
// the zone. Both need the zone to have been tested within the last 8 closed
// 15m candles. Uses CLOSED candles only.
export function smartTrigger(f15, plan, s) {
  if (!f15 || !f15.ok || !plan || !plan.zone) return null;
  const closed = f15.closed;
  const n = closed.length;
  if (n < 12) return null;
  const last = closed[n - 1];
  const { lo, hi } = plan.zone;
  const tested = closed.slice(-8).some((c) => c.l <= hi && c.h >= lo);
  const swing = triggerFrom15m(f15, s);
  const range = last.h - last.l;
  let rejection = false;
  if (range > 0) {
    const touched = s === 1 ? last.l <= hi : last.h >= lo;
    const closeBack = s === 1 ? last.c > hi && last.c > last.o : last.c < lo && last.c < last.o;
    const wick = s === 1 ? Math.min(last.o, last.c) - last.l : last.h - Math.max(last.o, last.c);
    rejection = touched && closeBack && wick >= range * 0.45;
  }
  const kind = swing && swing.closedConfirm && tested ? "swing-break" : rejection ? "rejection" : null;
  return {
    confirmed: !!kind,
    kind,
    level: swing ? swing.level : null,
    tested,
    parts: swing ? swing.parts : null,
    candleTime: last.t,
    text:
      s === 1
        ? "A completed 15m candle either (a) closes above the last confirmed 15m swing high and above EMA20 on volume ≥ its 20-candle average, or (b) is a bullish rejection: wick into the zone, closes back above it — after the zone was tested"
        : "A completed 15m candle either (a) closes below the last confirmed 15m swing low and below EMA20 on volume ≥ its 20-candle average, or (b) is a bearish rejection: wick into the zone, closes back below it — after the zone was tested",
  };
}

// ------------------------------------------------------------ score

export function scoreZone(side, ctx) {
  const { t4, f1, f15, plan, settings, quoteVolume, spreadPct, stale } = ctx;
  const comps = [];
  const pen = [];
  const add = (key, name, points, weight, note) => comps.push({ key, name, points: Math.round(points * 10) / 10, weight, note });
  if (!plan || !plan.valid) return { score: 0, components: comps, penalties: pen, reasons: { for: [], against: ["No valid zone / plan"] } };
  const sName = side === 1 ? "bullish" : "bearish";
  // trend alignment (4H primary + 1H structure)
  let trend = 0, tNote;
  if (t4.dir === side) {
    trend = 20 * (0.6 + 0.4 * (t4.strength / 100));
    tNote = `4H trend ${t4.label} (strength ${t4.strength})`;
  } else if (t4.dir === 0 && f1.structure.label === (side === 1 ? "BULLISH" : "BEARISH")) {
    trend = 8;
    tNote = `4H ranging; 1H structure ${f1.structure.label}`;
  } else tNote = `4H ${t4.label}, 1H ${f1.structure.label} — not aligned`;
  add("trend", "Trend alignment", trend, 20, tNote);
  // structural confluence (independent families only)
  const fams = plan.zone.families.length;
  const conf = fams >= 4 ? 20 : fams === 3 ? 15 : fams === 2 ? 10 : 5;
  add("confluence", "Structural confluence", conf, 20, `${fams} independent famil${fams === 1 ? "y" : "ies"}: ${plan.zone.families.join(", ")}`);
  // level quality
  const st = plan.zone.members.find((m) => m.family === "sr" || m.family === "retest" || m.family === "sd");
  const srMember = f1.zones.find((z) => z.lo <= plan.zone.hi && z.hi >= plan.zone.lo);
  let lq = 6;
  let lqNote = "no confirmed S/R zone inside — EMA/Fib/VWAP only";
  if (st) {
    const strength = srMember ? srMember.strength : 50;
    lq = 15 * clamp(strength / 100, 0.3, 1);
    lqNote = `${st.family === "sd" ? "supply/demand" : "S/R"} zone, strength ${strength}${plan.retest ? (plan.retest.retested ? ", retest held" : ", retest pending") : ""}`;
    if (plan.retest && plan.retest.retested && plan.retest.volOk) lq = Math.min(15, lq + 3);
  }
  add("level", "Level quality", lq, 15, lqNote);
  // volume + momentum (one volume read, one momentum read)
  const rv = f1.relVol;
  const volPts = rv === null ? 2 : clamp((rv - 0.6) / 0.8, 0, 1) * 7;
  const rsi1 = f1.rsi;
  const rsiRising = f15 && f15.ok && f15.rsi !== null && f15.rsiPrev !== null ? (side === 1 ? f15.rsi > f15.rsiPrev : f15.rsi < f15.rsiPrev) : false;
  let momPts = 0;
  if (rsi1 !== null) {
    const healthy = side === 1 ? rsi1 >= 32 && rsi1 <= 62 : rsi1 >= 38 && rsi1 <= 68;
    momPts = (healthy ? 4 : 1) + (rsiRising ? 4 : 0);
  }
  add("volmom", "Volume & momentum", volPts + momPts, 15, `1H relative volume ${rv === null ? "UNAVAILABLE" : rv.toFixed(2) + "×"}; 1H RSI ${rsi1 === null ? "UNAVAILABLE" : rsi1.toFixed(0)}${rsiRising ? ", 15m RSI turning " + sName : ""}`);
  // volatility suitability
  const atrPct = (f1.atr / f1.price) * 100;
  const vol = atrPct < 0.25 ? 3 : atrPct <= 3 ? 10 : atrPct <= settings.highVolPct ? 5 : 0;
  add("vol", "Volatility suitability", vol, 10, `1H ATR ${atrPct.toFixed(2)}% of price`);
  // risk/reward (net)
  const rr = plan.rr2;
  const rrPts = rr === null || rr === undefined ? 0 : 20 * clamp((rr - 0.5) / 2.5, 0, 1);
  add("rr", "Net risk/reward (TP2)", rrPts, 20, rr === null || rr === undefined ? "UNAVAILABLE" : `net R:R ${rr.toFixed(2)} after fees + slippage`);

  const penalize = (name, points, note) => pen.push({ name, points, note });
  if (stale) penalize("Stale data", 10, "market data older than the stale limit");
  const conflict = t4.dir === -side || (f1.structure.label === (side === 1 ? "BEARISH" : "BULLISH") && t4.dir !== side);
  if (conflict) penalize("Conflicting timeframes", 8, `4H ${t4.label} vs 1H ${f1.structure.label} vs this ${side === 1 ? "LONG" : "SHORT"}`);
  if (isNum(quoteVolume) && quoteVolume < settings.minQuoteVol) penalize("Low liquidity", 10, `24h volume ${(quoteVolume / 1e6).toFixed(1)}M < ${(settings.minQuoteVol / 1e6).toFixed(0)}M`);
  if (isNum(spreadPct) && spreadPct > settings.maxSpreadPct) penalize("Wide spread", 5, `spread ${spreadPct.toFixed(3)}%`);
  if (plan.nearOpposing) penalize("Nearby opposing level", 6, `confirmed ${side === 1 ? "resistance" : "support"} only ${plan.nearOpposing.grossR.toFixed(1)}R from entry`);
  if (rr !== null && rr !== undefined && rr < 1) penalize("Poor risk/reward", 5, `net R:R ${rr.toFixed(2)} < 1`);

  const sum = comps.reduce((a, c) => a + c.points, 0) - pen.reduce((a, p) => a + p.points, 0);
  const score = Math.round(clamp(sum, 0, 100));
  const reasons = { for: [], against: [] };
  comps.forEach((c) => (c.points >= c.weight * 0.6 ? reasons.for : c.points <= c.weight * 0.3 ? reasons.against : []).push?.(`${c.name}: ${c.note}`));
  pen.forEach((p) => reasons.against.push(`${p.name}: ${p.note}`));
  plan.issues.forEach((i) => reasons.against.push(i));
  return { score, components: comps, penalties: pen, reasons };
}

// ------------------------------------------------------------ sizing

// Position size from a risk budget. Leverage changes margin and liquidation
// distance only — never the stop distance. Returns null for invalid inputs.
export function positionSize({ account, riskPct, leverage, entry, stop, side, settings }) {
  const st = { ...SMART_DEFAULTS, ...(settings || {}) };
  const a = Number(account), r = Number(riskPct), lev = Number(leverage);
  if (![a, r, lev, entry, stop].every((x) => isNum(x) && x > 0)) return null;
  const stopDist = Math.abs(entry - stop);
  if (!(stopDist > 0)) return null;
  const cost = costPerUnit(entry, st);
  const riskAmount = (a * r) / 100;
  const qty = riskAmount / (stopDist + cost);
  const notional = qty * entry;
  const margin = notional / lev;
  const maxNotional = a * lev;
  const mmr = st.mmrPct / 100;
  const liq = side === 1 ? entry * (1 - 1 / lev + mmr) : entry * (1 + 1 / lev - mmr);
  const liqBeforeStop = side === 1 ? liq >= stop : liq <= stop;
  const warnings = [];
  if (margin > a) warnings.push(`Needs ${margin.toFixed(2)} USDT margin but the account is ${a} USDT — reduce risk %, raise leverage, or use a wider account.`);
  if (liqBeforeStop) warnings.push("At this leverage the ROUGH liquidation estimate is closer than the stop — you would be liquidated before the stop triggers. Lower the leverage.");
  if (lev >= 50) warnings.push("Very high leverage leaves almost no room for normal price movement.");
  return {
    riskAmount,
    stopDist,
    costPerUnit: cost,
    qty,
    notional,
    margin,
    leverage: lev,
    maxNotional,
    liqApprox: liq,
    liqBeforeStop,
    warnings,
    note: "Leverage changes margin and liquidation risk, not the price distance to your stop. A stop order may fill worse than its price in fast markets. The liquidation figure is a ROUGH estimate (assumed maintenance margin " + st.mmrPct + "%); Binance's real value depends on position tier, fees and funding.",
  };
}

// ------------------------------------------------------------ status machine

// Statuses and their allowed transitions (one signal per setup).
export const TRANSITIONS = {
  [SMART_STATUS.WAIT_ZONE]: [SMART_STATUS.IN_ZONE, SMART_STATUS.INVALIDATED, SMART_STATUS.NO_TRADE, SMART_STATUS.STALE, SMART_STATUS.MISSED, SMART_STATUS.LONG_TRIGGERED, SMART_STATUS.SHORT_TRIGGERED],
  [SMART_STATUS.IN_ZONE]: [SMART_STATUS.LONG_TRIGGERED, SMART_STATUS.SHORT_TRIGGERED, SMART_STATUS.WAIT_ZONE, SMART_STATUS.MISSED, SMART_STATUS.INVALIDATED, SMART_STATUS.NO_TRADE, SMART_STATUS.STALE],
  [SMART_STATUS.LONG_TRIGGERED]: [SMART_STATUS.INVALIDATED, SMART_STATUS.MISSED, SMART_STATUS.STALE],
  [SMART_STATUS.SHORT_TRIGGERED]: [SMART_STATUS.INVALIDATED, SMART_STATUS.MISSED, SMART_STATUS.STALE],
  [SMART_STATUS.MISSED]: [SMART_STATUS.WAIT_ZONE, SMART_STATUS.INVALIDATED, SMART_STATUS.STALE],
  [SMART_STATUS.INVALIDATED]: [SMART_STATUS.WAIT_ZONE, SMART_STATUS.NO_TRADE],
  [SMART_STATUS.NO_TRADE]: Object.values(SMART_STATUS),
  [SMART_STATUS.STALE]: Object.values(SMART_STATUS),
};

// Tracks the last status per setup and suppresses duplicate signals: a
// signal fires only when the setup ID + status pair is new. A TRIGGERED setup
// stays TRIGGERED until it is invalidated, missed, or goes stale.
export function createStatusTracker() {
  const last = new Map();
  return {
    advance(setupId, status) {
      const prev = last.get(setupId) || null;
      if (prev === status) return { status, changed: false, duplicate: true, prev };
      let next = status;
      if (prev && !(TRANSITIONS[prev] || []).includes(status) && prev !== status) {
        // illegal jump (e.g. TRIGGERED -> WAIT FOR ZONE): hold the previous status
        next = prev;
        return { status: next, changed: false, duplicate: false, held: true, rejected: status, prev };
      }
      last.set(setupId, next);
      return { status: next, changed: true, duplicate: false, prev };
    },
    reset: () => last.clear(),
    get: (id) => last.get(id) || null,
  };
}

export function smartSetupId(symbol, side, plan, atr, candleTime) {
  if (!plan || !plan.zone) return null;
  const bucket = atr > 0 ? Math.round((plan.zone.lo + plan.zone.hi) / 2 / (atr * 0.5)) : 0;
  return `${symbol}:${side === 1 ? "L" : "S"}:${bucket}${candleTime ? ":" + candleTime : ""}`;
}

// ------------------------------------------------------------ side status

export function sideStatus(side, ctx) {
  const { plan, price, f15, f1, settings, stale, dead, supported, quoteVolume, scoreObj, trig } = ctx;
  const out = (status, reason, extra = {}) => ({ status, reason, ...extra });
  if (dead) return out(SMART_STATUS.NO_TRADE, "Insufficient data", { label: "INSUFFICIENT DATA" });
  if (!supported.ok) return out(SMART_STATUS.NO_TRADE, supported.reason, { label: "CONTEXT NOT SUPPORTIVE" });
  if (!plan.valid) return out(SMART_STATUS.NO_TRADE, plan.issues[0] || NO_VALID_ZONE, { label: NO_VALID_ZONE });
  if (isNum(quoteVolume) && quoteVolume < settings.minQuoteVol * settings.illiquidFactor) return out(SMART_STATUS.NO_TRADE, `24h volume ${(quoteVolume / 1e6).toFixed(2)}M is far too low to trade safely`, { label: "ILLIQUID" });
  if (plan.rr2 === null || plan.rr2 === undefined || plan.rr2 < settings.minRR) return out(SMART_STATUS.NO_TRADE, `Net R:R (TP2) ${plan.rr2 == null ? "UNAVAILABLE" : plan.rr2.toFixed(2)} is below the ${settings.minRR} minimum`, { label: "POOR RISK/REWARD" });
  const atr = f1.atr;
  const lastClose15 = f15 && f15.ok ? f15.last.c : null;
  const beyond = (p, lvl) => (side === 1 ? p <= lvl : p >= lvl);
  const invalidated = beyond(price, plan.stop) || (lastClose15 !== null && beyond(lastClose15, plan.invalidation));
  if (invalidated) return out(SMART_STATUS.INVALIDATED, `${side === 1 ? "Price/closed 15m candle is below" : "Price/closed 15m candle is above"} the invalidation level — structure failed`);
  if (stale) return out(SMART_STATUS.STALE, "Market data is older than the stale limit — levels may be out of date; no signal is given");
  const { lo, hi } = plan.zone;
  const closed15 = f15 && f15.ok ? f15.closed : [];
  const touchedRecent = closed15.slice(-settings.touchLookback15m).some((c) => c.l <= hi && c.h >= lo);
  const away = side === 1 ? price - hi : lo - price; // >0: still on the market side of the zone
  const chase = settings.maxChaseAtr * atr;
  const inside = price >= lo && price <= hi;
  const deep = side === 1 ? price < lo : price > hi; // through the zone but not invalidated
  const provisional = !!(f15 && f15.forming && trig && !trig.confirmed && trig.level !== null && (side === 1 ? price > trig.level : price < trig.level) && (inside || touchedRecent));
  if (trig && trig.confirmed && away <= chase) {
    return out(side === 1 ? SMART_STATUS.LONG_TRIGGERED : SMART_STATUS.SHORT_TRIGGERED, `Completed 15m candle confirmed (${trig.kind === "rejection" ? "rejection at the zone" : "close beyond the 15m swing"}) and price is still within ${settings.maxChaseAtr} ATR of the zone`, { signalCandle: trig.candleTime });
  }
  if (inside || deep) {
    return out(SMART_STATUS.IN_ZONE, deep ? "Price is through the zone but still above the invalidation — wait for a completed-candle confirmation (wider risk than planned)" : "Price is inside the zone — wait for a completed 15m confirmation", { provisional });
  }
  if (away > chase && touchedRecent) return out(SMART_STATUS.MISSED, `Zone was tested and price has since moved ${(away / atr).toFixed(1)} ATR beyond it without a confirmed entry — do not chase`);
  const retest = plan.zone.families.includes("retest");
  return out(SMART_STATUS.WAIT_ZONE, `Price is ${(away / atr).toFixed(1)} ATR from the zone — ${retest ? "wait for a retest" : "wait for a pullback"}`, { hint: retest ? "WAIT FOR RETEST" : "WAIT FOR PULLBACK", provisional });
}

function contextSupports(side, t4, f1) {
  if (t4.dir === side) return { ok: true };
  if (t4.dir === 0 && f1.structure.label === (side === 1 ? "BULLISH" : "BEARISH")) return { ok: true };
  return { ok: false, reason: `${side === 1 ? "LONG" : "SHORT"} is not supported: 4H trend is ${t4.label}${t4.dir === 0 ? ` and 1H structure is ${f1.structure.label}` : ""}` };
}

// ------------------------------------------------------------ evaluator

// frames: { "4h", "1h", "15m", "5m"? } from analyzeFrame.
// live:   { ticker:{lastPrice, quoteVolume, priceChangePercent}, book:{bid,ask}|null, markPrice?:number }
// ages:   { "4h","1h","15m", ticker } — how far behind real time each source is.
export function evaluateSmartEntry({ symbol, frames, live, ages, settings: user, now }) {
  const settings = { ...SMART_DEFAULTS, ...(user || {}) };
  const f4 = frames["4h"], f1 = frames["1h"], f15 = frames["15m"], f5 = frames["5m"] || null;
  const tk = (live && live.ticker) || null;
  const flags = [];
  const base = { symbol, settings, flags, ages: ages || {}, evaluatedAt: now };
  let reason = null;
  if (!tk || !isNum(parseFloat(tk.lastPrice)) || !(parseFloat(tk.lastPrice) > 0)) reason = "No valid price";
  else if (!f4 || !f1 || !f15) reason = "Missing timeframe data";
  else if (!f4.ok || !f1.ok || !f15.ok || f4.n < 55 || f1.n < 55 || f15.n < 55) reason = `Not enough closed candles (4H ${f4 ? f4.n : 0}, 1H ${f1 ? f1.n : 0}, 15m ${f15 ? f15.n : 0}; need ≥ 55 each)`;
  else if (countGaps(f1.closed, TF_MS["1h"], 30) >= 3 || countGaps(f15.closed, TF_MS["15m"], 30) >= 3) reason = "Too many missing candles in the recent history";
  const oldest = ages ? Math.max(ages["4h"] ?? 0, ages["1h"] ?? 0, ages["15m"] ?? 0, ages.ticker ?? 0) : 0;
  if (!reason && oldest > settings.deadMs) reason = `Data is ${Math.round(oldest / 60000)} min old`;
  if (reason) {
    return { ...base, ok: false, dead: true, reason, status: SMART_STATUS.NO_TRADE, label: "INSUFFICIENT DATA", price: tk ? parseFloat(tk.lastPrice) : null, long: null, short: null, primary: null };
  }
  const stale = oldest > settings.staleMs;
  if (stale) flags.push("DATA STALE");
  const price = parseFloat(tk.lastPrice);
  const quoteVolume = parseFloat(tk.quoteVolume);
  const spreadPct = live.book && live.book.bid > 0 && live.book.ask > 0 ? ((live.book.ask - live.book.bid) / ((live.book.ask + live.book.bid) / 2)) * 100 : null;
  if (isNum(quoteVolume) && quoteVolume < settings.minQuoteVol) flags.push("LOW LIQUIDITY");
  if (spreadPct !== null && spreadPct > settings.maxSpreadPct) flags.push("WIDE SPREAD");
  if (spreadPct === null) flags.push("SPREAD UNAVAILABLE");
  if (f4.ema200 === null) flags.push("4H EMA200 UNAVAILABLE");
  if (f1.ema200 === null) flags.push("1H EMA200 UNAVAILABLE");
  const t4 = trendFromFrame(f4);
  // Zones are built from the last CLOSED 1H price so they only move when a candle closes
  // (a zone must not vanish the moment live price walks into it). Live price drives status only.
  const ctx0 = { f1, f4, f15, price: f1.price, settings };
  const res = {};
  for (const s of [1, -1]) {
    const plan = buildSmartPlan(s, ctx0);
    const supported = contextSupports(s, t4, f1);
    const trig = plan.valid ? smartTrigger(f15, plan, s) : null;
    plan.trigger = trig;
    const scoreObj = scoreZone(s, { t4, f1, f15, plan, settings, quoteVolume, spreadPct, stale });
    const st = sideStatus(s, { plan, price, f15, f1, settings, stale, dead: false, supported, quoteVolume, scoreObj, trig });
    let fine = null;
    if (f5 && f5.ok && plan.valid) {
      const ok = s === 1 ? f5.last.c > f5.ema20 : f5.last.c < f5.ema20;
      fine = { aligned: ok, text: `5m closed ${ok === (s === 1) ? "above" : "below"} EMA20 (refinement only, not scored)` };
    }
    res[s] = { side: s, plan, supported, score: scoreObj.score, scoreDetail: scoreObj, status: st.status, label: st.label || null, reason: st.reason, hint: st.hint || null, provisional: !!st.provisional, signalCandle: st.signalCandle || null, trigger: trig, fine, id: plan.valid ? smartSetupId(symbol, s, plan, f1.atr) : null };
  }
  const rankOf = (r) => (r.supported.ok && r.plan.valid ? r.score : -1);
  const primary = rankOf(res[1]) === rankOf(res[-1]) ? null : rankOf(res[1]) > rankOf(res[-1]) ? 1 : -1;
  return {
    ...base,
    ok: true,
    dead: false,
    stale,
    price,
    change24h: parseFloat(tk.priceChangePercent),
    quoteVolume,
    spreadPct,
    t4,
    structure1h: f1.structure.label,
    structure15m: f15.structure.label,
    atr1h: f1.atr,
    long: res[1],
    short: res[-1],
    primary,
    lastClosed: { "4h": f4.last.t, "1h": f1.last.t, "15m": f15.last.t },
    lastClosedAt: { "4h": f4.last.ct, "1h": f1.last.ct, "15m": f15.last.ct },
    keyLevels: f1.zones.map((z) => ({ lo: z.lo, hi: z.hi, strength: z.strength, touches: z.touches })),
  };
}

// Convenience for tests / callers: is the symbol tradable per exchangeInfo status?
export function symbolCheck(symbol, statusMap) {
  const sym = String(symbol || "").toUpperCase();
  if (!/^[A-Z0-9]{2,20}USDT$/.test(sym)) return { ok: false, reason: "Not a USDT-margined symbol (expected something like BTCUSDT)" };
  const info = statusMap && statusMap[sym];
  if (!info) return { ok: false, reason: `${sym} is not listed on Binance USDⓈ-M futures (unknown or delisted)` };
  if (info.quoteAsset !== "USDT") return { ok: false, reason: `${sym} is not quoted in USDT` };
  if (info.contractType !== "PERPETUAL") return { ok: false, reason: `${sym} is not a PERPETUAL contract (${info.contractType || "unknown"})` };
  if (info.status !== "TRADING") return { ok: false, reason: `${sym} is not currently trading (status ${info.status})` };
  return { ok: true };
}

export { mean };
