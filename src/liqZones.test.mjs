// Tests for the liquidation heatmap & liquidity zones engine.  node --test src/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { analyzeFrame, TF_MS } from "./entryRadar.js";
import {
  LIQ_KIND, LIQ_DEFAULTS, LIQ_EVENT as EV, normalizeSymbol, distanceInfo, estimateLevels, observedZones,
  depthWalls, heatBins, buildLiquidityMap, planForZone, fmtUsd,
} from "./liqZones.js";
import { createRadarScanner } from "./radarScanner.js";

const NOW = Date.UTC(2026, 9, 11, 12, 7, 30);
function path(n, pts) {
  const out = [];
  for (let i = 0; i < n; i++) {
    let k = 0;
    while (k < pts.length - 2 && i > pts[k + 1][0]) k++;
    const [i0, p0] = pts[k], [i1, p1] = pts[k + 1];
    out.push(p0 + (p1 - p0) * Math.min(1, Math.max(0, (i - i0) / (i1 - i0))));
  }
  return out;
}
// last candle = forming. `edit` can override single raw candles: { idx: {h,l,c,o,v} }
function klines(tf, closes, { vols, edit = {}, now = NOW, wick = 0.0012 } = {}) {
  const ms = TF_MS[tf];
  const n = closes.length;
  const lastOpen = Math.floor(now / ms) * ms;
  let prev = closes[0];
  return closes.map((c, i) => {
    const open = lastOpen - (n - 1 - i) * ms;
    const o = prev;
    let h = Math.max(o, c) * (1 + wick), l = Math.min(o, c) * (1 - wick);
    let v = vols ? vols[i] : 1000;
    let cc = c;
    const e = edit[i];
    if (e) { if (e.h !== undefined) h = e.h; if (e.l !== undefined) l = e.l; if (e.c !== undefined) cc = e.c; if (e.v !== undefined) v = e.v; }
    prev = c;
    return [open, String(o), String(h), String(l), String(cc), String(v), open + ms - 1, String(v * cc), 10, String(v * 0.5), "0", "0"];
  });
}
const N = 225;
const frameOf = (closes, opts, tf = "1h") => analyzeFrame(klines(tf, closes, opts), NOW, tf);
// two equal highs at 105 (idx 60, 130), price ends near 100.5
const EQ_HIGHS = path(N, [[0, 100], [60, 105], [85, 100], [130, 105], [160, 99], [224, 100.5]]);
const EQ_LOWS = path(N, [[0, 100], [60, 95], [85, 100], [130, 95], [160, 101], [224, 99.5]]);
const mkMap = (frame, extra = {}) => buildLiquidityMap({ symbol: "TESTUSDT", tf: "1h", frame, ages: { "1h": 0 }, now: NOW, ...extra });
const ext = ({ oi, funding = 0.0001 } = {}) => ({
  oi: oi ? oi.map((v, i) => ({ t: i, v })) : null,
  funding: funding === null ? null : [{ t: 1, rate: funding }, { t: 2, rate: funding }], errors: [],
});

test("normalizeSymbol: BTCUSDT, BTC/USDT, btc usdt and bare BTC all give BTCUSDT; junk gives null", () => {
  for (const s of ["BTCUSDT", "BTC/USDT", "btc usdt", "btc", " BTC-USDT "]) assert.equal(normalizeSymbol(s), "BTCUSDT");
  assert.equal(normalizeSymbol(""), null);
  assert.equal(normalizeSymbol(null), null);
  assert.equal(normalizeSymbol("USDT"), null);
});

test("distanceInfo: above / below / inside, in price and percent", () => {
  assert.deepEqual(distanceInfo({ lo: 105, hi: 106 }, 100), { abs: 5, pct: 5, side: "above" });
  const b = distanceInfo({ lo: 90, hi: 95 }, 100);
  assert.equal(b.side, "below");
  assert.equal(b.abs, 5);
  assert.equal(distanceInfo({ lo: 99, hi: 101 }, 100).side, "inside");
  assert.equal(distanceInfo({ lo: 99, hi: 101 }, 100).abs, 0);
  assert.equal(distanceInfo(null, 100).abs, null);
  assert.equal(distanceInfo({ lo: 1, hi: 2 }, NaN).pct, null);
});

test("estimateLevels: liquidation price math, and a level already traded through is consumed", () => {
  const cfg = { ...LIQ_DEFAULTS, leverages: [10], leverageWeights: { 10: 1 } };
  const closed = [
    { t: 0, o: 100, h: 100.5, l: 99.5, c: 100, v: 1, qv: 100 },
    { t: 1, o: 100, h: 101, l: 99, c: 100, v: 1, qv: 100 },
  ];
  const a = { i: 0, price: 100, w: 1, bias: 1, rec: 1, rel: 1 };
  const lv = estimateLevels([a], closed, null, 100, cfg);
  const longs = lv.filter((x) => x.side === -1), shorts = lv.filter((x) => x.side === 1);
  assert.equal(longs.length, 1);
  assert.ok(Math.abs(longs[0].price - 100 * (1 - 0.1 + 0.005)) < 1e-9, "long liq = P(1-1/L+mmr)");
  assert.ok(Math.abs(shorts[0].price - 100 * (1 + 0.1 - 0.005)) < 1e-9, "short liq = P(1+1/L-mmr)");
  assert.ok(longs[0].w > shorts[0].w, "a long-biased anchor weighs the long side more");
  // a later candle trades through the long liquidation (90.5) -> consumed
  const hit = [...closed, { t: 2, o: 100, h: 100, l: 90, c: 95, v: 1, qv: 100 }];
  assert.equal(estimateLevels([a], hit, null, 95, cfg).filter((x) => x.side === -1).length, 0);
  // the forming candle counts too
  assert.equal(estimateLevels([a], closed, { l: 90, h: 100 }, 100, cfg).filter((x) => x.side === -1).length, 0);
  // current price already beyond the level -> not a future level
  assert.equal(estimateLevels([a], closed, null, 90, cfg).filter((x) => x.side === -1).length, 0);
});

test("estimated zones: labelled as estimates, sit on the right side, strengths 0-100 with transparent components", () => {
  const m = mkMap(frameOf(EQ_HIGHS), { ext: ext({ oi: [100, 101, 102, 103, 104, 106, 108] }) });
  assert.ok(m.ok);
  const est = m.zones.filter((z) => z.kind === LIQ_KIND.ESTIMATED);
  assert.ok(est.length > 0, "some estimated zones");
  for (const z of est) {
    assert.equal(z.label, "Estimated Liquidation Zone");
    assert.match(z.dir, /\(estimated\)/);
    assert.ok(z.strength >= 0 && z.strength <= 100);
    assert.ok(z.comps.length >= 6);
    assert.equal(z.source, "ESTIMATE");
    if (z.side === "above") assert.ok(z.lo > m.price); else assert.ok(z.hi < m.price);
    assert.ok(z.distPct >= 0 && z.distAbs >= 0);
    assert.ok(typeof z.invalidation.text === "string" && z.invalidation.text.length > 5);
  }
  assert.ok(m.assumptions.some((a) => /leverage mix/.test(a)) && m.assumptions.some((a) => /maintenance-margin/.test(a)));
  // no observed events were supplied, so nothing may be called OBSERVED
  assert.equal(m.zones.filter((z) => z.kind === LIQ_KIND.OBSERVED).length, 0);
});

test("missing derivatives are UNAVAILABLE and lower the maximum, never counted as zero evidence", () => {
  const noExt = mkMap(frameOf(EQ_HIGHS));
  const withExt = mkMap(frameOf(EQ_HIGHS), { ext: ext({ oi: [100, 101, 102, 103, 104, 106, 108] }) });
  const a = noExt.zones.find((z) => z.kind === LIQ_KIND.ESTIMATED);
  const oi = a.comps.find((c) => c.key === "oi");
  assert.equal(oi.available, false);
  assert.match(oi.note, /UNAVAILABLE/);
  const b = withExt.zones.find((z) => z.kind === LIQ_KIND.ESTIMATED);
  assert.ok(b.maxPossible > a.maxPossible);
  for (const f of ["OI UNAVAILABLE", "ORDER BOOK UNAVAILABLE", "LIQUIDATION STREAM NOT CONNECTED", "MARK PRICE UNAVAILABLE"]) assert.ok(noExt.flags.includes(f), f);
  assert.match(noExt.priceSource, /mark price UNAVAILABLE/);
  assert.equal(noExt.context.oiChg, null);
  assert.equal(noExt.context.funding, null);
});

test("equal highs become a LIQUIDITY pool (never a liquidation cluster); a single swing is weaker", () => {
  const m = mkMap(frameOf(EQ_HIGHS));
  const pools = m.zones.filter((z) => z.kind === LIQ_KIND.LIQUIDITY);
  const eq = pools.find((z) => z.touches >= 2 && z.poolSide === 1);
  assert.ok(eq, "equal highs pool found");
  assert.equal(eq.dir, "BUY-SIDE LIQUIDITY");
  assert.equal(eq.side, "above");
  assert.match(eq.label, /equal highs/);
  assert.ok(eq.level > 104.9 && eq.level < 105.5);
  assert.ok(eq.evidence.some((e) => /ASSUMED/.test(e)), "says stops are assumed");
  assert.ok(!/liquidation/i.test(eq.label + eq.dir));
  const single = pools.find((z) => z.touches === 1);
  if (single) assert.ok(single.strength <= eq.strength || single.comps[0].points < eq.comps[0].points);
});

test("confirmed buy-side sweep: wick above the equal highs and a CLOSE back inside", () => {
  const edit = { [N - 4]: { h: 106.2 } };
  const m = mkMap(frameOf(EQ_HIGHS, { edit }));
  const sw = m.events.find((e) => e.type === EV.SWEEP_BUY);
  assert.ok(sw, JSON.stringify(m.events.map((e) => [e.type, e.state])));
  assert.equal(sw.state, "CONFIRMED");
  assert.equal(sw.barsAgo, 2);
  assert.ok(sw.evidence.some((e) => /ATR beyond/.test(e)));
  assert.match(sw.implication, /bearish/);
  // the swept pool is no longer an active zone
  assert.ok(!m.zones.some((z) => z.kind === LIQ_KIND.LIQUIDITY && z.poolSide === 1 && z.touches >= 2));
});

test("sweep: a wick that is too small is not a sweep; the forming candle only gives a POTENTIAL", () => {
  const tiny = mkMap(frameOf(EQ_HIGHS, { edit: { [N - 4]: { h: 105.14 } } }));
  assert.ok(!tiny.events.some((e) => e.type === EV.SWEEP_BUY && e.state === "CONFIRMED"));
  // forming candle (last) trades beyond the level, nothing has closed there
  const forming = mkMap(frameOf(EQ_HIGHS, { edit: { [N - 1]: { h: 106.5 } } }), { market: { mark: 106.3, depth: null } });
  const pot = forming.events.find((e) => e.type === EV.SWEEP_BUY);
  assert.ok(pot, JSON.stringify(forming.events.map((e) => [e.type, e.state])));
  assert.equal(pot.state, "POTENTIAL");
  assert.ok(pot.conflicting.some((c) => /closes back inside/.test(c)));
});

test("breakout that holds vs a false breakout (close beyond, then back inside)", () => {
  const hold = EQ_HIGHS.slice();
  for (let i = N - 6; i < N - 1; i++) hold[i] = 106 + (i - (N - 6)) * 0.1;
  const h = mkMap(frameOf(hold));
  const bh = h.events.find((e) => e.type === EV.BREAKOUT_HOLD);
  assert.ok(bh, JSON.stringify(h.events.map((e) => [e.type, e.state])));
  assert.equal(bh.state, "CONFIRMED");
  assert.ok(bh.evidence.some((e) => /closes above/.test(e)));
  const fake = EQ_HIGHS.slice();
  fake[N - 5] = 106; // one close beyond ...
  for (let i = N - 4; i < N - 1; i++) fake[i] = 104.5; // ... then back inside
  const f = mkMap(frameOf(fake));
  assert.ok(f.events.some((e) => e.type === EV.FALSE_BREAK && e.state === "CONFIRMED"), JSON.stringify(f.events.map((e) => [e.type, e.state])));
  assert.ok(!f.events.some((e) => e.type === EV.BREAKOUT_HOLD && e.state === "CONFIRMED"));
  // only the breakout candle so far -> potential, not confirmed
  const pend = EQ_HIGHS.slice();
  pend[N - 2] = 106;
  const p = mkMap(frameOf(pend));
  const pe = p.events.find((e) => e.type === EV.BREAKOUT_HOLD);
  assert.ok(pe && pe.state === "POTENTIAL");
});

test("breakout without volume/OI confirmation is flagged as false-breakout risk", () => {
  const hold = EQ_HIGHS.slice();
  for (let i = N - 6; i < N - 1; i++) hold[i] = 106 + (i - (N - 6)) * 0.1;
  const vols = Array.from({ length: N }, (_, i) => (i >= N - 6 ? 300 : 1000));
  const m = mkMap(frameOf(hold, { vols }), { ext: ext({ oi: [100, 100, 100, 99, 97, 95, 93] }) });
  const risk = m.events.find((e) => e.type === EV.FALSE_RISK);
  assert.ok(risk && risk.state === "POTENTIAL");
  assert.ok(risk.evidence.some((e) => /volume/.test(e)));
});

// sell-side pool broken on closes for ~5 candles
const BREAK_DOWN = path(N, [[0, 100], [60, 95], [85, 100], [130, 95], [160, 101], [218, 95], [224, 92]]);
test("long-liquidation cascade is NEVER inferred from price movement alone", () => {
  const m = mkMap(frameOf(BREAK_DOWN));
  assert.ok(m.events.some((e) => e.type === EV.BREAKDOWN_HOLD), "the breakdown itself is detected");
  assert.ok(!m.events.some((e) => e.type === EV.CASCADE), "but no cascade without OI or observed liquidations");
  assert.match(m.assess.cascade, /UNAVAILABLE/);
});

test("cascade: POTENTIAL with an OI drop, CONFIRMED only with observed long liquidations", () => {
  const withOi = mkMap(frameOf(BREAK_DOWN), { ext: ext({ oi: [110, 110, 109, 108, 105, 102, 100] }) });
  const c1 = withOi.events.find((e) => e.type === EV.CASCADE);
  assert.ok(c1 && c1.state === "POTENTIAL");
  assert.ok(c1.conflicting.some((c) => /no observed liquidation/.test(c)));
  const obs = [{ t: NOW - 60000, symbol: "TESTUSDT", side: "SELL", price: 93, qty: 5000, notional: 465_000 }];
  const confirmed = mkMap(frameOf(BREAK_DOWN), { observed: obs });
  const c2 = confirmed.events.find((e) => e.type === EV.CASCADE);
  assert.ok(c2 && c2.state === "CONFIRMED");
  assert.ok(c2.evidence.some((e) => /LONG liquidations observed/.test(e)));
  // observed BUY-side orders (short liquidations) do not confirm a long cascade
  const wrong = mkMap(frameOf(BREAK_DOWN), { observed: obs.map((o) => ({ ...o, side: "BUY" })) });
  assert.ok(!wrong.events.some((e) => e.type === EV.CASCADE));
  // OI that is rising during the drop is not a cascade
  const rising = mkMap(frameOf(BREAK_DOWN), { ext: ext({ oi: [100, 101, 102, 103, 104, 105, 106] }) });
  assert.ok(!rising.events.some((e) => e.type === EV.CASCADE));
});

test("short squeeze needs OI falling or observed short liquidations, not just a rising price", () => {
  const UP = path(N, [[0, 100], [60, 105], [85, 100], [130, 105], [160, 99], [218, 105], [224, 108]]);
  const priceOnly = mkMap(frameOf(UP));
  assert.ok(!priceOnly.events.some((e) => e.type === EV.SQUEEZE));
  assert.match(priceOnly.assess.squeeze, /UNAVAILABLE/);
  const oiDrop = mkMap(frameOf(UP), { ext: ext({ oi: [110, 110, 109, 108, 105, 102, 100], funding: -0.0003 }) });
  const sq = oiDrop.events.find((e) => e.type === EV.SQUEEZE);
  assert.ok(sq && sq.state === "POTENTIAL");
  assert.ok(sq.evidence.some((e) => /funding is negative/.test(e)));
  const obs = [{ t: NOW - 30000, symbol: "TESTUSDT", side: "BUY", price: 107, qty: 3000, notional: 321_000 }];
  assert.equal(mkMap(frameOf(UP), { observed: obs }).events.find((e) => e.type === EV.SQUEEZE).state, "CONFIRMED");
});

test("observed liquidation zones: clustered, typed OBSERVED, side-correct, from supplied events only", () => {
  const ev = [
    { t: NOW - 1000, symbol: "AAAUSDT", side: "SELL", price: 95.0, notional: 200_000 },
    { t: NOW - 2000, symbol: "AAAUSDT", side: "SELL", price: 95.05, notional: 150_000 },
    { t: NOW - 3000, symbol: "AAAUSDT", side: "BUY", price: 110, notional: 50_000 },
    { t: NOW - 3000, symbol: "OTHERUSDT", side: "SELL", price: 95, notional: 9e9 },
    { t: NOW - 3000, symbol: "AAAUSDT", side: "SELL", price: NaN, notional: 1 },
  ];
  const z = observedZones({ symbol: "AAAUSDT", tf: "1h", events: ev, price: 100, atr: 1, cfg: LIQ_DEFAULTS, now: NOW });
  assert.equal(z.length, 2);
  const big = z.find((x) => x.dir.startsWith("LONG"));
  assert.equal(big.kind, LIQ_KIND.OBSERVED);
  assert.equal(big.parts.count, 2);
  assert.equal(big.side, "below");
  assert.equal(big.source, "OBSERVED");
  assert.ok(big.strength > z.find((x) => x.dir.startsWith("SHORT")).strength);
  assert.deepEqual(observedZones({ symbol: "AAAUSDT", tf: "1h", events: [], price: 100, atr: 1, cfg: LIQ_DEFAULTS, now: NOW }), []);
  assert.equal(fmtUsd(null), "UNAVAILABLE");
  assert.equal(fmtUsd(2_500_000), "$2.50M");
});

test("depth walls: big resting orders only, bids below / asks above, labelled as snapshot", () => {
  const bids = [], asks = [];
  for (let i = 1; i <= 60; i++) { bids.push([String(100 - i * 0.05), "10"]); asks.push([String(100 + i * 0.05), "10"]); }
  bids[20] = [bids[20][0], "5000"];
  const w = depthWalls({ symbol: "XUSDT", tf: "1h", depth: { bids, asks }, price: 100, atr: 1, cfg: LIQ_DEFAULTS, now: NOW });
  assert.equal(w.length, 1);
  assert.equal(w[0].side, "below");
  assert.equal(w[0].dir, "ORDER-BOOK BUY WALL");
  assert.match(w[0].evidence.join(" "), /cancelled or spoofed/);
  assert.deepEqual(depthWalls({ symbol: "XUSDT", tf: "1h", depth: null, price: 100, atr: 1, cfg: LIQ_DEFAULTS, now: NOW }), []);
  assert.deepEqual(depthWalls({ symbol: "XUSDT", tf: "1h", depth: { bids: [["x", "y"]], asks: [] }, price: 100, atr: 1, cfg: LIQ_DEFAULTS, now: NOW }), []);
});

test("heat bins are normalised 0..1 and only built from estimated levels", () => {
  const lv = [{ price: 90, w: 2, side: -1 }, { price: 90.01, w: 2, side: -1 }, { price: 110, w: 1, side: 1 }];
  const bins = heatBins(lv, 100, 1);
  assert.equal(Math.max(...bins.map((b) => b.v)), 1);
  assert.ok(bins.every((b) => b.v > 0 && b.v <= 1));
  assert.deepEqual(heatBins([], 100, 1), []);
});

test("insufficient, stale and short data give explicit states instead of zones", () => {
  assert.equal(mkMap(null).state, "INSUFFICIENT");
  assert.match(mkMap(null).reason, /not loaded/);
  const short = frameOf(EQ_HIGHS.slice(0, 35));
  assert.equal(mkMap(short).state, "INSUFFICIENT");
  const stale = buildLiquidityMap({ symbol: "T", tf: "1h", frame: frameOf(EQ_HIGHS), ages: { "1h": 25 * 60000 }, now: NOW });
  assert.equal(stale.state, "STALE");
  assert.equal(stale.zones.length, 0);
  const aging = buildLiquidityMap({ symbol: "T", tf: "1h", frame: frameOf(EQ_HIGHS), ages: { "1h": 8 * 60000 }, now: NOW });
  assert.ok(aging.ok && aging.stale && aging.flags.includes("STALE"));
  // an old mark price is as bad as old candles
  assert.equal(buildLiquidityMap({ symbol: "T", tf: "1h", frame: frameOf(EQ_HIGHS), ages: { "1h": 0, mark: 30 * 60000 }, now: NOW }).state, "STALE");
});

test("mark price is used when available; distances are measured from it", () => {
  const f = frameOf(EQ_HIGHS);
  const a = mkMap(f);
  const b = mkMap(f, { market: { mark: 101.5, fundingRate: 0.0002, depth: null } });
  assert.equal(b.price, 101.5);
  assert.match(b.priceSource, /OFFICIAL mark/);
  assert.equal(b.context.funding, 0.0002);
  const za = a.zones.find((z) => z.kind === LIQ_KIND.LIQUIDITY && z.poolSide === 1);
  const zb = b.zones.find((z) => z.kind === LIQ_KIND.LIQUIDITY && z.poolSide === 1);
  assert.ok(za.distAbs > zb.distAbs);
  assert.ok(Math.abs(zb.distPct - (zb.lo - 101.5) / 101.5 * 100) < 1e-9);
});

test("lookback is configurable and changes the anchors used", () => {
  const f = frameOf(EQ_HIGHS);
  const long = mkMap(f, { settings: { lookback: 200 } });
  const short = mkMap(f, { settings: { lookback: 60 } });
  assert.equal(long.frame.lookback, 200);
  assert.equal(short.frame.lookback, 60);
  assert.notEqual(long.levelsCount, short.levelsCount);
  assert.equal(mkMap(f, { settings: { lookback: 9999 } }).frame.lookback, f.closed.length);
});

test("planForZone: stop/targets ordered, net R:R lower with fees+slippage, warns when too far or against 4H", () => {
  const m = mkMap(frameOf(EQ_HIGHS));
  const z = m.zones.find((x) => x.kind === LIQ_KIND.LIQUIDITY && x.poolSide === 1);
  const base = { price: m.price, atr: m.atr, zones: m.zones, events: m.events };
  const plan = planForZone(z, { ...base, settings: { feePct: 0, slippagePct: 0 } });
  assert.equal(plan.scenarios.length, 2);
  const rev = plan.scenarios[0], brk = plan.scenarios[1];
  assert.equal(rev.side, "SHORT");
  assert.ok(rev.stop > rev.entry, "short stop above entry");
  assert.ok(rev.targets.every((t) => t.price < rev.entry));
  assert.ok(rev.targets[0].price > rev.targets[1].price, "targets run away from entry");
  assert.equal(brk.side, "LONG");
  assert.ok(brk.stop < brk.entry && brk.targets.every((t) => t.price > brk.entry));
  const costly = planForZone(z, { ...base, settings: { feePct: 0.1, slippagePct: 0.1 } });
  assert.ok(costly.scenarios[0].targets[0].rr < rev.targets[0].rr, "costs reduce R:R");
  assert.ok(plan.warnings.some((w) => /not guaranteed/.test(w)));
  const far = planForZone(z, { ...base, price: z.lo - atrOf(m) * 12, atr: m.atr, settings: {} });
  assert.ok(far.warnings.some((w) => /too far/.test(w)));
  const bearish4h = frameOf(path(N, [[0, 120], [224, 90]]), {}, "4h");
  const conflict = planForZone(z, { ...base, frames: { "4h": bearish4h } });
  assert.ok(conflict.scenarios[1].warnings.some((w) => /Conflicts with the 4H trend/.test(w)), JSON.stringify(conflict.scenarios.map((s) => s.warnings)));
  assert.ok(!conflict.scenarios[0].warnings.some((w) => /Conflicts with the 4H/.test(w)), "a SHORT does not conflict with a bearish 4H");
  assert.deepEqual(planForZone(null, base).scenarios, []);
});
const atrOf = (m) => m.atr;

test("planForZone marks the scenario ready only when its trigger event is confirmed", () => {
  const edit = { [N - 4]: { h: 106.2 } };
  const m = mkMap(frameOf(EQ_HIGHS, { edit }));
  const zAll = m.events.find((e) => e.type === EV.SWEEP_BUY);
  assert.ok(zAll);
  // the swept pool is gone from zones; plan against a stand-in zone with the same id
  const z = { id: zAll.zoneId, kind: LIQ_KIND.LIQUIDITY, label: "Liquidity pool", lo: zAll.level - 0.1, hi: zAll.level, mid: zAll.level - 0.05, poolSide: 1 };
  const plan = planForZone(z, { price: m.price, atr: m.atr, zones: [], events: m.events });
  assert.equal(plan.scenarios[0].ready, true);
  assert.equal(plan.scenarios[1].ready, false);
});

test("scanner: mark price + depth are official endpoints, cached, de-duplicated; failures stay null", async () => {
  const calls = [];
  const fapiFetch = async (url) => {
    calls.push(url);
    if (/premiumIndex/.test(url)) return { ok: true, status: 200, json: async () => ({ symbol: "BTCUSDT", markPrice: "100.5", indexPrice: "100.4", lastFundingRate: "0.0001", nextFundingTime: 1 }) };
    if (/depth/.test(url)) return { ok: true, status: 200, json: async () => ({ bids: [["100", "1"]], asks: [["101", "1"]], lastUpdateId: 1 }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const sc = createRadarScanner({ fapiFetch, sleep: async () => {} });
  const [a, b] = await Promise.all([sc.getMark("BTCUSDT"), sc.getMark("BTCUSDT")]);
  assert.equal(a.mark, 100.5);
  assert.equal(b.mark, 100.5);
  assert.equal(calls.filter((u) => /premiumIndex/.test(u)).length, 1, "de-duplicated");
  await sc.getMark("BTCUSDT");
  assert.equal(calls.filter((u) => /premiumIndex/.test(u)).length, 1, "cached");
  const d = await sc.getDepth("BTCUSDT");
  assert.equal(d.bids.length, 1);
  assert.ok(calls.every((u) => u.startsWith("https://fapi.binance.com/fapi/v1/")), "only documented /fapi/v1 endpoints");
  // malformed mark price -> mark null (never 0)
  const sc2 = createRadarScanner({ fapiFetch: async () => ({ ok: true, status: 200, json: async () => ({ markPrice: "abc" }) }), sleep: async () => {} });
  assert.equal((await sc2.getMark("X")).mark, null);
  assert.equal(sc.peekMark("NOPE"), null);
});

import { parseForceOrder, createLiqStream } from "./liqStream.js";
const FO = (o = {}) => ({ e: "forceOrder", E: 1000, o: { s: "BTCUSDT", S: "SELL", q: "0.5", p: "100", ap: "99", X: "FILLED", l: "0.5", z: "0.4", T: 2000, ...o } });

test("liquidation stream: parses real forceOrder frames, rejects malformed ones, never invents values", () => {
  const e = parseForceOrder(FO());
  assert.deepEqual([e.symbol, e.side, e.price, e.qty, e.t], ["BTCUSDT", "SELL", 99, 0.4, 2000]);
  assert.ok(Math.abs(e.notional - 99 * 0.4) < 1e-9);
  assert.equal(parseForceOrder(FO({ S: "HOLD" })), null);
  assert.equal(parseForceOrder(FO({ ap: "x", p: "y" })), null);
  assert.equal(parseForceOrder(FO({ z: "0", q: "0" })), null);
  assert.equal(parseForceOrder({ e: "other" }), null);
  assert.equal(parseForceOrder(null), null);
});

test("liquidation stream: collects per symbol, bounded, ignores garbage, reports unsupported/open honestly", () => {
  const sockets = [];
  class FakeWS { constructor(u) { this.url = u; sockets.push(this); } close() { this.onclose && this.onclose(); } }
  const s = createLiqStream({ WebSocketImpl: FakeWS, perSymbol: 3, now: () => 5000 });
  assert.equal(s.info().status, "idle");
  s.start();
  assert.equal(sockets[0].url, "wss://fstream.binance.com/ws/!forceOrder@arr");
  assert.equal(s.info().status, "connecting");
  sockets[0].onopen();
  assert.equal(s.info().status, "open");
  for (let i = 0; i < 5; i++) sockets[0].onmessage({ data: JSON.stringify(FO({ T: 3000 + i })) });
  sockets[0].onmessage({ data: "not json" });
  sockets[0].onmessage({ data: JSON.stringify(FO({ s: "ETHUSDT", S: "BUY" })) });
  assert.equal(s.eventsFor("BTCUSDT").length, 3, "bounded per symbol");
  assert.equal(s.eventsFor("ETHUSDT")[0].side, "BUY");
  assert.equal(s.eventsFor("DOGEUSDT").length, 0);
  assert.equal(s.info().total, 6);
  s.stop();
  assert.equal(s.info().status, "closed");
  assert.equal(createLiqStream({ WebSocketImpl: null }).start() === undefined && createLiqStream({ WebSocketImpl: null }).info().status, "idle");
});

test("price source falls back from mark price to the 24h ticker price, and says which one is used", () => {
  const f = frameOf(EQ_HIGHS);
  const t = mkMap(f, { lastPrice: 102.25 });
  assert.equal(t.price, 102.25);
  assert.match(t.priceSource, /last price/);
  assert.match(t.priceSource, /mark price UNAVAILABLE/);
  assert.equal(mkMap(f, { lastPrice: 102.25, market: { mark: 103, depth: null } }).price, 103);
  assert.equal(mkMap(f, { lastPrice: NaN }).price, f.price);
  const sw = mkMap(f).swings;
  assert.ok(sw.length >= 4 && sw.every((x) => x.t > 0 && (x.type === "high" || x.type === "low")));
});
