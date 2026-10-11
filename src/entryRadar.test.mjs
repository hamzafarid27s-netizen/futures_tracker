// Unit tests for the Entry Radar engine. Run with:  node --test src/
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCandles, splitClosed, countGaps, emaSeries, rsiSeries, atrSeries, adxSeries, relVolume, findPivots,
  classifyStructure, analyzeFrame, trendFromFrame, rrNet, costPerUnit, buildPlan, scoreSide, classifyStatus,
  evaluateSymbol, setupId, STATUS, DEFAULT_SETTINGS, TF_MS,
} from "./entryRadar.js";

const NOW = Date.UTC(2026, 9, 11, 12, 7, 30); // mid-candle on purpose

// Deterministic pseudo-random
function rng(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

// Build raw klines ending with a FORMING candle at `now`. closes(i, n) gives
// the close price of the i-th of n candles (oldest first).
function rawKlines(tf, n, closes, { vol = 1000, now = NOW, noise = 0.002, seed = 1 } = {}) {
  const ms = TF_MS[tf];
  const lastOpen = Math.floor(now / ms) * ms;
  const rnd = rng(seed);
  const out = [];
  let prev = closes(0, n);
  for (let i = 0; i < n; i++) {
    const open = lastOpen - (n - 1 - i) * ms;
    const c = closes(i, n);
    const o = prev;
    const hi = Math.max(o, c) * (1 + rnd() * noise);
    const lo = Math.min(o, c) * (1 - rnd() * noise);
    const v = vol * (0.7 + rnd() * 0.6);
    out.push([open, String(o), String(hi), String(lo), String(c), String(v), open + ms - 1, String(v * c), 10, "0", "0", "0"]);
    prev = c;
  }
  return out;
}
const uptrend = (a, b) => (i, n) => a + ((b - a) * i) / (n - 1);
const flat = (p) => () => p;

test("parseCandles drops invalid, zero, negative and duplicate rows", () => {
  const good = [1000, "10", "11", "9", "10.5", "5", 1999, "50"];
  const raw = [
    good,
    good, // duplicate open time
    [2000, "0", "11", "9", "10", "5", 2999, "50"], // zero open
    [3000, "10", "9", "11", "10", "5", 3999, "50"], // high < low
    [4000, "-1", "11", "9", "10", "5", 4999, "50"], // negative
    [5000, "NaN", "11", "9", "10", "5", 5999, "50"],
    [6000, "10", "12", "9", "11", "5", 6999], // missing quote volume -> kept, qv 0
    "garbage",
  ];
  const { candles, dropped } = parseCandles(raw);
  assert.equal(candles.length, 2);
  assert.equal(dropped, 5);
  assert.equal(candles[1].qv, 0);
  assert.deepEqual(parseCandles(null), { candles: [], dropped: 0 });
});

test("splitClosed separates the still-forming candle", () => {
  const { candles } = parseCandles(rawKlines("1h", 5, flat(100)));
  const { closed, forming } = splitClosed(candles, NOW);
  assert.equal(closed.length, 4);
  assert.ok(forming && forming.ct > NOW);
  assert.ok(closed.every((c) => c.ct < NOW));
  // exactly at closeTime + 1 the candle becomes closed
  const { closed: c2, forming: f2 } = splitClosed(candles, forming.ct + 1);
  assert.equal(c2.length, 5);
  assert.equal(f2, null);
});

test("countGaps finds missing candles", () => {
  const raw = rawKlines("15m", 40, flat(100));
  raw.splice(20, 2);
  const { candles } = parseCandles(raw);
  assert.equal(countGaps(candles, TF_MS["15m"], 60), 1);
});

test("EMA: constant series stays constant, seeded with SMA, null before period", () => {
  const e = emaSeries(new Array(30).fill(7), 10);
  assert.equal(e[8], null);
  assert.ok(Math.abs(e[9] - 7) < 1e-9);
  assert.ok(Math.abs(e[29] - 7) < 1e-9);
  const r = emaSeries([1, 2, 3, 4, 5, 6], 3);
  assert.equal(r[2], 2); // SMA(1,2,3)
  assert.equal(r[3], 3); // 4*0.5 + 2*0.5
});

test("RSI: all-up = 100, all-down = 0, flat = 50, bounded", () => {
  const up = rsiSeries(Array.from({ length: 40 }, (_, i) => 100 + i), 14);
  const dn = rsiSeries(Array.from({ length: 40 }, (_, i) => 200 - i), 14);
  const fl = rsiSeries(new Array(40).fill(5), 14);
  assert.equal(up[39], 100);
  assert.equal(dn[39], 0);
  assert.equal(fl[39], 50);
  const r = rnd2(300).map((x) => x);
  rsiSeries(r, 14).forEach((v) => v === null || assert.ok(v >= 0 && v <= 100));
});
function rnd2(n) {
  const r = rng(5);
  let p = 100;
  return Array.from({ length: n }, () => (p *= 1 + (r() - 0.5) * 0.02));
}

test("ATR: constant 2-point range gives ATR 2", () => {
  const n = 40;
  const h = new Array(n).fill(12), l = new Array(n).fill(10), c = new Array(n).fill(11);
  const a = atrSeries(h, l, c, 14);
  assert.equal(a[13], null);
  assert.ok(Math.abs(a[39] - 2) < 1e-9);
});

test("ADX: strong trend scores far above choppy noise, within 0-100", () => {
  const n = 120;
  const c1 = Array.from({ length: n }, (_, i) => 100 + i * 0.8);
  const h1 = c1.map((x) => x + 0.3), l1 = c1.map((x) => x - 0.3);
  const r = rng(9);
  const c2 = Array.from({ length: n }, (_, i) => 100 + Math.sin(i) * 0.5 + (r() - 0.5));
  const h2 = c2.map((x) => x + 0.3), l2 = c2.map((x) => x - 0.3);
  const a1 = adxSeries(h1, l1, c1, 14)[n - 1];
  const a2 = adxSeries(h2, l2, c2, 14)[n - 1];
  assert.ok(a1 > 40, `trend adx ${a1}`);
  assert.ok(a2 < 25, `chop adx ${a2}`);
  assert.ok(a1 <= 100 && a2 >= 0);
});

test("relVolume excludes the judged candle from its own baseline", () => {
  const v = [...new Array(20).fill(100), 300];
  assert.equal(relVolume(v, 20), 3);
  assert.equal(relVolume([1, 2, 3], 20), null);
  assert.equal(relVolume([...new Array(20).fill(0), 5], 20), null);
});

test("pivots need k candles each side and never use future data", () => {
  const r = rng(3);
  const h = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 5) * 5 + r());
  const l = h.map((x) => x - 1);
  const k = 3;
  const full = findPivots(h, l, k);
  // newest k candles can never be pivots
  assert.ok(full.highs.every((p) => p.i <= h.length - 1 - k));
  assert.ok(full.lows.every((p) => p.i <= h.length - 1 - k));
  // pivots found on a prefix are unchanged by appending candles (no look-ahead leakage)
  const cut = 120;
  const pre = findPivots(h.slice(0, cut), l.slice(0, cut), k);
  const post = findPivots(h, l, k);
  pre.highs.forEach((p) => assert.ok(post.highs.some((q) => q.i === p.i && q.price === p.price)));
  pre.lows.forEach((p) => assert.ok(post.lows.some((q) => q.i === p.i && q.price === p.price)));
});

test("indicators have no leakage: prefix EMA/RSI/ATR equal the full-series value at the same index", () => {
  const c = rnd2(300);
  const h = c.map((x) => x * 1.002), l = c.map((x) => x * 0.998);
  const i = 199;
  assert.equal(emaSeries(c.slice(0, i + 1), 50)[i], emaSeries(c, 50)[i]);
  assert.equal(rsiSeries(c.slice(0, i + 1), 14)[i], rsiSeries(c, 14)[i]);
  assert.equal(atrSeries(h.slice(0, i + 1), l.slice(0, i + 1), c.slice(0, i + 1), 14)[i], atrSeries(h, l, c, 14)[i]);
  assert.equal(adxSeries(h.slice(0, i + 1), l.slice(0, i + 1), c.slice(0, i + 1), 14)[i], adxSeries(h, l, c, 14)[i]);
});

test("analyzeFrame ignores the forming candle and flags short history", () => {
  const raw = rawKlines("1h", 260, uptrend(100, 200));
  const f = analyzeFrame(raw, NOW, "1h");
  assert.equal(f.n, 259);
  assert.ok(f.forming);
  assert.ok(f.ok && f.ema200 !== null);
  // changing only the forming candle must not change any indicator
  const raw2 = raw.map((k, i) => (i === raw.length - 1 ? [k[0], "1", "1000", "1", "500", k[5], k[6], k[7]] : k));
  const f2 = analyzeFrame(raw2, NOW, "1h");
  assert.equal(f2.ema20, f.ema20);
  assert.equal(f2.rsi, f.rsi);
  assert.equal(f2.atr, f.atr);
  const short = analyzeFrame(rawKlines("1h", 20, flat(100)), NOW, "1h");
  assert.equal(short.ok, false);
  const mid = analyzeFrame(rawKlines("4h", 120, uptrend(100, 130)), NOW, "4h");
  assert.equal(mid.ema200, null); // < 200 closed candles -> unavailable, never invented
});

test("trendFromFrame: uptrend UP, downtrend DOWN, flat RANGE", () => {
  const up = trendFromFrame(analyzeFrame(rawKlines("4h", 260, uptrend(100, 250)), NOW, "4h"));
  const dn = trendFromFrame(analyzeFrame(rawKlines("4h", 260, uptrend(250, 100)), NOW, "4h"));
  const fl = trendFromFrame(analyzeFrame(rawKlines("4h", 260, (i) => 100 + Math.sin(i / 3) * 0.3, { noise: 0.0005 }), NOW, "4h"));
  assert.equal(up.dir, 1);
  assert.equal(dn.dir, -1);
  assert.equal(fl.dir, 0);
  assert.ok(up.strength >= 0 && up.strength <= 100);
  assert.equal(trendFromFrame(null).dir, 0);
});

test("classifyStructure", () => {
  const P = (a) => a.map((price, i) => ({ i, price }));
  assert.equal(classifyStructure({ highs: P([10, 11]), lows: P([5, 6]) }).label, "BULLISH");
  assert.equal(classifyStructure({ highs: P([11, 10]), lows: P([6, 5]) }).label, "BEARISH");
  assert.equal(classifyStructure({ highs: P([10, 11]), lows: P([6, 5]) }).label, "RANGE");
  assert.equal(classifyStructure({ highs: P([10]), lows: P([6]) }).label, "UNKNOWN");
});

test("risk/reward: long, short, costs, zero risk", () => {
  const s0 = { ...DEFAULT_SETTINGS, feePct: 0, slippagePct: 0 };
  assert.equal(rrNet(100, 95, 110, s0), 2); // reward 10 / risk 5
  assert.equal(rrNet(100, 105, 90, s0), 2); // short
  assert.equal(rrNet(100, 100, 110, s0), null);
  const s1 = { ...DEFAULT_SETTINGS, feePct: 0.05, slippagePct: 0.03 };
  assert.ok(Math.abs(costPerUnit(100, s1) - 0.16) < 1e-9);
  const withCost = rrNet(100, 95, 110, s1);
  assert.ok(withCost < 2 && withCost > 1.9); // (10-0.16)/(5+0.16)
  assert.ok(Math.abs(withCost - 9.84 / 5.16) < 1e-9);
});

// ---- a realistic uptrend with a pullback into the 1H EMA zone ----
function pullbackFrames({ pullbackTo = 0.97, lastVolMult = 1 } = {}) {
  const f4 = analyzeFrame(rawKlines("4h", 260, uptrend(100, 200), { seed: 11 }), NOW, "4h");
  const f1raw = rawKlines("1h", 260, (i, n) => {
    const base = 150 + (i / n) * 60;
    return i > n - 12 ? base * (1 - (1 - pullbackTo) * Math.min(1, (i - (n - 12)) / 8)) : base;
  }, { seed: 12 });
  const f1 = analyzeFrame(f1raw, NOW, "1h");
  const f15 = analyzeFrame(rawKlines("15m", 260, (i, n) => f1.price * (1 + Math.sin(i / 8) * 0.002), { seed: 13, vol: 1000 * lastVolMult }), NOW, "15m");
  return { "4h": f4, "1h": f1, "15m": f15 };
}

test("buildPlan: long stop below entry, targets ascending, short mirrored, rr computed", () => {
  const frames = pullbackFrames();
  const price = frames["1h"].price;
  const st = { ...DEFAULT_SETTINGS };
  const L = buildPlan(1, { f1: frames["1h"], f15: frames["15m"], price, settings: st });
  const S = buildPlan(-1, { f1: frames["1h"], f15: frames["15m"], price, settings: st });
  if (L.valid) {
    assert.ok(L.stop < L.entry, "long stop below entry");
    assert.ok(L.invalidation > L.stop, "stop is beyond invalidation");
    assert.ok(L.zone.lo < L.zone.hi && L.zone.lo <= L.entry && L.entry <= L.zone.hi);
    assert.equal(L.targets.length, 3);
    assert.ok(L.targets[0].price < L.targets[1].price && L.targets[1].price < L.targets[2].price);
    assert.ok(L.targets[0].price > L.entry);
    assert.ok(Math.abs(L.entry - L.stop) >= frames["1h"].atr * 0.8 - 1e-9, "stop at least 0.8 ATR away");
    assert.ok(L.rr1 < L.rr2 && L.rr2 < L.rr3);
  } else assert.ok(L.issues.length > 0);
  if (S.valid) {
    assert.ok(S.stop > S.entry, "short stop above entry");
    assert.ok(S.targets[0].price > S.targets[1].price && S.targets[1].price > S.targets[2].price);
    assert.ok(S.targets[0].price < S.entry);
  }
  // fees/slippage reduce rr
  if (L.valid) {
    const free = buildPlan(1, { f1: frames["1h"], f15: frames["15m"], price, settings: { ...st, feePct: 0, slippagePct: 0 } });
    assert.ok(free.rr2 > L.rr2);
  }
});

test("scoreSide: bounded 0-100, transparent components, 4H conflict penalised", () => {
  const frames = pullbackFrames();
  const price = frames["1h"].price;
  const settings = { ...DEFAULT_SETTINGS };
  const t4 = trendFromFrame(frames["4h"]);
  const plan = buildPlan(1, { f1: frames["1h"], f15: frames["15m"], price, settings });
  const ctx = { t4, f1: frames["1h"], f15: frames["15m"], plan, price, settings, deriv: null, funding: null, quoteVolume: 5e8, spreadPct: 0.01, stale: false, priceChange1hPct: 0 };
  const a = scoreSide(1, ctx);
  assert.ok(a.score >= 0 && a.score <= 100);
  assert.equal(a.components.reduce((s, c) => s + c.weight, 0), 100);
  assert.ok(a.components.every((c) => c.value >= 0 && c.value <= 1 && c.points <= c.weight));
  assert.ok(a.components.find((c) => c.key === "deriv").unavailable, "missing derivatives labelled UNAVAILABLE");
  const against = scoreSide(1, { ...ctx, t4: { ...t4, dir: -1, label: "DOWN" } });
  assert.ok(against.score < a.score);
  assert.ok(against.penalties.some((p) => p.name === "4H trend conflicts"));
  const illiquid = scoreSide(1, { ...ctx, quoteVolume: 1e6 });
  assert.ok(illiquid.penalties.some((p) => p.name === "Poor liquidity") && illiquid.score < a.score);
  const wide = scoreSide(1, { ...ctx, spreadPct: 0.4 });
  assert.ok(wide.penalties.some((p) => p.name === "Wide spread"));
  const stale = scoreSide(1, { ...ctx, stale: true });
  assert.ok(stale.penalties.some((p) => p.name === "Stale data"));
  // derivatives present flips the component from UNAVAILABLE to DERIVED
  const withD = scoreSide(1, { ...ctx, priceChange1hPct: 0.8, deriv: { oiChange1hPct: 2, longPct: 50 }, funding: { rate: 0.0001 } });
  const dc = withD.components.find((c) => c.key === "deriv");
  assert.ok(dc.derived && !dc.unavailable && dc.value > 0.5);
});

// ---- status transitions ----
const mkPlan = (over = {}) => ({
  valid: true, issues: [], zone: { lo: 99, hi: 101, type: "EMA20/50 pullback" }, entry: 100, stop: 97, invalidation: 98.5,
  trigger: { level: 101, closedConfirm: false }, ...over,
});
const mkScores = (l, s) => ({ 1: { score: l }, [-1]: { score: s } });
const baseIn = () => ({
  scores: mkScores(70, 30), plans: { 1: mkPlan(), [-1]: mkPlan({ valid: false }) }, t4: { dir: 1 }, price: 100.2,
  f1: { atr: 2 }, trig: { closedConfirm: false }, provisional: false, dataState: { insufficient: false }, settings: DEFAULT_SETTINGS,
});

test("status: INSUFFICIENT DATA wins over everything", () => {
  assert.equal(classifyStatus({ ...baseIn(), dataState: { insufficient: true, reason: "x" } }).status, STATUS.INSUFFICIENT);
});
test("status: no side above minScore -> NO TRADE", () => {
  assert.equal(classifyStatus({ ...baseIn(), scores: mkScores(40, 30) }).status, STATUS.NO_TRADE);
});
test("status: 4H opposing trend blocks a side", () => {
  assert.equal(classifyStatus({ ...baseIn(), t4: { dir: -1 } }).status, STATUS.NO_TRADE);
});
test("status: both sides close in score -> conflicting", () => {
  const r = classifyStatus({ ...baseIn(), t4: { dir: 0 }, scores: mkScores(66, 62), plans: { 1: mkPlan(), [-1]: mkPlan() } });
  assert.equal(r.status, STATUS.NO_TRADE);
});
test("status: LONG waits for entry inside/near zone", () => {
  const r = classifyStatus(baseIn());
  assert.equal(r.status, STATUS.LONG_WAIT);
  assert.equal(r.side, 1);
});
test("status: closed 15m confirmation near the zone -> LONG ENTRY TRIGGERED", () => {
  const r = classifyStatus({ ...baseIn(), trig: { closedConfirm: true } });
  assert.equal(r.status, STATUS.LONG_TRIGGERED);
});
test("status: provisional (unclosed) trigger NEVER becomes TRIGGERED", () => {
  const r = classifyStatus({ ...baseIn(), trig: { closedConfirm: false }, provisional: true });
  assert.equal(r.status, STATUS.LONG_WAIT);
  assert.equal(r.provisional, true);
});
test("status: price far above the zone -> WAIT—PRICE TOO FAR, pullback vs retest hint", () => {
  const far = classifyStatus({ ...baseIn(), price: 106 });
  assert.equal(far.status, STATUS.TOO_FAR);
  assert.equal(far.hint, "WAIT FOR PULLBACK");
  const rt = classifyStatus({ ...baseIn(), price: 106, plans: { 1: mkPlan({ zone: { lo: 99, hi: 101, type: "Breakout retest" } }), [-1]: mkPlan({ valid: false }) } });
  assert.equal(rt.hint, "WAIT FOR RETEST");
  // even a confirmed closed trigger must not chase a price that already ran away
  assert.equal(classifyStatus({ ...baseIn(), price: 106, trig: { closedConfirm: true } }).status, STATUS.TOO_FAR);
});
test("status: price through invalidation -> setup dead", () => {
  const r = classifyStatus({ ...baseIn(), price: 98 });
  assert.equal(r.status, STATUS.NO_TRADE);
  assert.match(r.reason, /invalidation/);
});
test("status: SHORT side mirrors", () => {
  const plan = mkPlan({ zone: { lo: 99, hi: 101, type: "Resistance zone" }, stop: 103, invalidation: 101.5 });
  const inp = { ...baseIn(), t4: { dir: -1 }, scores: mkScores(20, 72), plans: { 1: mkPlan({ valid: false }), [-1]: plan }, price: 99.8 };
  assert.equal(classifyStatus(inp).status, STATUS.SHORT_WAIT);
  assert.equal(classifyStatus({ ...inp, trig: { closedConfirm: true } }).status, STATUS.SHORT_TRIGGERED);
  assert.equal(classifyStatus({ ...inp, price: 94 }).status, STATUS.TOO_FAR);
  assert.equal(classifyStatus({ ...inp, price: 101.6 }).status, STATUS.NO_TRADE);
});

// ---- end-to-end ----
const live = (over = {}) => ({ ticker: { lastPrice: "180", priceChangePercent: "2.1", quoteVolume: "250000000" }, book: { bid: 179.99, ask: 180.01 }, funding: { rate: 0.0001, nextFundingTime: NOW + 3600000 }, deriv: null, ...over });
const ages = (ms = 5000) => ({ "4h": ms, "1h": ms, "15m": ms, ticker: ms });

test("evaluateSymbol: end-to-end result shape, bounded scores, EMA200/OI labelled unavailable honestly", () => {
  const frames = pullbackFrames();
  const price = frames["1h"].price;
  const r = evaluateSymbol({ symbol: "TESTUSDT", frames, live: live({ ticker: { lastPrice: String(price), priceChangePercent: "1", quoteVolume: "3e8" } }), ages: ages(), now: NOW });
  assert.ok(Object.values(STATUS).includes(r.status));
  assert.ok(r.score.long >= 0 && r.score.long <= 100 && r.score.short >= 0 && r.score.short <= 100);
  assert.ok(r.flags.includes("OI/L-S UNAVAILABLE"));
  assert.equal(r.t4.label, "UP");
  if (r.best) assert.ok(r.id && r.id.startsWith("TESTUSDT:"));
  assert.ok(r.formingCandle15m, "forming candle reported separately");
});

test("evaluateSymbol: invalid / missing inputs -> INSUFFICIENT DATA, never a crash", () => {
  const frames = pullbackFrames();
  const bad = (l, f = frames, a = ages()) => evaluateSymbol({ symbol: "X", frames: f, live: l, ages: a, now: NOW });
  assert.equal(bad(live({ ticker: null })).status, STATUS.INSUFFICIENT);
  assert.equal(bad(live({ ticker: { lastPrice: "0", priceChangePercent: "0", quoteVolume: "1" } })).status, STATUS.INSUFFICIENT);
  assert.equal(bad(live({ ticker: { lastPrice: "-5", priceChangePercent: "0", quoteVolume: "1" } })).status, STATUS.INSUFFICIENT);
  assert.equal(bad(live({ ticker: { lastPrice: "abc" } })).status, STATUS.INSUFFICIENT);
  assert.equal(bad(live(), { "4h": frames["4h"] }).status, STATUS.INSUFFICIENT);
  const shortF = { ...frames, "1h": analyzeFrame(rawKlines("1h", 20, flat(100)), NOW, "1h") };
  assert.equal(bad(live(), shortF).status, STATUS.INSUFFICIENT);
  assert.match(bad(live(), shortF).reason, /closed candles/);
  assert.equal(bad(live(), frames, ages(30 * 60000)).status, STATUS.INSUFFICIENT); // dead data
});

test("evaluateSymbol: missing candles (gaps) -> INSUFFICIENT DATA", () => {
  const frames = pullbackFrames();
  const raw = rawKlines("15m", 260, flat(180), { seed: 4 });
  [250, 245, 240, 235].forEach((i) => raw.splice(i, 1));
  const f15 = analyzeFrame(raw, NOW, "15m");
  const r = evaluateSymbol({ symbol: "GAPUSDT", frames: { ...frames, "15m": f15 }, live: live(), ages: ages(), now: NOW });
  assert.equal(r.status, STATUS.INSUFFICIENT);
  assert.match(r.reason, /missing candles/);
});

test("evaluateSymbol: stale data is flagged and penalised; low volume is flagged", () => {
  const frames = pullbackFrames();
  const price = String(frames["1h"].price);
  const fresh = evaluateSymbol({ symbol: "A", frames, live: live({ ticker: { lastPrice: price, priceChangePercent: "1", quoteVolume: "3e8" } }), ages: ages(), now: NOW });
  const stale = evaluateSymbol({ symbol: "A", frames, live: live({ ticker: { lastPrice: price, priceChangePercent: "1", quoteVolume: "3e8" } }), ages: ages(8 * 60000), now: NOW });
  assert.ok(stale.flags.includes("STALE") && stale.stale);
  assert.ok(stale.score.long <= fresh.score.long);
  const thin = evaluateSymbol({ symbol: "A", frames, live: live({ ticker: { lastPrice: price, priceChangePercent: "1", quoteVolume: "500000" } }), ages: ages(), now: NOW });
  assert.ok(thin.flags.includes("LOW LIQUIDITY"));
  assert.ok(thin.score.long < fresh.score.long);
  const wide = evaluateSymbol({ symbol: "A", frames, live: live({ ticker: { lastPrice: price, priceChangePercent: "1", quoteVolume: "3e8" }, book: { bid: 99, ask: 101 } }), ages: ages(), now: NOW });
  assert.ok(wide.flags.includes("WIDE SPREAD"));
});

test("setupId is stable under tiny zone drift and differs by side/zone", () => {
  const p = (lo, hi) => ({ zone: { lo, hi, type: "EMA20/50 pullback" } });
  const a = setupId("BTCUSDT", 1, p(100, 102), 4);
  assert.equal(a, setupId("BTCUSDT", 1, p(100.1, 102.1), 4));
  assert.notEqual(a, setupId("BTCUSDT", -1, p(100, 102), 4));
  assert.notEqual(a, setupId("BTCUSDT", 1, p(120, 122), 4));
});
