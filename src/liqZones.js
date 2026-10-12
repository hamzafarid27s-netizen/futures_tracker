// Liquidation heatmap & liquidity zones — pure analysis, no network, no React.
//
// WHAT THIS IS (and is not)
//  • Binance publishes NO historical liquidation-price map and no per-trader liquidation
//    prices. Nothing here claims to know them.
//  • ESTIMATED zones are a MODEL: "if leveraged positions had been opened around the price
//    anchors below, at the leverage tiers below, where would they be liquidated, and has price
//    already traded through that level?". Every assumption is returned in `assumptions`.
//  • LIQUIDITY pools (equal highs/lows, swing highs/lows) are places where stop orders are
//    ASSUMED to rest. They are never called liquidation clusters.
//  • OBSERVED zones come only from real liquidation events received on Binance's public
//    liquidation stream while the page was open (see liqStream.js).
//  • DEPTH walls are order-book snapshots (they can be cancelled or spoofed).
//  • Missing inputs are reported as UNAVAILABLE and never replaced with zero.

import { findPivots, trendFromFrame, rrNet } from "./entryRadar.js";

export const LIQ_KIND = { OBSERVED: "OBSERVED", ESTIMATED: "ESTIMATED", LIQUIDITY: "LIQUIDITY", DEPTH: "DEPTH" };
export const LIQ_TFS = ["5m", "15m", "1h", "4h", "1d"];

export const LIQ_DEFAULTS = {
  lookback: 200, // closed candles used (≤ candles available)
  leverages: [10, 25, 50, 100],
  leverageWeights: { 10: 0.35, 25: 0.35, 50: 0.2, 100: 0.1 }, // ASSUMED mix of leverage used by traders
  mmr: 0.005, // ASSUMED maintenance-margin rate (real value depends on notional bracket)
  equalTolAtr: 0.25, // pivots within this many ATR count as "equal" highs/lows
  clusterAtr: 0.5, // levels within this many ATR are merged into one zone
  minStrength: 20,
  maxZonesPerSide: 6,
  volAnchorRel: 1.8, // candles with volume ≥ this × average become price anchors
  sweepBufferAtr: 0.05,
  sweepWickAtr: 0.3, // minimum wick beyond a level to call it a sweep
  holdBars: 2, // closes beyond a level needed to call a breakout "holding"
  eventBars: 12, // how far back events are searched
  breakVol: 1.5,
  oiMinPct: 1.0,
  fundExt: 0.0005,
  wallMult: 6, // order-book wall = level notional ≥ this × median level notional
  wallMinUsd: 250_000,
  depthRangePct: 8,
  obsWindowMs: 15 * 60_000,
  obsMinUsd: 100_000, // observed liquidations in the window needed for a "cascade" flag
  staleMs: 5 * 60_000,
  deadMs: 20 * 60_000,
  maxDistanceAtr: 6,
  maxDistancePct: 8,
  feePct: 0.05,
  slippagePct: 0.03,
};

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const round1 = (x) => Math.round(x * 10) / 10;
const pctChange = (a, b) => (isNum(a) && isNum(b) && b > 0 ? ((a - b) / b) * 100 : null);

export function normalizeSymbol(input) {
  if (typeof input !== "string") return null;
  let s = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!s) return null;
  if (!s.endsWith("USDT")) s += "USDT";
  return s.length > 4 ? s : null;
}

// ------------------------------------------------------------------ helpers

function relVolumes(closed, base = 20) {
  const qv = closed.map((c) => c.qv);
  return qv.map((v, i) => {
    const b = qv.slice(Math.max(0, i - base), i);
    if (b.length < 5) return null;
    const m = b.reduce((a, x) => a + x, 0) / b.length;
    return m > 0 ? v / m : null;
  });
}

export function distanceInfo(zone, price) {
  if (!isNum(price) || !(price > 0) || !zone) return { abs: null, pct: null, side: null };
  if (zone.lo > price) return { abs: zone.lo - price, pct: ((zone.lo - price) / price) * 100, side: "above" };
  if (zone.hi < price) return { abs: price - zone.hi, pct: ((price - zone.hi) / price) * 100, side: "below" };
  return { abs: 0, pct: 0, side: "inside" };
}

function clusterByPrice(items, tol) {
  const sorted = [...items].sort((a, b) => a.price - b.price);
  const out = [];
  for (const it of sorted) {
    const cur = out[out.length - 1];
    if (cur && it.price - cur.hi <= tol) {
      cur.items.push(it);
      cur.hi = it.price;
    } else out.push({ lo: it.price, hi: it.price, items: [it] });
  }
  return out;
}

function zoneId(symbol, tf, kind, side, mid) {
  return `${symbol}|${tf}|${kind}|${side > 0 ? "A" : "B"}|${Number(mid).toPrecision(6)}`;
}

// ------------------------------------------------------------------ anchors

// Price anchors from the lookback window: confirmed swing highs/lows and
// high-volume candles. Weight = relative volume × recency.
export function buildAnchors(closed, start, k, cfg, rel) {
  const n = closed.length;
  const h = closed.map((c) => c.h), l = closed.map((c) => c.l);
  const piv = findPivots(h, l, k);
  const half = Math.max(10, (n - start) / 2);
  const rec = (i) => Math.pow(0.5, (n - 1 - i) / half);
  const out = [];
  const w = (i) => clamp(rel[i] === null || rel[i] === undefined ? 1 : rel[i], 0.5, 4) * rec(i);
  piv.highs.filter((p) => p.i >= start).forEach((p) => out.push({ i: p.i, price: p.price, kind: "swing-high", w: w(p.i), rel: rel[p.i] ?? null, rec: rec(p.i), bias: -1 }));
  piv.lows.filter((p) => p.i >= start).forEach((p) => out.push({ i: p.i, price: p.price, kind: "swing-low", w: w(p.i), rel: rel[p.i] ?? null, rec: rec(p.i), bias: 1 }));
  for (let i = Math.max(start, 0); i < n; i++) {
    if (rel[i] !== null && rel[i] !== undefined && rel[i] >= cfg.volAnchorRel) {
      const c = closed[i];
      out.push({ i, price: c.c, kind: "volume", w: w(i), rel: rel[i], rec: rec(i), bias: c.c >= c.o ? 1 : -1 });
    }
  }
  return { anchors: out, pivots: piv, half };
}

// ------------------------------------------------------- estimated liq zones

// For each anchor and leverage tier: liquidation price of a position opened at the anchor.
// long  liq = P × (1 − 1/L + mmr)   (below the anchor)
// short liq = P × (1 + 1/L − mmr)   (above the anchor)
// A level is CONSUMED (dropped) when any later candle already traded through it.
export function estimateLevels(anchors, closed, forming, price, cfg) {
  const levels = [];
  const n = closed.length;
  for (const a of anchors) {
    for (const L of cfg.leverages) {
      const lw = cfg.leverageWeights[L] ?? 1 / cfg.leverages.length;
      const longLiq = a.price * (1 - 1 / L + cfg.mmr);
      const shortLiq = a.price * (1 + 1 / L - cfg.mmr);
      // directional bias: anchors at lows/bullish volume lean long, at highs/bearish lean short (ASSUMPTION)
      const wl = a.w * lw * (a.bias === 1 ? 1 : 0.5);
      const ws = a.w * lw * (a.bias === -1 ? 1 : 0.5);
      let longDead = price <= longLiq, shortDead = price >= shortLiq;
      for (let j = a.i + 1; j < n && !(longDead && shortDead); j++) {
        if (closed[j].l <= longLiq) longDead = true;
        if (closed[j].h >= shortLiq) shortDead = true;
      }
      if (forming) {
        if (forming.l <= longLiq) longDead = true;
        if (forming.h >= shortLiq) shortDead = true;
      }
      if (!longDead && longLiq < price) levels.push({ price: longLiq, w: wl, lev: L, side: -1, anchor: a });
      if (!shortDead && shortLiq > price) levels.push({ price: shortLiq, w: ws, lev: L, side: 1, anchor: a });
    }
  }
  return levels;
}

function estimatedZones({ symbol, tf, levels, price, atr, n, cfg, ctx }) {
  const tol = Math.max(atr * cfg.clusterAtr, price * 0.002);
  const zones = [];
  const refW = 3;
  for (const side of [-1, 1]) {
    const cl = clusterByPrice(levels.filter((x) => x.side === side), tol);
    for (const c of cl) {
      const wSum = c.items.reduce((a, x) => a + x.w, 0);
      const anchors = [...new Set(c.items.map((x) => x.anchor))];
      const levs = [...new Set(c.items.map((x) => x.lev))];
      const rels = anchors.map((a) => a.rel).filter(isNum);
      const avgRel = rels.length ? rels.reduce((a, x) => a + x, 0) / rels.length : null;
      const rec = anchors.reduce((a, x) => a + x.rec, 0) / anchors.length;
      const lo = c.lo, hi = c.hi, mid = (lo + hi) / 2;
      // has price come back to test the anchors' area without consuming the level? (untested = still clean)
      const comps = [];
      const add = (key, name, points, max, note, available = true) => comps.push({ key, name, points: available ? round1(clamp(points, 0, max)) : 0, max, note, available });
      add("anchors", "Anchor density", (25 * wSum) / refW, 25, `${anchors.length} price anchors (swing highs/lows, high-volume candles), weighted ${wSum.toFixed(2)}`);
      add("volume", "Volume at anchors", avgRel === null ? 0 : (15 * (avgRel - 1)) / 2, 15, avgRel === null ? "UNAVAILABLE — no volume baseline" : `anchors traded at ${avgRel.toFixed(1)}× average volume`, avgRel !== null);
      add("tiers", "Leverage-tier coverage", (10 * levs.length) / cfg.leverages.length, 10, `${levs.length}/${cfg.leverages.length} assumed leverage tiers (${levs.sort((a, b) => a - b).join("x, ")}x) land here`);
      add("recency", "Recency", 15 * rec, 15, `average anchor recency weight ${rec.toFixed(2)}`);
      // OI: rising OI while price rose supports "longs built up"; while price fell "shorts built up"
      if (ctx.oiChg !== null) {
        const buildUp = ctx.oiChg >= cfg.oiMinPct;
        const aligned = side === -1 ? ctx.priceChg >= 0 : ctx.priceChg <= 0;
        add("oi", "Open-interest context", buildUp ? (aligned ? 15 : 8) : 3, 15, `OI ${ctx.oiChg >= 0 ? "+" : ""}${ctx.oiChg.toFixed(1)}% over the loaded period${buildUp ? (aligned ? ` while price ${side === -1 ? "rose" : "fell"} — positions on this side likely built up` : " (direction does not match this side)") : " — little new positioning"}`);
      } else add("oi", "Open-interest context", 0, 15, "UNAVAILABLE — open-interest history not loaded", false);
      if (ctx.funding !== null) {
        const f = ctx.funding;
        const crowd = side === -1 ? f : -f;
        const pts = crowd >= cfg.fundExt * 0.4 ? 10 : crowd > 0 ? 5 : 0;
        add("funding", "Funding skew", pts, 10, `funding ${(f * 100).toFixed(4)}% → ${side === -1 ? "longs" : "shorts"} ${crowd > 0 ? "are paying (crowded side)" : "are not the crowded side"}`);
      } else add("funding", "Funding skew", 0, 10, "UNAVAILABLE — funding not loaded", false);
      add("fresh", "Untouched since anchors", 10, 10, "no candle has traded through this level (consumed levels are removed)");
      const raw = comps.reduce((a, x) => a + x.points, 0);
      const maxPossible = comps.filter((x) => x.available).reduce((a, x) => a + x.max, 0);
      const strength = Math.round(clamp(raw, 0, 100));
      const dist = distanceInfo({ lo, hi }, price);
      zones.push({
        id: zoneId(symbol, tf, LIQ_KIND.ESTIMATED, side === 1 ? 1 : -1, mid),
        kind: LIQ_KIND.ESTIMATED, symbol, tf,
        side: side === 1 ? "above" : "below", // where the zone sits relative to price
        dir: side === 1 ? "SHORT LIQUIDATIONS (estimated)" : "LONG LIQUIDATIONS (estimated)",
        label: "Estimated Liquidation Zone",
        lo, hi, mid, strength, maxPossible, comps,
        evidence: [
          `Model estimate, not observed: positions opened near ${anchors.length} anchor prices at ${levs.join("/")}x leverage would be liquidated here`,
          `${side === 1 ? "Shorts" : "Longs"} would be forced to close if price reaches ${lo.toPrecision(6)}–${hi.toPrecision(6)}`,
        ],
        distAbs: dist.abs, distPct: dist.pct,
        invalidation: { level: side === 1 ? hi : lo, text: side === 1 ? `Treated as consumed once a candle trades above ${hi.toPrecision(6)}` : `Treated as consumed once a candle trades below ${lo.toPrecision(6)}` },
        source: "ESTIMATE", t: ctx.now,
        parts: { anchors: anchors.length, tiers: levs, weight: round1(wSum) },
      });
    }
  }
  return zones;
}

// --------------------------------------------------------- liquidity pools

// Equal highs / equal lows / swing highs / swing lows where resting stop orders are ASSUMED.
function liquidityPools({ symbol, tf, pivots, start, closed, forming, price, atr, cfg, rel, ctx }) {
  const n = closed.length;
  const tol = Math.max(atr * cfg.equalTolAtr, price * 0.0008);
  const out = [];
  const half = Math.max(10, (n - start) / 2);
  for (const side of [1, -1]) {
    const list = (side === 1 ? pivots.highs : pivots.lows).filter((p) => p.i >= start).map((p) => ({ i: p.i, price: p.price }));
    const cl = clusterByPrice(list, tol);
    for (const c of cl) {
      const touches = c.items.length;
      const lastIdx = Math.max(...c.items.map((x) => x.i));
      const level = side === 1 ? c.hi : c.lo;
      const buf = cfg.sweepBufferAtr * atr;
      // swept = a later candle traded beyond the level
      let sweptAt = null;
      for (let j = lastIdx + 1; j < n; j++) {
        if (side === 1 ? closed[j].h > level + buf : closed[j].l < level - buf) { sweptAt = j; break; }
      }
      if (sweptAt === null && forming && (side === 1 ? forming.h > level + buf : forming.l < level - buf)) sweptAt = n; // forming candle
      const lo = side === 1 ? c.lo : c.lo - 0, hi = c.hi;
      const mid = (lo + hi) / 2;
      const comps = [];
      const add = (key, name, points, max, note, available = true) => comps.push({ key, name, points: available ? round1(clamp(points, 0, max)) : 0, max, note, available });
      add("touches", "Equal / repeated highs-lows", touches >= 2 ? 15 + Math.min(20, (touches - 2) * 10) : 8, 35, touches >= 2 ? `${touches} swing ${side === 1 ? "highs" : "lows"} within ${cfg.equalTolAtr} ATR (equal ${side === 1 ? "highs" : "lows"})` : `single confirmed swing ${side === 1 ? "high" : "low"}`);
      const rec = Math.pow(0.5, (n - 1 - lastIdx) / half);
      add("recency", "Recency", 20 * rec, 20, `last touch ${n - 1 - lastIdx} candles ago`);
      add("untested", "Not yet swept", sweptAt === null ? 25 : 0, 25, sweptAt === null ? "no candle has traded beyond this level yet" : "already traded through — liquidity likely taken");
      const rv = c.items.map((x) => rel[x.i]).filter(isNum);
      const avgRel = rv.length ? rv.reduce((a, x) => a + x, 0) / rv.length : null;
      add("volume", "Volume at the swing", avgRel === null ? 0 : (10 * (avgRel - 0.8)) / 1.7, 10, avgRel === null ? "UNAVAILABLE — no volume baseline" : `${avgRel.toFixed(1)}× average volume at the swing`, avgRel !== null);
      const dAtr = Math.abs(level - price) / atr;
      add("near", "Proximity", dAtr <= 3 ? 10 : dAtr <= 6 ? 5 : 0, 10, `${dAtr.toFixed(1)} ATR from price`);
      const raw = comps.reduce((a, x) => a + x.points, 0);
      const maxPossible = comps.filter((x) => x.available).reduce((a, x) => a + x.max, 0);
      const dist = distanceInfo({ lo, hi }, price);
      out.push({
        id: zoneId(symbol, tf, LIQ_KIND.LIQUIDITY, side, mid),
        kind: LIQ_KIND.LIQUIDITY, symbol, tf,
        side: hi < price ? "below" : lo > price ? "above" : "inside",
        dir: side === 1 ? "BUY-SIDE LIQUIDITY" : "SELL-SIDE LIQUIDITY",
        label: touches >= 2 ? `Liquidity pool — equal ${side === 1 ? "highs" : "lows"}` : `Liquidity pool — swing ${side === 1 ? "high" : "low"}`,
        poolSide: side, level, lo, hi, mid, lastIdx, touches,
        strength: Math.round(clamp(raw, 0, 100)), maxPossible, comps,
        swept: sweptAt !== null ? sweptAt : null,
        evidence: [
          `Stop orders are ASSUMED to rest ${side === 1 ? "above these highs (shorts' stops, breakout buy orders)" : "below these lows (longs' stops, breakdown sell orders)"} — not observed`,
          touches >= 2 ? `${touches} touches formed an equal ${side === 1 ? "high" : "low"} (${c.items.map((x) => "#" + x.i).join(", ")})` : "single confirmed swing point",
        ],
        distAbs: dist.abs, distPct: dist.pct,
        invalidation: { level, text: side === 1 ? `Liquidity is taken (and the idea fails) once price closes and holds above ${level.toPrecision(6)}` : `Liquidity is taken (and the idea fails) once price closes and holds below ${level.toPrecision(6)}` },
        source: "DERIVED", t: ctx.now,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------- observed events

// events: [{ t, symbol, side: "SELL"|"BUY", price, qty, notional }]; SELL = a LONG was liquidated.
export function observedZones({ symbol, tf, events, price, atr, cfg, now }) {
  const ev = (events || []).filter((e) => e && e.symbol === symbol && isNum(e.price) && isNum(e.notional));
  if (!ev.length) return [];
  const tol = Math.max(atr * cfg.clusterAtr, price * 0.002);
  const zones = [];
  const groups = [];
  for (const side of ["SELL", "BUY"]) {
    clusterByPrice(ev.filter((e) => e.side === side), tol).forEach((c) => groups.push({ side, c }));
  }
  const maxN = Math.max(...groups.map((g) => g.c.items.reduce((a, e) => a + e.notional, 0)));
  for (const { side, c } of groups) {
    const notional = c.items.reduce((a, e) => a + e.notional, 0);
    const count = c.items.length;
    const lastT = Math.max(...c.items.map((e) => e.t));
    const firstT = Math.min(...c.items.map((e) => e.t));
    const comps = [];
    const add = (key, name, points, max, note) => comps.push({ key, name, points: round1(clamp(points, 0, max)), max, note, available: true });
    add("notional", "Liquidated notional", (50 * notional) / maxN, 50, `${fmtUsd(notional)} liquidated here (largest cluster = 100%)`);
    add("count", "Number of events", Math.min(count, 5) * 5, 25, `${count} liquidation order(s)`);
    add("recency", "Recency", 25 * Math.pow(0.5, (now - lastT) / (60 * 60_000)), 25, `latest event ${Math.round((now - lastT) / 60000)} min ago`);
    const lo = c.lo, hi = c.hi, mid = (lo + hi) / 2;
    const dist = distanceInfo({ lo, hi }, price);
    zones.push({
      id: zoneId(symbol, tf, LIQ_KIND.OBSERVED, side === "BUY" ? 1 : -1, mid),
      kind: LIQ_KIND.OBSERVED, symbol, tf,
      side: hi < price ? "below" : lo > price ? "above" : "inside",
      dir: side === "SELL" ? "LONG LIQUIDATIONS (observed)" : "SHORT LIQUIDATIONS (observed)",
      label: "Observed liquidation cluster",
      lo, hi, mid, strength: Math.round(comps.reduce((a, x) => a + x.points, 0)), maxPossible: 100, comps,
      evidence: [`${count} real liquidation order(s) received on Binance's public stream, ${fmtUsd(notional)} in total`, `first ${new Date(firstT).toLocaleTimeString()} · last ${new Date(lastT).toLocaleTimeString()} (only since this page was opened)`],
      distAbs: dist.abs, distPct: dist.pct,
      invalidation: { level: null, text: "Historical event — it describes where liquidations already happened, not where they will happen" },
      source: "OBSERVED", t: lastT, parts: { count, notional },
    });
  }
  return zones;
}
export function fmtUsd(v) {
  if (!isNum(v)) return "UNAVAILABLE";
  if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
  return "$" + v.toFixed(0);
}

// ----------------------------------------------------------- order-book walls

export function depthWalls({ symbol, tf, depth, price, atr, cfg, now }) {
  if (!depth || !Array.isArray(depth.bids) || !Array.isArray(depth.asks)) return [];
  const parse = (arr) => arr.map((x) => ({ price: parseFloat(x[0]), qty: parseFloat(x[1]) })).filter((x) => isNum(x.price) && isNum(x.qty) && x.price > 0 && x.qty > 0).map((x) => ({ ...x, usd: x.price * x.qty }));
  const bids = parse(depth.bids), asks = parse(depth.asks);
  const all = [...bids, ...asks];
  if (all.length < 20) return [];
  const sorted = all.map((x) => x.usd).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  if (!(med > 0)) return [];
  const range = price * (cfg.depthRangePct / 100);
  const tol = Math.max(atr * 0.15, price * 0.0005);
  const out = [];
  for (const [list, side] of [[bids, -1], [asks, 1]]) {
    const big = list.filter((x) => x.usd >= med * cfg.wallMult && x.usd >= cfg.wallMinUsd && Math.abs(x.price - price) <= range).map((x) => ({ price: x.price, usd: x.usd }));
    clusterByPrice(big, tol).forEach((c) => {
      const usd = c.items.reduce((a, x) => a + x.usd, 0);
      const lo = c.lo, hi = c.hi, mid = (lo + hi) / 2;
      const times = usd / med;
      const dist = distanceInfo({ lo, hi }, price);
      out.push({
        id: zoneId(symbol, tf, LIQ_KIND.DEPTH, side, mid),
        kind: LIQ_KIND.DEPTH, symbol, tf, side: side === 1 ? "above" : "below",
        dir: side === 1 ? "ORDER-BOOK SELL WALL" : "ORDER-BOOK BUY WALL",
        label: "Order-book wall (snapshot)",
        lo, hi, mid, strength: Math.round(clamp((100 * times) / (cfg.wallMult * 5), 5, 100)), maxPossible: 100,
        comps: [{ key: "wall", name: "Wall size vs typical level", points: Math.round(clamp((100 * times) / (cfg.wallMult * 5), 5, 100)), max: 100, note: `${fmtUsd(usd)} resting = ${times.toFixed(0)}× the median book level`, available: true }],
        evidence: [`Resting limit orders worth ${fmtUsd(usd)} at ${lo.toPrecision(6)}–${hi.toPrecision(6)} in the order-book snapshot`, "Orders can be cancelled or spoofed at any time — this is not a liquidation level"],
        distAbs: dist.abs, distPct: dist.pct,
        invalidation: { level: null, text: "The wall disappears or is traded through" },
        source: "OFFICIAL", t: depth.at || now, parts: { usd },
      });
    });
  }
  return out;
}

// ------------------------------------------------------------------ heat bins

// Price-binned intensity of the (unconsumed) estimated liquidation levels, 0..1 per side.
export function heatBins(levels, price, atr, range = null) {
  if (!levels.length) return [];
  const size = Math.max(atr * 0.25, price * 0.0005);
  const m = new Map();
  for (const lv of levels) {
    const b = Math.floor(lv.price / size);
    const e = m.get(b) || { lo: b * size, hi: (b + 1) * size, v: 0, side: lv.side };
    e.v += lv.w;
    m.set(b, e);
  }
  let arr = [...m.values()];
  if (range) arr = arr.filter((x) => x.hi >= range[0] && x.lo <= range[1]);
  const mx = Math.max(...arr.map((x) => x.v), 0);
  return mx > 0 ? arr.map((x) => ({ ...x, v: x.v / mx })) : [];
}

// -------------------------------------------------------------- event detection

function oiChangeOver(oiSeries, k) {
  if (!oiSeries || oiSeries.length < k + 1) return null;
  const v = oiSeries.filter(isNum);
  if (v.length < k + 1) return null;
  return pctChange(v[v.length - 1], v[v.length - 1 - k]);
}

const EV = {
  SWEEP_BUY: "BUY-SIDE LIQUIDITY SWEEP",
  SWEEP_SELL: "SELL-SIDE LIQUIDITY SWEEP",
  BREAKOUT_HOLD: "BREAKOUT HOLDING",
  BREAKDOWN_HOLD: "BREAKDOWN HOLDING",
  FALSE_BREAK: "FALSE BREAKOUT / BREAKDOWN",
  FALSE_RISK: "FALSE-BREAKOUT RISK",
  SQUEEZE: "POSSIBLE SHORT SQUEEZE",
  CASCADE: "POSSIBLE LONG-LIQUIDATION CASCADE",
};
export const LIQ_EVENT = EV;

export function detectEvents({ frame, pools, price, atr, cfg, ctx, rel, observed, now }) {
  const closed = frame.closed;
  const n = closed.length;
  const buf = cfg.sweepBufferAtr * atr;
  const events = [];
  const missing = [];
  const from = Math.max(0, n - cfg.eventBars);
  const candleEvidence = (j) => {
    const c = closed[j];
    const ev = [];
    const r = rel[j];
    if (isNum(r)) ev.push(`volume ${r.toFixed(1)}× average`);
    if (isNum(c.tb) && c.v > 0) ev.push(`taker buy share ${(100 * c.tb / c.v).toFixed(0)}%`);
    return ev;
  };
  const oi3 = ctx.oiChg3;
  for (const z of pools) {
    const side = z.poolSide; // 1 = buy-side (highs), -1 = sell-side (lows)
    const level = z.level;
    let found = null;
    for (let j = Math.max(z.lastIdx + 1, from); j < n; j++) {
      const c = closed[j];
      const beyond = side === 1 ? c.h - level : level - c.l;
      if (beyond <= buf) continue;
      const closeBeyond = side === 1 ? c.c > level + buf : c.c < level - buf;
      const wick = beyond / atr;
      if (!closeBeyond && wick >= cfg.sweepWickAtr) {
        if (found && found.kind === "false" && j <= found.back) continue; // the candle that closed back inside is part of the false breakout
        found = { kind: "sweep", j, wick };
      } else if (closeBeyond && !(j > 0 && (side === 1 ? closed[j - 1].c > level + buf : closed[j - 1].c < level - buf))) {
        // first close beyond the level in this run (later closes are continuation, not a new break)
        const after = closed.slice(j + 1);
        const back = after.findIndex((x) => (side === 1 ? x.c <= level : x.c >= level));
        if (back >= 0) found = { kind: "false", j, back: j + 1 + back };
        else if (after.length >= cfg.holdBars) found = { kind: "hold", j, bars: after.length };
        else found = { kind: "break-pending", j, bars: after.length };
      }
    }
    const base = { zoneId: z.id, level, side, touches: z.touches };
    if (found && found.kind === "sweep") {
      const ev = [`wick ${found.wick.toFixed(2)} ATR beyond ${level.toPrecision(6)}, close back inside`, ...candleEvidence(found.j), `${z.touches >= 2 ? "equal " : ""}${side === 1 ? "highs" : "lows"} pool: ${z.touches} touch(es)`];
      const conf = [];
      if (oi3 !== null) ev.push(`OI ${oi3 >= 0 ? "+" : ""}${oi3.toFixed(1)}% over 3 periods`); else missing.push("open interest");
      const rj = rel[found.j];
      if (isNum(rj) && rj < 1) conf.push("sweep candle volume was below average");
      events.push({ ...base, type: side === 1 ? EV.SWEEP_BUY : EV.SWEEP_SELL, state: "CONFIRMED", i: found.j, t: closed[found.j].t, barsAgo: n - 1 - found.j, evidence: ev, conflicting: conf, implication: side === 1 ? "Buy-side liquidity was taken and price closed back below the level — bearish if it holds" : "Sell-side liquidity was taken and price closed back above the level — bullish if it holds" });
    } else if (found && found.kind === "false") {
      events.push({ ...base, type: EV.FALSE_BREAK, state: "CONFIRMED", i: found.j, t: closed[found.j].t, barsAgo: n - 1 - found.j, evidence: [`a close ${side === 1 ? "above" : "below"} ${level.toPrecision(6)} was reversed by a later close back inside`, ...candleEvidence(found.j)], conflicting: [], implication: side === 1 ? "Failed breakout — trapped longs, bearish evidence" : "Failed breakdown — trapped shorts, bullish evidence" });
    } else if (found && found.kind === "hold") {
      const rj = rel[found.j];
      const ev = [`${found.bars + 1} closes ${side === 1 ? "above" : "below"} ${level.toPrecision(6)}`, ...candleEvidence(found.j)];
      const conf = [];
      if (isNum(rj) && rj < cfg.breakVol) conf.push(`breakout volume ${rj.toFixed(1)}× is below the ${cfg.breakVol}× threshold`);
      if (oi3 !== null && oi3 < 0) conf.push(`open interest fell ${oi3.toFixed(1)}% — move may be position closing, not new commitment`);
      if (oi3 === null) missing.push("open interest");
      events.push({ ...base, type: side === 1 ? EV.BREAKOUT_HOLD : EV.BREAKDOWN_HOLD, state: "CONFIRMED", i: found.j, t: closed[found.j].t, barsAgo: n - 1 - found.j, evidence: ev, conflicting: conf, implication: "Level has been accepted on closes; a retest that holds would strengthen it" });
      if (conf.length) events.push({ ...base, type: EV.FALSE_RISK, state: "POTENTIAL", i: found.j, t: closed[found.j].t, barsAgo: n - 1 - found.j, evidence: conf, conflicting: [], implication: "Close beyond the level lacks volume/OI confirmation — higher false-breakout risk" });
    } else if (found && found.kind === "break-pending") {
      events.push({ ...base, type: side === 1 ? EV.BREAKOUT_HOLD : EV.BREAKDOWN_HOLD, state: "POTENTIAL", i: found.j, t: closed[found.j].t, barsAgo: n - 1 - found.j, evidence: [`closed ${side === 1 ? "above" : "below"} ${level.toPrecision(6)}; needs ${cfg.holdBars} closes to count as holding (${found.bars} so far)`, ...candleEvidence(found.j)], conflicting: [], implication: "Not confirmed yet" });
    }
    // live price beyond the level on the still-forming candle: potential only
    if (frame.forming && isNum(price)) {
      const liveBeyond = side === 1 ? price > level + buf : price < level - buf;
      const already = events.some((e) => e.zoneId === z.id && e.barsAgo === 0);
      if (liveBeyond && !already && z.swept === n) {
        events.push({ ...base, type: side === 1 ? EV.SWEEP_BUY : EV.SWEEP_SELL, state: "POTENTIAL", i: n, t: frame.forming.t, barsAgo: -1, evidence: [`price ${price.toPrecision(6)} is ${side === 1 ? "above" : "below"} ${level.toPrecision(6)} right now, on a candle that has not closed`], conflicting: ["a sweep only counts after a candle closes back inside the range"], implication: "Potential sweep or breakout — wait for the candle close" });
      }
    }
  }
  // squeeze / cascade: never from price alone
  const obsWin = (observed || []).filter((e) => now - e.t <= cfg.obsWindowMs);
  const obsBuy = obsWin.filter((e) => e.side === "BUY").reduce((a, e) => a + e.notional, 0); // shorts liquidated
  const obsSell = obsWin.filter((e) => e.side === "SELL").reduce((a, e) => a + e.notional, 0); // longs liquidated
  const haveObs = observed !== null && observed !== undefined;
  const recentBreak = (side) => pools.find((z) => z.poolSide === side && z.swept !== null && z.swept >= n - 6 && z.swept < n && (side === 1 ? closed[n - 1].c > z.level : closed[n - 1].c < z.level));
  const up = recentBreak(1), dn = recentBreak(-1);
  const assess = { squeeze: null, cascade: null };
  if (up) {
    const evs = [`price closed above the buy-side pool at ${up.level.toPrecision(6)}`];
    const supports = [];
    if (oi3 !== null && oi3 <= -cfg.oiMinPct) supports.push(`open interest fell ${oi3.toFixed(1)}% while price rose (shorts closing)`);
    if (ctx.funding !== null && ctx.funding < 0) supports.push(`funding is negative (${(ctx.funding * 100).toFixed(4)}%) — shorts are the paying/crowded side`);
    const share = ctx.takerShare;
    if (share !== null && share >= 0.55) supports.push(`taker buy share ${(100 * share).toFixed(0)}%`);
    const obsOk = haveObs && obsBuy >= cfg.obsMinUsd;
    if (obsOk) supports.push(`${fmtUsd(obsBuy)} of SHORT liquidations observed on the public stream in the last ${Math.round(cfg.obsWindowMs / 60000)} min`);
    const oiRising = oi3 !== null && oi3 >= cfg.oiMinPct;
    if (oi3 === null && !obsOk) { assess.squeeze = "UNAVAILABLE — needs open-interest history or observed liquidations; price movement alone is not enough"; missing.push("open interest"); }
    else if ((oi3 !== null && oi3 <= -cfg.oiMinPct) || obsOk) {
      events.push({ zoneId: up.id, level: up.level, side: 1, type: EV.SQUEEZE, state: obsOk ? "CONFIRMED" : "POTENTIAL", i: n - 1, t: closed[n - 1].t, barsAgo: 0, evidence: [...evs, ...supports], conflicting: [], implication: obsOk ? "Short liquidations were actually observed while price pushed through the pool" : "Falling OI during the rise is consistent with shorts closing — not proof of liquidations" });
    } else assess.squeeze = oiRising ? "Not flagged — open interest rose with the move (new longs, not short covering)" : "Not flagged — no OI drop or observed short liquidations";
  }
  if (dn) {
    const evs = [`price closed below the sell-side pool at ${dn.level.toPrecision(6)}`];
    const supports = [];
    if (oi3 !== null && oi3 <= -cfg.oiMinPct) supports.push(`open interest fell ${oi3.toFixed(1)}% during the drop (positions closing or liquidated)`);
    const obsOk = haveObs && obsSell >= cfg.obsMinUsd;
    if (obsOk) supports.push(`${fmtUsd(obsSell)} of LONG liquidations observed on the public stream in the last ${Math.round(cfg.obsWindowMs / 60000)} min`);
    if (ctx.funding !== null && ctx.funding > cfg.fundExt * 0.4) supports.push(`funding is positive (${(ctx.funding * 100).toFixed(4)}%) — longs were the crowded side`);
    if (oi3 === null && !obsOk) { assess.cascade = "UNAVAILABLE — needs open-interest history or observed liquidations; price movement alone is not enough"; missing.push("open interest"); }
    else if ((oi3 !== null && oi3 <= -cfg.oiMinPct) || obsOk) {
      events.push({ zoneId: dn.id, level: dn.level, side: -1, type: EV.CASCADE, state: obsOk ? "CONFIRMED" : "POTENTIAL", i: n - 1, t: closed[n - 1].t, barsAgo: 0, evidence: [...evs, ...supports], conflicting: obsOk ? [] : ["no observed liquidation orders — the OI drop could also be voluntary closing"], implication: obsOk ? "Long liquidations were actually observed while price broke the pool" : "Falling OI during the drop is consistent with long liquidation — not proof" });
    } else assess.cascade = "Not flagged — no OI drop or observed long liquidations";
  }
  events.sort((a, b) => (a.state === b.state ? a.barsAgo - b.barsAgo : a.state === "CONFIRMED" ? -1 : 1));
  return { events, missing: [...new Set(missing)], assess };
}

// ----------------------------------------------------------------- trade plans

// Candidate scenarios for a selected zone. Planning aid only — never an order.
export function planForZone(zone, { price, atr, zones = [], frames = {}, settings = {}, events = [] }) {
  const cfg = { ...LIQ_DEFAULTS, ...settings };
  if (!zone || !isNum(price) || !(atr > 0)) return { scenarios: [], warnings: ["No zone or price/ATR unavailable"] };
  const cost = { feePct: cfg.feePct, slippagePct: cfg.slippagePct };
  const above = zone.mid > price;
  const dist = distanceInfo(zone, price);
  const warnings = [];
  const distAtr = dist.abs !== null ? dist.abs / atr : null;
  if (distAtr !== null && (distAtr > cfg.maxDistanceAtr || dist.pct > cfg.maxDistancePct)) warnings.push(`Zone is ${distAtr.toFixed(1)} ATR (${dist.pct.toFixed(1)}%) away — entry is too far for a near-term plan`);
  const trend = (tf) => (frames[tf] ? trendFromFrame(frames[tf]) : null);
  const t4 = trend("4h"), t1d = trend("1d");
  const hasEvent = (type) => events.some((e) => e.zoneId === zone.id && e.type === type && e.state === "CONFIRMED");
  const others = zones.filter((z) => z.id !== zone.id && z.kind !== LIQ_KIND.OBSERVED);
  const nextTargets = (dir, from) => {
    const cand = others
      .map((z) => ({ price: dir === 1 ? z.lo : z.hi, z }))
      .filter((x) => (dir === 1 ? x.price > from : x.price < from))
      .sort((a, b) => (dir === 1 ? a.price - b.price : b.price - a.price));
    return cand;
  };
  const scenarios = [];
  const mk = (name, dir, entry, stop, trigger, readyType) => {
    const risk = Math.abs(entry - stop);
    const sc = { name, side: dir === 1 ? "LONG" : "SHORT", dir, entry, stop, trigger, targets: [], warnings: [], ready: readyType ? hasEvent(readyType) : false };
    const zt = nextTargets(dir, entry).filter((x) => Math.abs(x.price - entry) >= risk * 1.0);
    const atrT = [1.5, 2.5, 4].map((m, i) => ({ label: `TP${i + 1}`, price: entry + dir * atr * m, basis: `${m} ATR (volatility-based)` }));
    const picks = [];
    zt.slice(0, 3).forEach((x, i) => picks.push({ label: `TP${i + 1}`, price: x.price, basis: `next ${x.z.label.toLowerCase()} (${x.z.kind})` }));
    atrT.forEach((t) => picks.length < 3 && !picks.some((p) => Math.abs(p.price - t.price) < atr * 0.3) && picks.push({ ...t, label: `TP${picks.length + 1}` }));
    sc.targets = picks.slice(0, 3).sort((a, b) => (dir === 1 ? a.price - b.price : b.price - a.price)).map((t, i) => ({ ...t, label: `TP${i + 1}`, rr: rrNet(entry, stop, t.price, cost) }));
    sc.rr = sc.targets.length ? sc.targets[0].rr : null;
    if (sc.rr !== null && sc.rr < 1) sc.warnings.push(`TP1 net R:R ${sc.rr.toFixed(2)} after ${cfg.feePct}% fee and ${cfg.slippagePct}% slippage per side — below 1`);
    const tr = t4 && t4.dir !== 0 ? t4 : null;
    if (tr && tr.dir === -dir) sc.warnings.push(`Conflicts with the 4H trend (${tr.label})`);
    if (t1d && t1d.dir === -dir && t1d.dir !== 0) sc.warnings.push(`Conflicts with the daily trend (${t1d.label})`);
    return sc;
  };
  const buf = 0.35 * atr;
  if (above) {
    scenarios.push(mk("Reversal after a buy-side sweep", -1, zone.hi, zone.hi + Math.max(buf, 0.5 * atr), `A candle trades above ${zone.hi.toPrecision(6)} and CLOSES back below it, then price retests the level`, EV.SWEEP_BUY));
    scenarios.push(mk("Breakout that holds", 1, zone.hi, zone.lo - buf, `Two candle closes above ${zone.hi.toPrecision(6)} on volume, then a retest that holds`, EV.BREAKOUT_HOLD));
  } else {
    scenarios.push(mk("Reversal after a sell-side sweep", 1, zone.lo, zone.lo - Math.max(buf, 0.5 * atr), `A candle trades below ${zone.lo.toPrecision(6)} and CLOSES back above it, then price retests the level`, EV.SWEEP_SELL));
    scenarios.push(mk("Breakdown that holds", -1, zone.lo, zone.hi + buf, `Two candle closes below ${zone.lo.toPrecision(6)} on volume, then a retest that fails`, EV.BREAKDOWN_HOLD));
  }
  scenarios.forEach((s) => {
    s.distAtr = Math.abs(s.entry - price) / atr;
    s.invalidation = `A close beyond the stop at ${s.stop.toPrecision(6)} invalidates this idea`;
  });
  if (zone.kind === LIQ_KIND.ESTIMATED) warnings.push("This zone is an ESTIMATE from a model, not observed liquidations");
  if (zone.kind === LIQ_KIND.DEPTH) warnings.push("Order-book walls can be cancelled; do not treat as a firm level");
  warnings.push("Targets and stops are candidate levels from this strategy's rules — they are not guaranteed and nothing is traded for you");
  return { scenarios, warnings, trend4h: t4, trend1d: t1d, distAtr };
}

// ---------------------------------------------------------------- main entry

// frame: analyzeFrame() output for `tf`. market: { mark, index, fundingRate, nextFundingTime, depth, at } | null.
// ext: derivExt for this timeframe's period | null. observed: events | null (null = stream not connected).
export function buildLiquidityMap({ symbol, tf, frame, frames = {}, market = null, lastPrice = null, ext = null, observed = null, settings = {}, ages = {}, now = Date.now() }) {
  const cfg = { ...LIQ_DEFAULTS, ...settings, leverageWeights: { ...LIQ_DEFAULTS.leverageWeights, ...(settings.leverageWeights || {}) } };
  const res = { symbol, tf, ok: false, state: "INSUFFICIENT", reason: "", zones: [], events: [], heat: [], assumptions: [], flags: [], cfg, evaluatedAt: now };
  if (!frame || !frame.ok || !frame.closed || frame.closed.length < 40) {
    res.reason = !frame ? `${tf} candles not loaded` : `Only ${frame.closed ? frame.closed.length : 0} closed ${tf} candles (need ≥ 40)`;
    return res;
  }
  const age = Math.max(ages[tf] ?? 0, ages.mark ?? 0);
  if (age > cfg.deadMs) {
    res.state = "STALE";
    res.reason = `Market data is ${Math.round(age / 60000)} min old — no zones are issued`;
    res.ageMs = age;
    return res;
  }
  const closed = frame.closed;
  const n = closed.length;
  const atr = frame.atr;
  const markOk = market && isNum(market.mark) && market.mark > 0;
  const lastOk = isNum(lastPrice) && lastPrice > 0;
  const price = markOk ? market.mark : lastOk ? lastPrice : frame.price;
  res.price = price;
  res.priceSource = markOk ? "OFFICIAL mark price" : lastOk ? "OFFICIAL last price (24h ticker) — mark price UNAVAILABLE" : "last closed candle (mark price UNAVAILABLE)";
  res.atr = atr;
  res.ageMs = age;
  res.stale = age > cfg.staleMs;
  if (res.stale) res.flags.push("STALE");
  const lookback = clamp(Math.round(cfg.lookback), 40, n);
  const start = n - lookback;
  const rel = relVolumes(closed);
  const k = tf === "5m" || tf === "15m" ? 2 : 3;
  const { anchors, pivots } = buildAnchors(closed, start, k, cfg, rel);
  // ---- context from derivatives (all optional)
  const oiSeries = ext && ext.oi ? ext.oi.map((x) => x.v).filter(isNum) : null;
  const oiChg = oiSeries && oiSeries.length >= 6 ? pctChange(oiSeries[oiSeries.length - 1], oiSeries[0]) : null;
  const oiChg3 = oiChangeOver(oiSeries, 3);
  const fRows = ext && ext.funding ? ext.funding.map((x) => x.rate).filter(isNum) : [];
  const funding = markOk && isNum(market.fundingRate) ? market.fundingRate : fRows.length ? fRows[fRows.length - 1] : null;
  const last = closed[n - 1];
  const prevWin = closed[Math.max(0, n - 1 - Math.min(30, n - 1))];
  const ctx = {
    now, oiChg, oiChg3, funding,
    priceChg: ((last.c - prevWin.c) / prevWin.c) * 100,
    takerShare: isNum(last.tb) && last.v > 0 ? last.tb / last.v : null,
    oiSeries,
  };
  if (oiChg === null) res.flags.push("OI UNAVAILABLE");
  if (funding === null) res.flags.push("FUNDING UNAVAILABLE");
  if (observed === null) res.flags.push("LIQUIDATION STREAM NOT CONNECTED");
  if (!market || !market.depth) res.flags.push("ORDER BOOK UNAVAILABLE");
  if (!markOk) res.flags.push("MARK PRICE UNAVAILABLE");
  // ---- zones
  const levels = estimateLevels(anchors, closed, frame.forming, price, cfg);
  const est = estimatedZones({ symbol, tf, levels, price, atr, n, cfg, ctx });
  const poolsAll = liquidityPools({ symbol, tf, pivots, start, closed, forming: frame.forming, price, atr, cfg, rel, ctx });
  const pools = poolsAll.filter((z) => z.swept === null);
  const obsZ = observed ? observedZones({ symbol, tf, events: observed, price, atr, cfg, now }) : [];
  const walls = market && market.depth ? depthWalls({ symbol, tf, depth: market.depth, price, atr, cfg, now }) : [];
  const keep = (list) => {
    const out = [];
    for (const side of ["above", "below", "inside"]) {
      list.filter((z) => z.side === side && z.strength >= cfg.minStrength).sort((a, b) => b.strength - a.strength).slice(0, cfg.maxZonesPerSide).forEach((z) => out.push(z));
    }
    return out;
  };
  res.zones = [...keep(est), ...keep(pools), ...obsZ, ...keep(walls)];
  res.heat = heatBins(levels, price, atr);
  res.levelsCount = levels.length;
  // ---- events (sweeps use ALL pools incl. already-swept ones)
  const ev = detectEvents({ frame, pools: poolsAll, price, atr, cfg, ctx, rel, observed, now });
  res.events = ev.events;
  res.eventsMissing = ev.missing;
  res.assess = ev.assess;
  // ---- context panels
  const vol24 = closed.slice(-Math.min(n, Math.round(86400000 / frame.tfMs))).reduce((a, c) => a + c.qv, 0);
  res.context = {
    mark: markOk ? market.mark : null, index: markOk && isNum(market.index) ? market.index : null,
    funding, nextFundingTime: market && market.nextFundingTime ? market.nextFundingTime : null,
    oiChg, oiChg3, oiSeries, takerShare: ctx.takerShare, relVol: rel[n - 1], volume24h: vol24,
    priceChg: ctx.priceChg, atrPct: (atr / price) * 100,
    trend4h: frames["4h"] ? trendFromFrame(frames["4h"]) : null,
  };
  res.nearest = {
    above: res.zones.filter((z) => z.side === "above").sort((a, b) => a.distAbs - b.distAbs)[0] || null,
    below: res.zones.filter((z) => z.side === "below").sort((a, b) => a.distAbs - b.distAbs)[0] || null,
  };
  res.assumptions = [
    `Anchors: confirmed swing highs/lows (k=${k}) and candles with volume ≥ ${cfg.volAnchorRel}× average, from the last ${lookback} ${tf} candles`,
    `Assumed leverage mix: ${cfg.leverages.map((L) => `${L}x ${Math.round((cfg.leverageWeights[L] ?? 0) * 100)}%`).join(", ")} (a guess — real positioning is not public)`,
    `Assumed maintenance-margin rate ${(cfg.mmr * 100).toFixed(2)}%: long liq ≈ P×(1−1/L+mmr), short liq ≈ P×(1+1/L−mmr)`,
    "Direction bias is a heuristic: anchors at lows / bullish candles lean long, at highs / bearish candles lean short",
    "A level is dropped once any later candle trades through it (those positions would already be liquidated)",
    `Zones are merged within ${cfg.clusterAtr} ATR; strength is a 0–100 heuristic ranking, not a probability`,
    "Liquidity pools assume resting stop orders at equal/swing highs and lows — they are not liquidation clusters",
    "Observed liquidations come only from Binance's public liquidation stream while this page is open; there is no public historical liquidation data",
  ];
  res.swings = [
    ...pivots.highs.filter((p) => p.i >= start).map((p) => ({ i: p.i, price: p.price, type: "high", t: closed[p.i].t })),
    ...pivots.lows.filter((p) => p.i >= start).map((p) => ({ i: p.i, price: p.price, type: "low", t: closed[p.i].t })),
  ].sort((a, b) => a.i - b.i);
  res.state = res.stale ? "STALE-WARNING" : "OK";
  res.ok = true;
  res.frame = { tf, n, lookback, start };
  return res;
}
