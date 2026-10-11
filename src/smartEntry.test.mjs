// Tests for the Smart Entry Zone engine.  node --test src/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { analyzeFrame, TF_MS, parseCandles, findPivots } from "./entryRadar.js";
import {
  SMART_STATUS as S, SMART_DEFAULTS, NO_VALID_ZONE, evaluateSmartEntry, buildSmartPlan, clusterLevels, qualifies,
  findSupplyDemand, latestLeg, anchoredVwap, positionSize, createStatusTracker, symbolCheck, scoreZone, smartSetupId,
} from "./smartEntry.js";
import { createRadarScanner } from "./radarScanner.js";

const NOW = Date.UTC(2026, 9, 11, 12, 7, 30); // mid-candle on purpose

function rng(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}
function raw(tf, n, closes, { vol = 1000, seed = 1, noise = 0.002, now = NOW } = {}) {
  const ms = TF_MS[tf];
  const lastOpen = Math.floor(now / ms) * ms;
  const r = rng(seed);
  const out = [];
  let prev = closes(0, n);
  for (let i = 0; i < n; i++) {
    const open = lastOpen - (n - 1 - i) * ms;
    const c = closes(i, n);
    const o = prev;
    const hi = Math.max(o, c) * (1 + r() * noise);
    const lo = Math.min(o, c) * (1 - r() * noise);
    const v = vol * (0.7 + r() * 0.6);
    out.push([open, String(o), String(hi), String(lo), String(c), String(v), open + ms - 1, String(v * c), 10, "0", "0", "0"]);
    prev = c;
  }
  return out;
}
// explicit candles: items are numbers (close) or {c,h,l,v,o}
function explicit(tf, items, { now = NOW, baseVol = 1000 } = {}) {
  const ms = TF_MS[tf];
  const n = items.length;
  const lastOpen = Math.floor(now / ms) * ms;
  let prev = typeof items[0] === "number" ? items[0] : items[0].c;
  return items.map((it, i) => {
    const d = typeof it === "number" ? { c: it } : it;
    const open = lastOpen - (n - 1 - i) * ms;
    const o = d.o ?? prev;
    const c = d.c;
    const h = d.h ?? Math.max(o, c) * 1.0005;
    const l = d.l ?? Math.min(o, c) * 0.9995;
    const v = d.v ?? baseVol;
    prev = c;
    return [open, String(o), String(h), String(l), String(c), String(v), open + ms - 1, String(v * c), 10, "0", "0", "0"];
  });
}
const zig = (a, b, amp, period, ph = 0) => (i, n) => {
  const base = a + ((b - a) * i) / (n - 1);
  return base * (1 + amp * Math.sin((2 * Math.PI * i) / period + ph));
};

const UP = {
  f4: analyzeFrame(raw("4h", 260, zig(100, 200, 0.02, 30), { seed: 3 }), NOW, "4h"),
  f1: analyzeFrame(raw("1h", 260, zig(150, 210, 0.03, 24), { seed: 4 }), NOW, "1h"),
};
const DOWN = {
  f4: analyzeFrame(raw("4h", 260, zig(200, 100, 0.02, 30), { seed: 3 }), NOW, "4h"),
  f1: analyzeFrame(raw("1h", 260, zig(210, 150, 0.03, 24, 2.5), { seed: 4 }), NOW, "1h"),
};
const flat15 = (p, n = 120) => analyzeFrame(explicit("15m", new Array(n).fill(p)), NOW, "15m");
const ages = (ms = 1000) => ({ "4h": 0, "1h": 0, "15m": 0, ticker: ms });
const liveAt = (p, over = {}) => ({ ticker: { lastPrice: String(p), priceChangePercent: "1", quoteVolume: "300000000" }, book: { bid: p * 0.99995, ask: p * 1.00005 }, ...over });
function run(set, f15, price, o = {}) {
  return evaluateSmartEntry({ symbol: "TESTUSDT", frames: { "4h": set.f4, "1h": set.f1, "15m": f15 }, live: o.live || liveAt(price), ages: o.ages || ages(), settings: o.settings, now: NOW });
}
// baseline to learn the zone geometry
const baseUp = run(UP, flat15(UP.f1.price), UP.f1.price);
const LP = baseUp.long.plan;
const baseDown = run(DOWN, flat15(DOWN.f1.price), DOWN.f1.price);
const SP = baseDown.short.plan;

test("baseline: uptrend gives a valid LONG zone below price; downtrend a valid SHORT zone above", () => {
  assert.ok(LP.valid, "long plan valid");
  assert.ok(LP.zone.hi <= UP.f1.price + UP.f1.atr * 0.25);
  assert.ok(LP.zone.families.length >= 2, "needs 2+ independent families");
  assert.ok(SP.valid, "short plan valid");
  assert.ok(SP.zone.lo >= DOWN.f1.price - DOWN.f1.atr * 0.25);
  assert.equal(baseUp.long.supported.ok, true);
  assert.equal(baseUp.short.supported.ok, false); // counter-trend short not supported by the 4H uptrend
  assert.equal(baseUp.short.status, S.NO_TRADE);
  assert.equal(baseDown.long.status, S.NO_TRADE);
});

test("LONG plan: zone/entry/invalidation/stop/targets ordered, stop beyond invalidation, entry inside zone", () => {
  assert.ok(LP.zone.lo < LP.zone.hi);
  assert.ok(LP.entry >= LP.zone.lo && LP.entry <= LP.zone.hi);
  assert.ok(LP.invalidation <= LP.zone.lo + 1e-9);
  assert.ok(LP.stop < LP.invalidation, "stop beyond invalidation");
  assert.ok(Math.abs(LP.entry - LP.stop) >= UP.f1.atr * 0.8 - 1e-9);
  assert.equal(LP.targets.length, 3);
  assert.ok(LP.entry < LP.targets[0].price && LP.targets[0].price < LP.targets[1].price && LP.targets[1].price < LP.targets[2].price);
  assert.ok(LP.rr1 < LP.rr2 && LP.rr2 < LP.rr3);
  assert.ok(LP.entryMethod.length > 20);
});

test("SHORT plan mirrored: stop above invalidation above entry, targets descending", () => {
  assert.ok(SP.entry >= SP.zone.lo && SP.entry <= SP.zone.hi);
  assert.ok(SP.invalidation >= SP.zone.hi - 1e-9);
  assert.ok(SP.stop > SP.invalidation);
  assert.ok(SP.entry > SP.targets[0].price && SP.targets[0].price > SP.targets[1].price && SP.targets[1].price > SP.targets[2].price);
});

test("fees and slippage lower net R:R; zero costs equal gross multiples", () => {
  const free = buildSmartPlan(1, { f1: UP.f1, f4: UP.f4, price: UP.f1.price, settings: { ...SMART_DEFAULTS, feePct: 0, slippagePct: 0 } });
  const heavy = buildSmartPlan(1, { f1: UP.f1, f4: UP.f4, price: UP.f1.price, settings: { ...SMART_DEFAULTS, feePct: 0.2, slippagePct: 0.2 } });
  assert.ok(free.rr2 > LP.rr2 && LP.rr2 > heavy.rr2);
  assert.ok(Math.abs(free.rr2 - free.targets[1].grossR) < 1e-9);
});

test("zone with no confluence -> NO VALID ZONE (never manufactured)", () => {
  // a smooth ramp has no confirmed swings, so no cluster can qualify
  const f1 = analyzeFrame(raw("1h", 260, (i, n) => 100 + i * 0.05, { seed: 9, noise: 0.0001 }), NOW, "1h");
  const f4 = analyzeFrame(raw("4h", 260, (i, n) => 100 + i * 0.2, { seed: 9, noise: 0.0001 }), NOW, "4h");
  const plan = buildSmartPlan(1, { f1, f4, price: f1.price, settings: SMART_DEFAULTS });
  assert.equal(plan.valid, false);
  assert.equal(plan.label, NO_VALID_ZONE);
  assert.equal(plan.zone, null);
  const r = run({ f4, f1 }, flat15(f1.price), f1.price);
  assert.equal(r.long.status, S.NO_TRADE);
  assert.equal(r.long.label, NO_VALID_ZONE);
});

test("clusterLevels counts each family once; EMA20/50/200 alone never qualify as a zone", () => {
  const pt = (p, name, w) => ({ lo: p, hi: p, family: "ema", source: name, weight: w });
  const cl = clusterLevels([pt(100, "e20", 1.5), pt(100.1, "e50", 2), pt(100.2, "e200", 2)], 0.5, 2);
  assert.equal(cl.length, 1);
  assert.deepEqual(cl[0].families, ["ema"]);
  assert.equal(cl[0].conf, 2); // heaviest member only, not 5.5
  assert.equal(qualifies(cl[0]), false);
  const mix = clusterLevels([pt(100, "e50", 2), { lo: 99.9, hi: 100.3, family: "sr", source: "s", weight: 3, touches: 2 }], 0.5, 2);
  assert.equal(mix[0].families.length, 2);
  assert.equal(qualifies(mix[0]), true);
  // a single strong (3+ touch) structural zone qualifies; a weak one does not
  assert.equal(qualifies(clusterLevels([{ lo: 1, hi: 1.1, family: "sr", weight: 3, touches: 3 }], 1, 5)[0]), true);
  assert.equal(qualifies(clusterLevels([{ lo: 1, hi: 1.1, family: "sr", weight: 3, touches: 2 }], 1, 5)[0]), false);
  // far apart levels are not averaged into one zone
  assert.equal(clusterLevels([pt(100, "a", 1), pt(110, "b", 1)], 0.5, 2).length, 2);
});

test("supply/demand: base candle + impulse found only when confirmed and unmitigated", () => {
  const candles = [];
  const mk = (o, h, l, c, i) => ({ t: i * 3600000, o, h, l, c, v: 100, ct: i * 3600000 + 3599999, qv: 1000 });
  for (let i = 0; i < 30; i++) candles.push(mk(100, 100.6, 99.4, 100.1, i)); // quiet
  candles.push(mk(100, 100.3, 99.7, 100.05, 30)); // base (small body)
  candles.push(mk(100.05, 103.5, 100, 103.4, 31)); // impulse up ~3.3
  for (let i = 32; i < 40; i++) candles.push(mk(103.4, 103.9, 103.0, 103.5, i));
  const sd = findSupplyDemand(candles, 1);
  assert.equal(sd.demand.length >= 1, true);
  const d = sd.demand[sd.demand.length - 1];
  assert.ok(Math.abs(d.lo - 99.7) < 1e-9 && Math.abs(d.hi - 100.05) < 1e-9);
  // mitigated: a later close below the zone removes it
  const mit = [...candles, mk(103.5, 103.5, 98, 98.5, 40), mk(98.5, 99, 98, 98.6, 41)];
  assert.equal(findSupplyDemand(mit, 1).demand.some((z) => z.idx === 30), false);
});

test("latestLeg / anchored VWAP use only confirmed swings and an explicit formula", () => {
  const leg = latestLeg(UP.f1, 1);
  assert.ok(leg && leg.size >= UP.f1.atr * 2);
  assert.ok(leg.anchor.i < leg.extreme.i);
  assert.ok(leg.extreme.i <= UP.f1.closed.length - 1 - 3, "swing confirmed: 3 candles to its right exist");
  const closed = [
    { h: 11, l: 9, c: 10, v: 100 }, { h: 12, l: 10, c: 11, v: 200 }, { h: 13, l: 11, c: 12, v: 300 }, { h: 13, l: 11, c: 12, v: 100 },
    { h: 13, l: 11, c: 12, v: 100 }, { h: 13, l: 11, c: 12, v: 100 }, { h: 13, l: 11, c: 12, v: 100 }, { h: 13, l: 11, c: 12, v: 100 },
  ];
  const tp = (c) => (c.h + c.l + c.c) / 3;
  const exp = closed.reduce((s, c) => s + tp(c) * c.v, 0) / closed.reduce((s, c) => s + c.v, 0);
  assert.ok(Math.abs(anchoredVwap(closed, 0) - exp) < 1e-12);
  assert.equal(anchoredVwap(closed.slice(0, 5), 0), null, "too few candles since the anchor -> UNAVAILABLE");
});

test("status: WAIT FOR ZONE when price is above a long zone", () => {
  const r = run(UP, flat15(UP.f1.price), UP.f1.price);
  assert.equal(r.long.status, S.WAIT_ZONE);
  assert.ok(["WAIT FOR PULLBACK", "WAIT FOR RETEST"].includes(r.long.hint));
});

test("status: IN ZONE — WAIT FOR CONFIRMATION when price is in the zone and no completed-candle trigger", () => {
  const r = run(UP, flat15(LP.entry), LP.entry);
  assert.equal(r.long.status, S.IN_ZONE);
  assert.equal(r.long.trigger.confirmed, false);
});

test("status: LONG TRIGGERED needs a COMPLETED 15m candle (swing break on volume, zone tested)", () => {
  const items = new Array(118).fill(LP.entry);
  items.push({ c: LP.entry * 1.004, v: 4000 }); // last CLOSED candle breaks above the prior highs
  items.push({ c: LP.entry * 1.004, v: 500 }); // forming candle
  const f15 = analyzeFrame(explicit("15m", items), NOW, "15m");
  const r = run(UP, f15, LP.entry * 1.004);
  assert.equal(r.long.status, S.LONG_TRIGGERED, r.long.reason);
  assert.equal(r.long.trigger.kind, "swing-break");
  assert.ok(r.long.signalCandle);
});

test("incomplete (forming) candle never triggers; it is only PROVISIONAL", () => {
  const items = new Array(119).fill(LP.entry); // all closed candles flat in the zone
  items.push({ c: LP.entry * 1.01, v: 9000, h: LP.entry * 1.011 }); // forming candle already beyond the trigger
  const f15 = analyzeFrame(explicit("15m", items), NOW, "15m");
  const r = run(UP, f15, LP.entry * 1.01);
  assert.notEqual(r.long.status, S.LONG_TRIGGERED);
  assert.equal(r.long.trigger.confirmed, false);
  assert.equal(r.long.provisional, true);
});

test("wick-only touch of invalidation does NOT invalidate; a close beyond it does", () => {
  const wick = new Array(118).fill(LP.entry);
  wick.push({ c: LP.entry, l: LP.invalidation - UP.f1.atr * 0.05 }); // wick pierces invalidation, closes back inside
  wick.push(LP.entry);
  const r1 = run(UP, analyzeFrame(explicit("15m", wick), NOW, "15m"), LP.entry);
  assert.equal(r1.long.status, S.IN_ZONE);
  const close = new Array(118).fill(LP.entry);
  close.push({ c: LP.invalidation - UP.f1.atr * 0.02 });
  close.push(LP.entry);
  const r2 = run(UP, analyzeFrame(explicit("15m", close), NOW, "15m"), LP.entry);
  assert.equal(r2.long.status, S.INVALIDATED);
});

test("gap through the zone: price far below the stop -> INVALIDATED; price gapping far above -> still WAIT FOR ZONE", () => {
  const gapDown = run(UP, flat15(LP.stop - 5), LP.stop - 5);
  assert.equal(gapDown.long.status, S.INVALIDATED);
  const gapUp = run(UP, flat15(UP.f1.price * 1.05), UP.f1.price * 1.05);
  assert.ok([S.WAIT_ZONE, S.NO_TRADE].includes(gapUp.long.status));
});

test("MISSED ENTRY: zone was tested, then price ran > 1 ATR beyond it without a confirmed entry", () => {
  const items = new Array(100).fill(LP.entry);
  const target = UP.f1.price;
  for (let i = 1; i <= 20; i++) items.push(LP.entry + ((target - LP.entry) * i) / 20);
  const r = run(UP, analyzeFrame(explicit("15m", items), NOW, "15m"), target);
  assert.equal(r.long.status, S.MISSED);
});

test("DATA STALE (old but usable) gives no signal; very old data -> NO TRADE / INSUFFICIENT DATA", () => {
  const stale = run(UP, flat15(LP.entry), LP.entry, { ages: { "4h": 0, "1h": 0, "15m": 8 * 60000, ticker: 1000 } });
  assert.equal(stale.stale, true);
  assert.equal(stale.long.status, S.STALE);
  assert.ok(stale.flags.includes("DATA STALE"));
  const dead = run(UP, flat15(LP.entry), LP.entry, { ages: { "4h": 0, "1h": 0, "15m": 30 * 60000, ticker: 1000 } });
  assert.equal(dead.ok, false);
  assert.equal(dead.label, "INSUFFICIENT DATA");
  assert.equal(dead.status, S.NO_TRADE);
});

test("missing / invalid data never crashes and is reported as insufficient", () => {
  const f15 = flat15(LP.entry);
  const bad = (over) => evaluateSmartEntry({ symbol: "X", frames: { "4h": UP.f4, "1h": UP.f1, "15m": f15, ...over.frames }, live: over.live || liveAt(LP.entry), ages: ages(), now: NOW });
  assert.equal(bad({ frames: { "15m": undefined } }).ok, false);
  assert.equal(bad({ live: { ticker: null } }).ok, false);
  assert.equal(bad({ live: { ticker: { lastPrice: "0", quoteVolume: "1" } } }).ok, false);
  assert.equal(bad({ live: { ticker: { lastPrice: "-5", quoteVolume: "1" } } }).ok, false);
  assert.equal(bad({ live: { ticker: { lastPrice: "abc", quoteVolume: "1" } } }).ok, false);
  const few = analyzeFrame(explicit("15m", new Array(20).fill(LP.entry)), NOW, "15m");
  assert.equal(bad({ frames: { "15m": few } }).ok, false);
});

test("low liquidity: flagged + penalised; far too thin -> NO TRADE", () => {
  const rich = run(UP, flat15(LP.entry), LP.entry);
  const thin = run(UP, flat15(LP.entry), LP.entry, { live: liveAt(LP.entry, { ticker: { lastPrice: String(LP.entry), priceChangePercent: "1", quoteVolume: "6000000" } }) });
  assert.ok(thin.flags.includes("LOW LIQUIDITY"));
  assert.ok(thin.long.score < rich.long.score);
  assert.ok(thin.long.scoreDetail.penalties.some((p) => p.name === "Low liquidity"));
  const dead = run(UP, flat15(LP.entry), LP.entry, { live: liveAt(LP.entry, { ticker: { lastPrice: String(LP.entry), priceChangePercent: "1", quoteVolume: "500000" } }) });
  assert.equal(dead.long.status, S.NO_TRADE);
  assert.equal(dead.long.label, "ILLIQUID");
});

test("wide spread is penalised", () => {
  const wide = run(UP, flat15(LP.entry), LP.entry, { live: liveAt(LP.entry, { book: { bid: LP.entry * 0.99, ask: LP.entry * 1.01 } }) });
  assert.ok(wide.flags.includes("WIDE SPREAD"));
  assert.ok(wide.long.scoreDetail.penalties.some((p) => p.name === "Wide spread"));
});

test("zone quality score: bounded 0-100, components sum to the weights, labelled heuristic parts", () => {
  const sc = baseUp.long.scoreDetail;
  assert.equal(sc.components.reduce((a, c) => a + c.weight, 0), 100);
  assert.ok(sc.score >= 0 && sc.score <= 100);
  assert.ok(sc.components.every((c) => c.points >= 0 && c.points <= c.weight + 1e-9));
  assert.ok(Array.isArray(sc.reasons.for) && Array.isArray(sc.reasons.against));
  const none = scoreZone(1, { t4: baseUp.t4, f1: UP.f1, f15: null, plan: { valid: false, issues: [] }, settings: SMART_DEFAULTS });
  assert.equal(none.score, 0);
});

test("poor risk/reward -> NO TRADE", () => {
  const r = run(UP, flat15(UP.f1.price), UP.f1.price, { settings: { minRR: 99 } });
  assert.equal(r.long.status, S.NO_TRADE);
  assert.equal(r.long.label, "POOR RISK/REWARD");
});

test("no future-data leakage: candles after `now` change nothing", () => {
  const rawAll = raw("1h", 300, zig(150, 210, 0.03, 24), { seed: 4, now: NOW + 40 * 3600000 });
  const cut = NOW; // evaluate "as of" NOW using the same series; later candles are in the future
  const withFuture = analyzeFrame(rawAll, cut, "1h");
  const prefix = rawAll.filter((k) => k[6] < cut);
  const prefixOnly = analyzeFrame(prefix, cut, "1h");
  assert.equal(withFuture.closed.length, prefixOnly.closed.length);
  const a = buildSmartPlan(1, { f1: withFuture, f4: UP.f4, price: withFuture.price, settings: SMART_DEFAULTS });
  const b = buildSmartPlan(1, { f1: prefixOnly, f4: UP.f4, price: prefixOnly.price, settings: SMART_DEFAULTS });
  assert.deepEqual(a.zone, b.zone);
  assert.equal(a.entry, b.entry);
  assert.equal(a.stop, b.stop);
  // a swing is not confirmed until k candles exist on its right
  const h = [1, 2, 3, 10, 3, 2, 1].map((x) => x);
  assert.equal(findPivots(h, h.map((x) => x - 0.5), 3).highs.length, 1);
  assert.equal(findPivots(h.slice(0, 6), h.slice(0, 6).map((x) => x - 0.5), 3).highs.length, 0);
});

test("position sizing: risk budget, costs, leverage changes margin not stop distance", () => {
  const base = { account: 1000, riskPct: 1, entry: 100, stop: 98, side: 1, settings: { feePct: 0, slippagePct: 0 } };
  const a = positionSize({ ...base, leverage: 5 });
  assert.ok(Math.abs(a.qty - 5) < 1e-9); // 10 USDT risk / 2 per unit
  assert.ok(Math.abs(a.notional - 500) < 1e-9);
  assert.ok(Math.abs(a.margin - 100) < 1e-9);
  const b = positionSize({ ...base, leverage: 10 });
  assert.equal(b.qty, a.qty);
  assert.equal(b.stopDist, a.stopDist);
  assert.ok(Math.abs(b.margin - 50) < 1e-9);
  const withCost = positionSize({ ...base, leverage: 5, settings: { feePct: 0.05, slippagePct: 0.03 } });
  assert.ok(withCost.qty < a.qty);
  // short side liquidation sits above entry
  const sh = positionSize({ ...base, side: -1, stop: 102, leverage: 10 });
  assert.ok(sh.liqApprox > 100);
  // liquidation closer than the stop is warned
  const hi = positionSize({ ...base, leverage: 50 });
  assert.equal(hi.liqBeforeStop, true);
  assert.ok(hi.warnings.some((w) => /liquidat/i.test(w)));
  // not enough margin is warned
  assert.ok(positionSize({ ...base, riskPct: 50, leverage: 1 }).warnings.some((w) => /margin/i.test(w)));
  for (const bad of [{ account: 0 }, { riskPct: -1 }, { leverage: 0 }, { entry: NaN }, { stop: 100 }, { account: "x" }]) assert.equal(positionSize({ ...base, leverage: 5, ...bad }), null);
});

test("status tracker: no duplicate signals, no illegal jumps back from TRIGGERED", () => {
  const t = createStatusTracker();
  assert.equal(t.advance("A", S.WAIT_ZONE).changed, true);
  assert.equal(t.advance("A", S.WAIT_ZONE).duplicate, true);
  assert.equal(t.advance("A", S.IN_ZONE).changed, true);
  assert.equal(t.advance("A", S.LONG_TRIGGERED).changed, true);
  const back = t.advance("A", S.WAIT_ZONE);
  assert.equal(back.status, S.LONG_TRIGGERED);
  assert.equal(back.held, true);
  assert.equal(t.advance("A", S.INVALIDATED).changed, true);
  assert.equal(t.advance("B", S.IN_ZONE).changed, true); // independent setup
  assert.notEqual(smartSetupId("X", 1, LP, 1.3), smartSetupId("X", -1, LP, 1.3));
});

test("symbolCheck: invalid, delisted, non-perpetual, non-USDT, not trading", () => {
  const map = {
    BTCUSDT: { status: "TRADING", contractType: "PERPETUAL", quoteAsset: "USDT" },
    OLDUSDT: { status: "SETTLING", contractType: "PERPETUAL", quoteAsset: "USDT" },
    BTCUSDT_261225: { status: "TRADING", contractType: "CURRENT_QUARTER", quoteAsset: "USDT" },
    ETHUSDC: { status: "TRADING", contractType: "PERPETUAL", quoteAsset: "USDC" },
    QRTUSDT: { status: "TRADING", contractType: "CURRENT_QUARTER", quoteAsset: "USDT" },
  };
  assert.equal(symbolCheck("btcusdt", map).ok, true);
  assert.match(symbolCheck("OLDUSDT", map).reason, /not currently trading/);
  assert.match(symbolCheck("QRTUSDT", map).reason, /PERPETUAL/);
  assert.match(symbolCheck("GONEUSDT", map).reason, /unknown or delisted/);
  assert.match(symbolCheck("ETHUSDC", map).reason, /USDT/);
  assert.equal(symbolCheck("", map).ok, false);
  assert.equal(symbolCheck("BTC/USDT!", map).ok, false);
  assert.equal(symbolCheck(null, map).ok, false);
});

// ---- data layer: symbol switching, rate limits, exchangeInfo status map ----
const resp = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const klineFor = (tf, base) => {
  const ms = TF_MS[tf];
  const lastOpen = Math.floor(Date.now() / ms) * ms;
  return Array.from({ length: 250 }, (_, i) => {
    const open = lastOpen - (249 - i) * ms;
    const p = base + Math.sin(i / 7) * base * 0.01;
    return [open, String(p), String(p * 1.002), String(p * 0.998), String(p), "10", open + ms - 1, String(1000)];
  });
};
test("scanner.getFrames + exchangeInfo status map: rapid symbol switching stays isolated and de-duplicated", async () => {
  const calls = [];
  const fapiFetch = async (url) => {
    calls.push(url);
    await new Promise((r) => setImmediate(r));
    if (url.includes("exchangeInfo")) return resp({ symbols: [{ symbol: "AAAUSDT", quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING" }, { symbol: "ZZZUSDT", quoteAsset: "USDT", contractType: "PERPETUAL", status: "SETTLING" }] });
    const sym = /symbol=([A-Z]+)/.exec(url)[1];
    const tf = /interval=([0-9a-z]+)/.exec(url)[1];
    return resp(klineFor(tf, sym === "AAAUSDT" ? 100 : 5000));
  };
  const sc = createRadarScanner({ fapiFetch, sleep: async () => {} });
  const info = await sc.loadExchangeInfo();
  assert.equal(info.statusMap.ZZZUSDT.status, "SETTLING");
  assert.equal(symbolCheck("ZZZUSDT", info.statusMap).ok, false);
  assert.equal(symbolCheck("AAAUSDT", info.statusMap).ok, true);
  // switch A -> B -> A quickly; concurrent identical requests are shared
  await Promise.all([sc.getKlines("AAAUSDT", "1h"), sc.getKlines("AAAUSDT", "1h"), sc.getKlines("BBBUSDT", "1h")]);
  await Promise.all(["4h", "15m"].map((tf) => sc.getKlines("AAAUSDT", tf)));
  assert.equal(calls.filter((u) => u.includes("symbol=AAAUSDT") && u.includes("interval=1h")).length, 1);
  const fa = sc.getFrames("AAAUSDT");
  assert.ok(fa.frames["1h"].price > 90 && fa.frames["1h"].price < 110);
  assert.equal(Object.keys(fa.frames).length, 3);
  assert.equal(sc.getFrames("BBBUSDT").frames["1h"].price > 4000, true);
  assert.equal(sc.getFrames("NEVERUSDT").frames["1h"], undefined);
});

test("rate limits (429/418) surface as RateLimitedError after bounded retries — no crash, no hammering", async () => {
  let n = 0;
  const fapiFetch = async () => { n++; return resp({}, 429); };
  const sc = createRadarScanner({ fapiFetch, sleep: async () => {}, blockedSecondsLeft: () => 0 });
  await assert.rejects(() => sc.getKlines("AAAUSDT", "1h"), (e) => e.rateLimited === true);
  assert.ok(n <= 4, "bounded retries, got " + n);
});

test("regression: the zone does not move or vanish as live price walks into it (only a new closed candle moves it)", () => {
  const zones = [UP.f1.price, LP.zone.hi + 0.2, LP.entry, LP.zone.lo - 0.1].map((p) => run(UP, flat15(p), p).long.plan.zone);
  zones.forEach((z) => assert.deepEqual(z, zones[0]));
});
