// Tests for the Early Reversal & possible large-player activity detector.  node --test src/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { analyzeFrame, parseCandles, TF_MS } from "./entryRadar.js";
import {
  REV_STATE as R, FLOW, REV_DEFAULTS, REV_TFS, normalizeSymbol, macdSeries, detectDivergence, detectStructureShift,
  detectFalseBreakout, detectBreakouts, classifyFlow, derivMetrics, evaluateReversal, createSignalLog, takerShare,
} from "./reversal.js";
import { createRadarScanner } from "./radarScanner.js";

const NOW = Date.UTC(2026, 9, 11, 12, 7, 30); // mid-candle on purpose

// piecewise-linear closes with deterministic noise
function path(n, pts, noise = 0.0008, seed = 7) {
  let s = seed;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5);
  const out = [];
  for (let i = 0; i < n; i++) {
    let k = 0;
    while (k < pts.length - 2 && i > pts[k + 1][0]) k++;
    const [i0, p0] = pts[k], [i1, p1] = pts[k + 1];
    const t = Math.min(1, Math.max(0, (i - i0) / (i1 - i0)));
    out.push((p0 + (p1 - p0) * t) * (1 + r() * noise * 2));
  }
  return out;
}
// The LAST candle is the forming one (its close time is after NOW).
function klines(tf, closes, vols, { now = NOW, takerBuy = 0.5, wick = 0.0012, future = 0 } = {}) {
  const ms = TF_MS[tf];
  const n = closes.length;
  const lastOpen = Math.floor(now / ms) * ms;
  let prev = closes[0];
  const out = closes.map((c, i) => {
    const open = lastOpen - (n - 1 - i) * ms;
    const o = prev;
    const h = Math.max(o, c) * (1 + wick), l = Math.min(o, c) * (1 - wick);
    const v = vols ? vols[i] : 1000;
    prev = c;
    const share = typeof takerBuy === "function" ? takerBuy(i, c, o) : c >= o ? takerBuy + 0.1 : takerBuy - 0.1;
    return [open, String(o), String(h), String(l), String(c), String(v), open + ms - 1, String(v * c), 10, String(v * share), "0", "0"];
  });
  for (let k = 1; k <= future; k++) {
    const open = lastOpen + k * ms;
    out.push([open, "100", "101", "99", "100", "1000", open + ms - 1, "100000", 10, "500", "0", "0"]);
  }
  return out;
}
const mirror = (arr, axis = 200) => arr.map((p) => axis - p);
const spikeVols = (n, from, to, mult = 4) => Array.from({ length: n }, (_, i) => (i >= from && i <= to ? 1000 * mult : 1000));

// ---- scenarios -------------------------------------------------------------
// Down-trend with a lower low whose RSI is HIGHER (regular bullish divergence), then a close
// above the last lower high (CHOCH) ~3 candles ago, on a volume spike.
const BULL_PTS = [[0, 100], [120, 100], [165, 92], [180, 95], [205, 90.5], [216, 94.5], [224, 96.2]];
const N = 225;
const bullCloses = path(N, BULL_PTS);
const bullVols = spikeVols(N, 216, 222);
const bearCloses = mirror(bullCloses);

function framesFrom(closes, vols, opts = {}) {
  const f = {};
  for (const tf of REV_TFS) f[tf] = analyzeFrame(klines(tf, closes, vols, opts), NOW, tf);
  return f;
}
const ages0 = { "5m": 0, "15m": 0, "1h": 0, "4h": 0, ticker: 0 };
const liveFor = (frames, over = {}) => ({ ticker: { lastPrice: String(frames["15m"].price), priceChangePercent: "1", quoteVolume: "300000000", ...over } });
function ext({ oi, taker = 1.2, funding = 0.0001, ls } = {}) {
  const series = (arr) => arr.map((v, i) => ({ t: i, v }));
  return {
    period: "15m",
    oi: oi ? oi.map((v, i) => ({ t: i, v })) : null,
    ls: ls ? ls.map((r, i) => ({ t: i, ratio: r })) : null,
    taker: taker ? Array.from({ length: 6 }, (_, i) => ({ t: i, ratio: taker })) : null,
    funding: funding === null ? null : [{ t: 1, rate: funding }, { t: 2, rate: funding }],
    errors: [],
  };
}
const flatTo = (n, p) => Array.from({ length: n }, () => p);
const run = (frames, o = {}) => evaluateReversal({ symbol: "TESTUSDT", frames, live: o.live || liveFor(frames), derivByTf: o.deriv || {}, ages: o.ages || ages0, settings: o.settings, now: NOW });

const bullFrames = framesFrom(bullCloses, bullVols);
const bearFrames = framesFrom(bearCloses, bullVols, { takerBuy: 0.5 });

test("normalizeSymbol: BTCUSDT, BTC/USDT, btc usdt, btc-usdt, BTC all become BTCUSDT; junk is rejected", () => {
  for (const s of ["BTCUSDT", "BTC/USDT", "btc usdt", "btc-usdt", "BTC", " btc / usdt ", "btcusdt"]) assert.equal(normalizeSymbol(s), "BTCUSDT", s);
  assert.equal(normalizeSymbol("1000PEPE/usdt"), "1000PEPEUSDT");
  for (const bad of ["", "   ", null, undefined, 42, "///"]) assert.equal(normalizeSymbol(bad), null);
});

test("parseCandles keeps the official taker-buy field; missing/invalid taker data becomes null, never 0", () => {
  const ok = [1000, "10", "11", "9", "10.5", "100", 1999, "1000", 5, "60", "600", "0"];
  const noTaker = [2000, "10", "11", "9", "10.5", "100", 2999, "1000"];
  const bad = [3000, "10", "11", "9", "10.5", "100", 3999, "1000", 5, "250", "x", "0"]; // taker buy > total volume
  const { candles } = parseCandles([ok, noTaker, bad]);
  assert.equal(candles[0].tb, 60);
  assert.equal(candles[1].tb, null);
  assert.equal(candles[2].tb, null);
  assert.equal(takerShare(candles.slice(0, 1), 1), 0.6);
  assert.equal(takerShare(candles, 3), null);
});

test("MACD: constant series -> histogram 0; accelerating series -> positive; lengths preserved", () => {
  const flat = macdSeries(new Array(80).fill(10));
  assert.equal(flat.hist.length, 80);
  assert.ok(Math.abs(flat.hist[79]) < 1e-9);
  const up = macdSeries(Array.from({ length: 80 }, (_, i) => 10 + i * i * 0.01));
  assert.ok(up.macd[79] > 0 && up.hist[79] !== null);
  assert.equal(up.macd[5], null);
});

// ---- divergence -----------------------------------------------------------
const cand = (n) => Array.from({ length: n }, (_, i) => ({ t: i, o: 0, h: 0, l: 0, c: 0, v: 1, qv: 1, ct: i + 1 }));
test("detectDivergence: regular and hidden, bullish and bearish, from confirmed pivots only", () => {
  const closed = cand(60);
  const rsi = new Array(60).fill(50);
  const mk = (lows, highs) => ({ lows, highs });
  rsi[20] = 25; rsi[40] = 35;
  let d = detectDivergence(closed, rsi, mk([{ i: 20, price: 100 }, { i: 40, price: 95 }], []));
  assert.deepEqual(d.map((x) => [x.kind, x.dir]), [["regular", 1]]);
  rsi[20] = 35; rsi[40] = 25; // higher price low, lower RSI low
  d = detectDivergence(closed, rsi, mk([{ i: 20, price: 95 }, { i: 40, price: 100 }], []));
  assert.deepEqual(d.map((x) => [x.kind, x.dir]), [["hidden", 1]]);
  rsi[20] = 75; rsi[40] = 65;
  d = detectDivergence(closed, rsi, mk([], [{ i: 20, price: 100 }, { i: 40, price: 105 }]));
  assert.deepEqual(d.map((x) => [x.kind, x.dir]), [["regular", -1]]);
  rsi[20] = 65; rsi[40] = 75;
  d = detectDivergence(closed, rsi, mk([], [{ i: 20, price: 105 }, { i: 40, price: 100 }]));
  assert.deepEqual(d.map((x) => [x.kind, x.dir]), [["hidden", -1]]);
  // too small an RSI gap, pivots too close, or too old -> nothing
  rsi[20] = 30; rsi[40] = 31;
  assert.equal(detectDivergence(closed, rsi, mk([{ i: 20, price: 100 }, { i: 40, price: 95 }], [])).length, 0);
  rsi[40] = 40;
  assert.equal(detectDivergence(closed, rsi, mk([{ i: 38, price: 100 }, { i: 40, price: 95 }], [])).length, 0);
  assert.equal(detectDivergence(cand(200), new Array(200).fill(40), mk([{ i: 20, price: 100 }, { i: 40, price: 95 }], [])).length, 0);
  // missing RSI is not treated as 0
  assert.equal(detectDivergence(closed, new Array(60).fill(null), mk([{ i: 20, price: 100 }, { i: 40, price: 95 }], [])).length, 0);
});

test("bullish reversal scenario: regular divergence + CHOCH detected on closed candles", () => {
  const f = bullFrames["15m"];
  const div = detectDivergence(f.closed, f.series ? f.series.c.map(() => null) : [], f.pivots); // sanity: null RSI -> none
  assert.equal(div.length, 0);
  const r = run(bullFrames);
  const t = r.byTf["15m"];
  assert.equal(t.ok, true);
  assert.ok(t.detections.div.some((d) => d.kind === "regular" && d.dir === 1), "regular bullish divergence");
  assert.ok(t.detections.shift.bullChoch, "bullish CHOCH");
  assert.equal(t.detections.shift.bearChoch, null);
  assert.ok(t.bull.score > t.bear.score + 20);
  assert.ok(t.bull.supporting.some((e) => e.family === "div"));
  assert.ok(t.bull.supporting.some((e) => e.family === "structure" && e.confirmed));
  assert.ok(t.invalidationLevel === null || t.invalidationLevel < t.price);
});

test("structure breaks only use swings confirmed BEFORE the breaking candle (no look-ahead)", () => {
  const f = bullFrames["15m"];
  const s = detectStructureShift(f);
  const k = 2; // 15m pivot lookback
  for (const key of ["bullChoch", "bullBos", "bearChoch", "bearBos"]) {
    const x = s[key];
    if (!x) continue;
    const piv = [...f.pivots.highs, ...f.pivots.lows].find((p) => Math.abs(p.price - x.level) < 1e-9);
    assert.ok(piv && piv.i + k < x.j, `${key}: swing ${piv && piv.i} must be confirmed before break ${x.j}`);
  }
  // every divergence pivot is a confirmed one (k candles exist on its right)
  const n = f.closed.length;
  evaluateReversal({ symbol: "T", frames: bullFrames, live: liveFor(bullFrames), ages: ages0, now: NOW }).byTf["15m"].detections.div.forEach((d) => assert.ok(d.i2 <= n - 1 - k));
});

test("EARLY vs CONFIRMED: early warning with weak/limited data; confirmed needs CHOCH + 2nd confirmation + volume + score", () => {
  const limited = run(bullFrames).byTf["1h"];
  assert.ok([R.EARLY_BULL, R.BREAKOUT, R.BULL_CONF, R.POT_BREAKOUT].includes(limited.state), limited.state);
  // with positioning data that supports the move (short covering) the score clears the confirmation line
  const deriv = { "15m": ext({ oi: [1100, 1090, 1080, 1060, 1040, 1020], taker: 1.25 }) };
  const t = run(bullFrames, { deriv }).byTf["15m"];
  assert.ok(t.bull.score >= REV_DEFAULTS.confirmMin, `bull score ${t.bull.score}`);
  assert.equal(t.state, R.BULL_CONF, t.state + " / " + t.bull.status.why);
  assert.equal(t.dir, 1);
  assert.equal(t.bull.status.kind, "confirmed");
  assert.ok(t.signals.some((s) => s.state === R.BULL_CONF));
  // without the CHOCH it can never be CONFIRMED, however strong the rest looks (price still below the lower high)
  const noBreak = path(N, [[0, 100], [120, 100], [165, 92], [180, 95], [205, 90.5], [216, 93.6], [224, 94.4]]);
  const fr = framesFrom(noBreak, bullVols);
  const t2 = run(fr, { deriv }).byTf["15m"];
  assert.equal(t2.detections.shift.bullChoch, null);
  assert.notEqual(t2.state, R.BULL_CONF);
});

test("bearish reversal scenario mirrors the bullish one", () => {
  const t = run(bearFrames).byTf["15m"];
  assert.ok(t.detections.div.some((d) => d.kind === "regular" && d.dir === -1), "regular bearish divergence");
  assert.ok(t.detections.shift.bearChoch, "bearish CHOCH");
  assert.equal(t.detections.shift.bullChoch, null);
  assert.ok(t.bear.score > t.bull.score + 20);
  const deriv = { "15m": ext({ oi: [1000, 1010, 1020, 1040, 1060, 1080], taker: 0.8, funding: 0.0006 }) };
  const c = run(bearFrames, { deriv }).byTf["15m"];
  assert.equal(c.state, R.BEAR_CONF, c.state);
  assert.equal(c.dir, -1);
  assert.ok(c.invalidationLevel > c.price, "bearish invalidation above price");
});

test("candle-close confirmation: a FORMING candle that jumps through the level creates no CHOCH and no confirmed state", () => {
  const closes = path(N, [[0, 100], [120, 100], [165, 92], [180, 95], [205, 90.5], [216, 93.9], [223, 94.3]]);
  closes[N - 1] = 97.5; // the forming candle already trades far above the lower high
  const fr = framesFrom(closes, spikeVols(N, 216, 224));
  const t = run(fr, { deriv: { "15m": ext({ oi: [1100, 1090, 1080, 1060, 1040, 1020] }) } }).byTf["15m"];
  assert.equal(t.detections.shift.bullChoch, null);
  assert.notEqual(t.state, R.BULL_CONF);
  assert.notEqual(t.state, R.BREAKOUT);
});

test("no future-data leakage: candles that open after `now` change nothing", () => {
  const withFuture = framesFrom(bullCloses, bullVols, { future: 12 });
  const a = run(bullFrames).byTf["15m"];
  const b = run(withFuture).byTf["15m"];
  assert.equal(a.state, b.state);
  assert.equal(a.bull.score, b.bull.score);
  assert.equal(a.bear.score, b.bear.score);
  assert.equal(a.lastClosed, b.lastClosed);
});

// ---- breakouts and false breakouts ----------------------------------------
// range 98..101 with repeated tests of 101 -> a confirmed resistance zone
const range = (n) => Array.from({ length: n }, (_, i) => 99.5 + 1.5 * Math.sin((2 * Math.PI * i) / 24));
function breakoutCloses({ end, volumeAt }) {
  const base = range(180);
  const tail = end; // explicit closes after the range
  return { closes: [...base, ...tail], vols: Array.from({ length: 180 + tail.length }, (_, i) => (volumeAt(i) ? 4000 : 1000)) };
}
const lastZoneTop = (f) => Math.max(0, ...f.zones.filter((z) => z.strength >= 40 && z.hi > 100.5 && z.hi < 101.6).map((z) => z.hi));

test("breakout CONFIRMED needs a CLOSE beyond resistance on volume; a hold + retest is recognised", () => {
  const { closes, vols } = breakoutCloses({ end: [100.6, 101.9, 102.4, 102.0, 101.3, 101.8, 102.2, 102.1], volumeAt: (i) => i === 181 });
  const f = analyzeFrame(klines("1h", closes, vols), NOW, "1h");
  const top = lastZoneTop(f);
  assert.ok(top > 100.5 && top < 101.6, "range top became a zone: " + top);
  const b = detectBreakouts(f, REV_DEFAULTS);
  assert.ok(b.up && b.up.status === "CONFIRMED", JSON.stringify(b.up && b.up.status));
  assert.equal(b.up.volOk, true);
  assert.ok(["held", "none"].includes(b.up.retest));
  // same breakout with no volume expansion -> not accepted as a clean breakout
  const f2 = analyzeFrame(klines("1h", closes, closes.map(() => 1000)), NOW, "1h");
  const b2 = detectBreakouts(f2, REV_DEFAULTS);
  assert.equal(b2.up && b2.up.volOk, false);
});

test("false breakout: a close above resistance that returns inside is flagged (bull trap -> bearish evidence)", () => {
  const { closes, vols } = breakoutCloses({ end: [100.4, 101.9, 100.3, 99.9, 99.7, 99.6, 99.8, 99.7], volumeAt: (i) => i === 181 });
  const f = analyzeFrame(klines("1h", closes, vols), NOW, "1h");
  const fb = detectFalseBreakout(f);
  assert.ok(fb.some((x) => x.dir === -1 && x.kind === "close-back"), JSON.stringify(fb.map((x) => [x.dir, x.kind, x.barsAgo])));
  const b = detectBreakouts(f, REV_DEFAULTS);
  assert.ok(!b.up || b.up.status !== "CONFIRMED", "a failed breakout is not reported as confirmed");
  const frames = { ...Object.fromEntries(REV_TFS.map((tf) => [tf, null])), "1h": f };
  const r = run({ "5m": null, "15m": null, "4h": null, "1h": f }, { live: { ticker: { lastPrice: String(f.price), priceChangePercent: "0", quoteVolume: "3e8" } } });
  assert.ok(r.byTf["1h"].bear.supporting.some((e) => e.family === "sr" && /bull trap/.test(e.text)));
  void frames;
});

test("bear trap (false breakdown) is bullish evidence; wick-only pokes count as failed attempts", () => {
  const base = range(180);
  const down = [...base, 98.6, 97.4, 98.9, 99.4, 99.6, 99.7, 99.8, 99.9];
  const f = analyzeFrame(klines("1h", down, null), NOW, "1h");
  const fb = detectFalseBreakout(f);
  assert.ok(fb.some((x) => x.dir === 1), "bear trap");
  // wick poke above resistance that closes back inside
  const wick = [...range(180), 100.2, 100.3, 100.2, 100.1, 100.0, 100.1, 100.2, 100.1];
  const raw = klines("1h", wick, null);
  raw[raw.length - 4][2] = String(103.2); // a long upper wick, close still inside the zone
  const fw = analyzeFrame(raw, NOW, "1h");
  const fbw = detectFalseBreakout(fw);
  assert.ok(fbw.some((x) => x.dir === -1 && x.kind === "wick"));
});

test("sideways market: no reversal, breakout or large-player signal is invented", () => {
  const flat = Array.from({ length: 225 }, (_, i) => 100 + 0.3 * Math.sin(i / 3));
  const fr = framesFrom(flat, null);
  const r = run(fr, { deriv: { "15m": ext({ oi: [1000, 1001, 1000, 1001, 1000, 1001], taker: 1.0, funding: 0.0001 }) } });
  for (const tf of REV_TFS) {
    const t = r.byTf[tf];
    assert.ok([R.NONE, R.POT_BREAKOUT, R.POT_BREAKDOWN, R.FALSE_RISK].includes(t.state), tf + " " + t.state);
    assert.ok(t.bull.score < REV_DEFAULTS.earlyMin && t.bear.score < REV_DEFAULTS.earlyMin, `${tf} ${t.bull.score}/${t.bear.score}`);
  }
  assert.equal(r.byTf["15m"].flow.label, FLOW.NONE);
});

test("conflicting timeframes: bearish lower timeframes against a bullish 4H are penalised and listed as conflicts", () => {
  const frames = { "5m": bearFrames["5m"], "15m": bearFrames["15m"], "1h": bearFrames["1h"], "4h": bullFrames["4h"] };
  const t = run(frames).byTf["15m"];
  assert.ok(t.bear.penalties.some((p) => p.name === "Opposing 4H evidence"), JSON.stringify(t.bear.penalties));
  assert.ok(t.bear.conflictTfs.includes("4h"));
  assert.ok(!t.bear.agreeTfs.includes("4h"));
  const agree = run(bearFrames).byTf["15m"];
  assert.ok(agree.bear.agreeTfs.length >= 2);
  assert.ok(agree.bear.score > t.bear.score, "agreeing timeframes score higher than conflicting ones");
});

test("both sides strong and close -> NO CLEAR SIGNAL (conflicting), not a coin-flip signal", () => {
  const r = run(bullFrames, { settings: { conflictMargin: 200 } }).byTf["15m"];
  assert.equal(r.conflicting, false); // needs BOTH sides above the early line
  const forced = run(bullFrames, { settings: { earlyMin: 0, conflictMargin: 200 } }).byTf["15m"];
  assert.equal(forced.conflicting, true);
  assert.ok([R.NONE, R.BREAKOUT, R.BREAKDOWN, R.FALSE_RISK, R.POT_BREAKOUT, R.POT_BREAKDOWN].includes(forced.state));
  assert.ok(![R.BULL_CONF, R.BEAR_CONF, R.EARLY_BULL, R.EARLY_BEAR].includes(forced.state));
});

// ---- data quality ----------------------------------------------------------
test("missing derivative data is UNAVAILABLE, never zero; max possible score shrinks", () => {
  const without = run(bullFrames).byTf["15m"];
  const flow = without.bull.comps.find((c) => c.key === "flow");
  assert.equal(flow.available, false);
  assert.match(flow.note, /UNAVAILABLE/);
  assert.ok(without.flags.includes("OI/FUNDING/RATIO UNAVAILABLE"));
  const withD = run(bullFrames, { deriv: { "15m": ext({ oi: [1100, 1090, 1080, 1060, 1040, 1020] }) } }).byTf["15m"];
  assert.equal(withD.bull.comps.find((c) => c.key === "flow").available, true);
  assert.ok(withD.bull.maxPossible > without.bull.maxPossible);
  const dm = derivMetrics(null, bullFrames["15m"].closed, bullFrames["15m"]);
  assert.equal(dm.available, false);
  for (const k of ["oiChg5", "takerRatio", "lsChg5", "funding"]) assert.equal(dm[k], null, k);
  const partial = derivMetrics({ oi: null, ls: null, taker: [{ t: 1, ratio: 1.3 }], funding: null, errors: ["open interest: failed"] }, bullFrames["15m"].closed, bullFrames["15m"]);
  assert.equal(partial.oiChg5, null);
  assert.equal(partial.takerRatio, 1.3);
  assert.deepEqual(partial.errors, ["open interest: failed"]);
});

test("insufficient / missing / stale data: INSUFFICIENT DATA, DATA STALE, never a crash", () => {
  const r1 = run({ ...bullFrames, "4h": null });
  assert.equal(r1.byTf["4h"].state, R.INSUFFICIENT);
  assert.equal(r1.byTf["15m"].ok, true);
  assert.match(r1.byTf["15m"].bull.comps.find((c) => c.key === "agree").note, /agrees|conflicts/);
  const short = analyzeFrame(klines("15m", bullCloses.slice(-40), null), NOW, "15m");
  assert.equal(run({ ...bullFrames, "15m": short }).byTf["15m"].state, R.INSUFFICIENT);
  for (const bad of ["0", "-3", "abc", ""]) assert.equal(run(bullFrames, { live: { ticker: { lastPrice: bad, quoteVolume: "1" } } }).byTf["15m"].state, R.INSUFFICIENT);
  assert.equal(run(bullFrames, { live: { ticker: null } }).byTf["15m"].state, R.INSUFFICIENT);
  const stale = run(bullFrames, { ages: { ...ages0, "15m": 8 * 60000 } }).byTf["15m"];
  assert.equal(stale.state, R.STALE);
  assert.deepEqual(stale.signals, []);
  assert.ok(stale.bull.penalties.some((p) => p.name === "Stale data"));
  const dead = run(bullFrames, { ages: { ...ages0, "15m": 40 * 60000 } }).byTf["15m"];
  assert.equal(dead.state, R.INSUFFICIENT);
  // zero / negative values inside candles are dropped, not used
  const raw = klines("15m", bullCloses, bullVols);
  raw[100][4] = "0";
  raw[101][2] = "-5";
  assert.doesNotThrow(() => analyzeFrame(raw, NOW, "15m"));
});

test("low liquidity is penalised and reported", () => {
  const rich = run(bullFrames).byTf["15m"];
  const thin = run(bullFrames, { live: liveFor(bullFrames, { quoteVolume: "2000000" }) }).byTf["15m"];
  assert.ok(thin.bull.penalties.some((p) => p.name === "Low liquidity"));
  assert.ok(thin.bull.score < rich.bull.score);
});

test("scores are bounded 0-100 and component caps are never exceeded", () => {
  for (const frames of [bullFrames, bearFrames]) {
    const r = run(frames, { deriv: { "15m": ext({ oi: [1100, 1090, 1080, 1060, 1040, 1020] }) } });
    for (const tf of REV_TFS) {
      const t = r.byTf[tf];
      for (const side of [t.bull, t.bear]) {
        assert.ok(side.score >= 0 && side.score <= 100);
        assert.ok(side.comps.every((c) => c.points >= 0 && c.points <= c.max + 1e-9));
        assert.equal(side.comps.reduce((a, c) => a + c.max, 0), 100);
      }
    }
  }
});

// ---- flow (large-player proxies) --------------------------------------------
const base = { oiChg5: null, takerRatio: null, takerShareKline: null, funding: null, fundingExtreme: false, lsChg5: null, relVolMax: null, priceMoveAtr: 0, nearSupport: false, nearResistance: false, afterDecline: false, afterAdvance: false };
test("classifyFlow: price/OI combinations", () => {
  assert.equal(classifyFlow({ ...base, priceMoveAtr: 1.2, oiChg5: 3 }).label, FLOW.LONGS);
  assert.equal(classifyFlow({ ...base, priceMoveAtr: -1.2, oiChg5: 3 }).label, FLOW.SHORTS);
  assert.equal(classifyFlow({ ...base, priceMoveAtr: 1.2, oiChg5: -3 }).label, FLOW.COVER);
  assert.equal(classifyFlow({ ...base, priceMoveAtr: -1.2, oiChg5: -3 }).label, FLOW.LIQ);
  assert.equal(classifyFlow({ ...base, priceMoveAtr: 0.1, oiChg5: 3 }).label, FLOW.NONE);
  assert.equal(classifyFlow(base).label, FLOW.NONE);
});
test("classifyFlow: accumulation / distribution need several independent conditions, not one", () => {
  const acc = { ...base, nearSupport: true, afterDecline: true, priceMoveAtr: 0.2, relVolMax: 2.4, takerRatio: 1.3, oiChg5: 2.5, funding: 0.0001 };
  const a = classifyFlow(acc);
  assert.equal(a.label, FLOW.ACCUM);
  assert.ok(a.reasons.length >= 4);
  assert.equal(a.kind, "INFERRED");
  assert.match(a.note, /not proof/);
  assert.equal(classifyFlow({ ...acc, takerRatio: 0.8 }).label === FLOW.ACCUM, false);
  assert.equal(classifyFlow({ ...acc, relVolMax: 0.8 }).label === FLOW.ACCUM, false);
  const dist = { ...base, nearResistance: true, afterAdvance: true, priceMoveAtr: -0.1, relVolMax: 2.1, takerRatio: 0.78, oiChg5: 2.0, funding: 0.0006 };
  assert.equal(classifyFlow(dist).label, FLOW.DISTRIB);
  // only volume: not enough
  assert.equal(classifyFlow({ ...base, relVolMax: 5 }).label, FLOW.NONE);
  // missing data is listed, not assumed
  assert.deepEqual(classifyFlow(base).missing.sort(), ["funding", "long/short ratio", "open interest", "taker buy/sell"]);
  // output never contains positions / entries / PnL
  const txt = JSON.stringify({ ...a, note: "" }).toLowerCase();
  for (const w of ["average entry", "unrealized", "pnl", "position size"]) assert.ok(!txt.includes(w), w);
});

// ---- signal history -----------------------------------------------------------
test("signal log: one entry per state change, no duplicates, ignores non-actionable states, bounded", () => {
  const log = createSignalLog(3);
  const rec = (state, c = 1) => log.record({ symbol: "A", tf: "15m", state, dir: 1, bull: 60, bear: 10, price: 1, candleTime: c, at: c });
  assert.equal(rec(R.NONE), null);
  assert.ok(rec(R.EARLY_BULL, 10));
  assert.equal(rec(R.EARLY_BULL, 11), null, "same state on a later candle is not a new signal");
  assert.equal(rec(R.INSUFFICIENT, 12), null);
  assert.ok(rec(R.EARLY_BULL, 13), "state returned after a gap -> logged again");
  assert.ok(rec(R.BULL_CONF, 14));
  assert.ok(log.record({ symbol: "B", tf: "1h", state: R.BREAKOUT, dir: 1, bull: 0, bear: 0, price: 1, candleTime: 1, at: 1 }));
  assert.equal(log.entries.length, 3);
  assert.equal(log.entries[0].symbol, "B");
  const log2 = createSignalLog();
  log2.load(log.entries);
  assert.equal(log2.record({ symbol: "B", tf: "1h", state: R.BREAKOUT, dir: 1, bull: 0, bear: 0, price: 1, candleTime: 2, at: 2 }), null);
});

// ---- data layer: extended derivatives, caching, errors, rate limits ----------------
const resp = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
test("scanner.getDerivExt: official endpoints, partial failures stay null, cache + de-duplication", async () => {
  const calls = [];
  const fapiFetch = async (url) => {
    calls.push(url);
    await new Promise((r) => setImmediate(r));
    if (url.includes("openInterestHist")) return resp(Array.from({ length: 30 }, (_, i) => ({ timestamp: 1000 + i, sumOpenInterestValue: String(1000 + i * 5), sumOpenInterest: "1" })));
    if (url.includes("globalLongShortAccountRatio")) return resp(Array.from({ length: 30 }, (_, i) => ({ timestamp: 1000 + i, longShortRatio: String(1 + i / 100), longAccount: "0.5", shortAccount: "0.5" })));
    if (url.includes("takerlongshortRatio")) return resp([], 200); // empty -> UNAVAILABLE
    if (url.includes("fundingRate")) return resp([{ fundingTime: 1, fundingRate: "0.0001" }, { fundingTime: 2, fundingRate: "0.0002" }]);
    return resp({}, 404);
  };
  const sc = createRadarScanner({ fapiFetch, sleep: async () => {} });
  const [a, b] = await Promise.all([sc.getDerivExt("AAAUSDT", "15m"), sc.getDerivExt("AAAUSDT", "15m")]);
  assert.equal(calls.length, 4, "4 requests, shared by both callers");
  assert.equal(a, b);
  assert.equal(a.oi.length, 30);
  assert.equal(a.taker, null);
  assert.ok(a.errors.some((e) => /taker/.test(e)));
  assert.equal(a.funding[1].rate, 0.0002);
  await sc.getDerivExt("AAAUSDT", "15m");
  assert.equal(calls.length, 4, "second call served from cache");
  assert.ok(calls.every((u) => /fapi\.binance\.com\/(futures\/data|fapi\/v1)\//.test(u)), "documented public endpoints only");
  assert.ok(calls.some((u) => /period=15m/.test(u)));
  await assert.rejects(() => sc.getDerivExt("AAAUSDT", "3m"), /Unsupported/);
  assert.equal(sc.peekDerivExt("AAAUSDT", "15m"), a);
});

test("scanner.getDerivExt: rate limiting (429) surfaces as RateLimitedError after bounded retries", async () => {
  let n = 0;
  const sc = createRadarScanner({ fapiFetch: async () => { n++; return resp({}, 429); }, sleep: async () => {}, blockedSecondsLeft: () => 0 });
  await assert.rejects(() => sc.getDerivExt("AAAUSDT", "1h"), (e) => e.rateLimited === true);
  assert.ok(n <= 16, "bounded: " + n);
});
