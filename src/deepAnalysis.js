// src/deepAnalysis.js
//
// Market analysis engine for the "Deep Analysis" section. Pure functions, no
// network, no React — give it the candles the user chose and it reads ONLY
// those candles. Every conclusion is built from several independent factors;
// nothing here produces a BUY/SELL signal, and a reversal is never called
// "confirmed" unless many separate factors line up.
//
// Candle shape (Binance kline order): [openTime, open, high, low, close,
// baseVolume, closeTime, quoteVolume].

export const MIN_ANALYSIS_CANDLES = 20;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const sign = (v, dead = 0) => (v > dead ? 1 : v < -dead ? -1 : 0);

// ---------------------------------------------------------------- indicators

function emaSeries(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

// Wilder RSI, one value per candle (null until enough history).
function rsiSeries(c, period) {
  const n = c.length;
  const out = new Array(n).fill(null);
  if (n <= period) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = c[i] - c[i - 1];
    if (d >= 0) g += d;
    else l -= d;
  }
  let avgG = g / period;
  let avgL = l / period;
  const val = () => (avgL === 0 ? (avgG === 0 ? 50 : 100) : 100 - 100 / (1 + avgG / avgL));
  out[period] = val();
  for (let i = period + 1; i < n; i++) {
    const d = c[i] - c[i - 1];
    avgG = (avgG * (period - 1) + (d > 0 ? d : 0)) / period;
    avgL = (avgL * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = val();
  }
  return out;
}

// Wilder ADX, one value per candle (null until enough history).
function adxSeries(h, l, c, period) {
  const n = h.length;
  const out = new Array(n).fill(null);
  if (n < period * 2 + 1) return out;
  const tr = new Array(n).fill(0), pdm = new Array(n).fill(0), mdm = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = h[i] - h[i - 1];
    const dn = l[i - 1] - l[i];
    pdm[i] = up > dn && up > 0 ? up : 0;
    mdm[i] = dn > up && dn > 0 ? dn : 0;
    tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  }
  let trS = 0, pS = 0, mS = 0;
  for (let i = 1; i <= period; i++) {
    trS += tr[i];
    pS += pdm[i];
    mS += mdm[i];
  }
  const dx = new Array(n).fill(null);
  const calcDx = () => {
    if (trS === 0) return 0;
    const pdi = (100 * pS) / trS;
    const mdi = (100 * mS) / trS;
    return pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
  };
  dx[period] = calcDx();
  for (let i = period + 1; i < n; i++) {
    trS = trS - trS / period + tr[i];
    pS = pS - pS / period + pdm[i];
    mS = mS - mS / period + mdm[i];
    dx[i] = calcDx();
  }
  const first = 2 * period - 1;
  let adx = mean(dx.slice(period, first + 1));
  out[first] = adx;
  for (let i = first + 1; i < n; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
    out[i] = adx;
  }
  return out;
}

function linReg(values) {
  const n = values.length;
  if (n < 2) return { slope: 0, r2: 0 };
  const mx = (n - 1) / 2;
  const my = mean(values);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i - mx) * (values[i] - my);
    sxx += (i - mx) ** 2;
    syy += (values[i] - my) ** 2;
  }
  const slope = sxx ? sxy / sxx : 0;
  const r2 = sxx && syy ? (sxy * sxy) / (sxx * syy) : 0;
  return { slope, r2 };
}

// Confirmed swing points: a pivot needs `k` candles on each side.
function findPivots(h, l, k) {
  const highs = [], lows = [];
  const n = h.length;
  for (let i = k; i < n - k; i++) {
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

const EQ = 0.0005; // swings within 0.05% count as equal, not higher/lower

function labelSwings(highs, lows) {
  const c = { HH: 0, LH: 0, HL: 0, LL: 0 };
  for (let i = 1; i < highs.length; i++) {
    const r = (highs[i].price - highs[i - 1].price) / highs[i - 1].price;
    if (r > EQ) c.HH++;
    else if (r < -EQ) c.LH++;
  }
  for (let i = 1; i < lows.length; i++) {
    const r = (lows[i].price - lows[i - 1].price) / lows[i - 1].price;
    if (r > EQ) c.HL++;
    else if (r < -EQ) c.LL++;
  }
  return c;
}

function pivotRel(arr) {
  // 1 = last swing higher than the one before, -1 = lower, 0 = equal/unknown
  if (arr.length < 2) return 0;
  const r = (arr[arr.length - 1].price - arr[arr.length - 2].price) / arr[arr.length - 2].price;
  return r > EQ ? 1 : r < -EQ ? -1 : 0;
}

// ------------------------------------------------------------------ zones

// Clusters swing points + rejection wicks into price zones and scores them.
function buildZones(kind, ctx) {
  const { o, h, l, c, v, n, pivots, tol, avgVol } = ctx;
  const isSup = kind === "support";
  const pts = new Map();
  const pivotList = isSup ? pivots.lows : pivots.highs;
  pivotList.forEach((p) => pts.set(p.i, { i: p.i, price: p.price, pivot: true, wick: false }));
  for (let j = 0; j < n; j++) {
    const range = h[j] - l[j];
    if (range <= 0) continue;
    const body = Math.abs(c[j] - o[j]);
    const wick = isSup ? Math.min(o[j], c[j]) - l[j] : h[j] - Math.max(o[j], c[j]);
    const closesAway = isSup ? c[j] >= l[j] + range * 0.5 : c[j] <= h[j] - range * 0.5;
    const isRejection = wick / range >= 0.5 && wick >= body && closesAway;
    if (!isRejection) continue;
    const price = isSup ? l[j] : h[j];
    const ex = pts.get(j);
    if (ex) ex.wick = true;
    else pts.set(j, { i: j, price, pivot: false, wick: true });
  }
  const sorted = [...pts.values()].sort((a, b) => a.price - b.price);
  const clusters = [];
  sorted.forEach((p) => {
    const cur = clusters[clusters.length - 1];
    if (cur && p.price - cur.max <= tol && p.price - cur.min <= tol * 2) {
      cur.pts.push(p);
      cur.max = Math.max(cur.max, p.price);
    } else {
      clusters.push({ min: p.price, max: p.price, pts: [p] });
    }
  });

  const zones = clusters.map((cl) => {
    const low = cl.min;
    const high = cl.max;
    const touches = cl.pts.length;
    const wicks = cl.pts.filter((p) => p.wick).length;
    const lastIdx = Math.max(...cl.pts.map((p) => p.i));
    // volume traded while price was testing the zone, relative to normal
    const testVols = [];
    for (let j = 0; j < n; j++) {
      const edge = isSup ? l[j] : h[j];
      if (edge >= low - tol && edge <= high + tol) testVols.push(v[j]);
    }
    const volRatio = avgVol > 0 && testVols.length ? mean(testVols) / avgVol : 1;
    const volScore = clamp(volRatio * 50, 0, 100);
    const strength =
      0.4 * Math.min(100, (touches / 4) * 100) +
      0.25 * Math.min(100, (wicks / 3) * 100) +
      0.2 * volScore +
      0.15 * ((lastIdx / Math.max(1, n - 1)) * 100);
    return {
      low,
      high,
      mid: (low + high) / 2,
      touches,
      wicks,
      volRatio,
      lastIdx,
      strength: Math.round(clamp(strength, 0, 100)),
    };
  });
  return zones;
}

function pickSide(zones, price, above, count = 3) {
  const side = zones.filter((z) => (above ? z.mid > price : z.mid < price));
  const top = [...side].sort((a, b) => b.strength - a.strength).slice(0, count);
  // S1/R1 = nearest of the strongest, then outward
  return top.sort((a, b) => (above ? a.mid - b.mid : b.mid - a.mid));
}

// ------------------------------------------------------------------ main

export function analyzeCandles(candles) {
  const n = candles.length;
  if (n < MIN_ANALYSIS_CANDLES) return null;
  const o = candles.map((k) => parseFloat(k[1]));
  const h = candles.map((k) => parseFloat(k[2]));
  const l = candles.map((k) => parseFloat(k[3]));
  const c = candles.map((k) => parseFloat(k[4]));
  const v = candles.map((k) => parseFloat(k[7]));
  const last = c[n - 1];
  const avgVol = mean(v);

  // periods scale with window length so a short window isn't judged by a
  // 50-candle EMA it can't fill
  const emaSlowP = clamp(Math.round(n / 2), 3, 50);
  const emaFastP = Math.max(2, Math.round(emaSlowP * 0.4));
  const rsiP = clamp(n - 1, 2, 14);
  const adxP = clamp(Math.floor(n / 2) - 1, 2, 14);
  const macdSlowP = clamp(Math.round(n / 3), 5, 26);
  const macdFastP = Math.max(2, Math.round((macdSlowP * 12) / 26));
  const macdSigP = Math.max(2, Math.round((macdSlowP * 9) / 26));
  const swingK = n >= 300 ? 5 : n >= 120 ? 3 : 2;
  const params = { emaFastP, emaSlowP, rsiP, adxP, macdFastP, macdSlowP, macdSigP, swingK };

  const emaF = emaSeries(c, emaFastP);
  const emaS = emaSeries(c, emaSlowP);
  const rsi = rsiSeries(c, rsiP);
  const adx = adxSeries(h, l, c, adxP);
  const macdFastS = emaSeries(c, macdFastP);
  const macdSlowS = emaSeries(c, macdSlowP);
  const macdLine = macdFastS.map((x, i) => x - macdSlowS[i]);
  const macdSignal = emaSeries(macdLine, macdSigP);
  const macdHist = macdLine.map((x, i) => x - macdSignal[i]);

  // ATR over the last rsiP candles, and the average candle range as a % of price
  const trs = [];
  for (let i = 1; i < n; i++) trs.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  const atr = mean(trs.slice(-Math.max(3, rsiP))) || last * 0.005;
  const avgRangePct = mean(h.map((x, i) => ((x - l[i]) / c[i]) * 100)) || 0.1;

  const pivots = findPivots(h, l, swingK);
  const counts = labelSwings(pivots.highs, pivots.lows);
  const hRel = pivotRel(pivots.highs);
  const lRel = pivotRel(pivots.lows);

  // ============================ 1. TREND =================================
  const emaDir = last > emaF[n - 1] && emaF[n - 1] > emaS[n - 1] ? 1 : last < emaF[n - 1] && emaF[n - 1] < emaS[n - 1] ? -1 : 0;
  const reg = linReg(c);
  const totalSlopePct = (reg.slope * (n - 1)) / mean(c) * 100;
  const slopeDir = reg.r2 >= 0.35 && Math.abs(totalSlopePct) >= avgRangePct ? sign(reg.slope) : 0;
  const structure = hRel === 1 && lRel === 1 ? "BULLISH" : hRel === -1 && lRel === -1 ? "BEARISH" : "MIXED";
  const structDir = structure === "BULLISH" ? 1 : structure === "BEARISH" ? -1 : 0;
  const votes = emaDir + slopeDir + structDir;
  const trendDir = votes >= 2 ? 1 : votes <= -2 ? -1 : 0;
  const trendLabel = trendDir === 1 ? "UP" : trendDir === -1 ? "DOWN" : "SIDEWAYS";

  // continuing or weakening?
  const m = Math.max(3, Math.round(n / 5));
  const third = Math.max(5, Math.round(n / 3));
  const weakSignals = [];
  if (trendDir !== 0) {
    const adxNow = adx[n - 1];
    const adxBefore = adx[n - 1 - m];
    if (adxNow !== null && adxBefore !== null && adxBefore - adxNow >= 3) weakSignals.push("ADX is falling");
    const recent = linReg(c.slice(-third)).slope;
    if (trendDir * recent < trendDir * reg.slope * 0.4) weakSignals.push("recent price slope has flattened or turned");
    const hNow = macdHist[n - 1];
    const hPeak = trendDir === 1 ? Math.max(...macdHist.slice(-third)) : Math.min(...macdHist.slice(-third));
    if (trendDir * hNow < trendDir * hPeak * 0.6 && trendDir * hPeak > 0) weakSignals.push("MACD histogram is shrinking");
    if (trendDir * (last - emaF[n - 1]) < 0) weakSignals.push(`price has lost the EMA${emaFastP}`);
  }
  const trendState =
    trendDir === 0
      ? "Ranging — no established trend to continue"
      : weakSignals.length >= 2
      ? "Weakening"
      : weakSignals.length === 1
      ? "Continuing, with early fatigue"
      : "Continuing";

  // ======================== 2. TREND STRENGTH ============================
  const adxNow = adx[n - 1];
  const comps = [];
  if (adxNow !== null) comps.push({ name: "ADX", weight: 0.4, score: clamp(adxNow * 2, 0, 100), text: `ADX ${adxNow.toFixed(0)}` });
  const emaAligned = emaDir !== 0;
  comps.push({
    name: "EMA alignment",
    weight: 0.2,
    score: emaAligned ? clamp(40 + (Math.abs(emaF[n - 1] - emaS[n - 1]) / atr) * 30, 0, 100) : 15,
    text: emaAligned ? `price, EMA${emaFastP}, EMA${emaSlowP} aligned ${emaDir === 1 ? "up" : "down"}` : "EMAs not aligned",
  });
  comps.push({ name: "Price slope", weight: 0.2, score: clamp(reg.r2 * 100, 0, 100), text: `${totalSlopePct >= 0 ? "+" : ""}${totalSlopePct.toFixed(1)}% over the period, R² ${reg.r2.toFixed(2)}` });
  const swingTotal = counts.HH + counts.LH + counts.HL + counts.LL;
  if (swingTotal > 0) {
    const bullFrac = (counts.HH + counts.HL) / swingTotal;
    const dominant = trendDir === -1 ? 1 - bullFrac : trendDir === 1 ? bullFrac : Math.max(bullFrac, 1 - bullFrac);
    comps.push({ name: "Market structure", weight: 0.2, score: dominant * 100, text: `${counts.HH} HH · ${counts.HL} HL · ${counts.LH} LH · ${counts.LL} LL` });
  }
  const wSum = comps.reduce((s, x) => s + x.weight, 0);
  const strengthScore = Math.round(comps.reduce((s, x) => s + x.score * x.weight, 0) / wSum);
  const strengthLabel =
    strengthScore < 20 ? "Very Weak" : strengthScore < 40 ? "Weak" : strengthScore < 60 ? "Moderate" : strengthScore < 80 ? "Strong" : "Very Strong";

  // =========================== 3. MOMENTUM ===============================
  const rsiNow = rsi[n - 1];
  const rr = clamp(Math.round(n / 5), 3, 14);
  const roc = ((last - c[n - 1 - rr]) / c[n - 1 - rr]) * 100;
  const L = third;
  let upV = 0, dnV = 0, bodySigned = 0, bodyAbs = 0;
  for (let i = n - L; i < n; i++) {
    if (c[i] >= o[i]) upV += v[i];
    else dnV += v[i];
    bodySigned += c[i] - o[i];
    bodyAbs += Math.abs(c[i] - o[i]);
  }
  const volFlow = upV + dnV > 0 ? (upV - dnV) / (upV + dnV) : 0;
  const candleFlow = bodyAbs > 0 ? bodySigned / bodyAbs : 0;
  const macdScore = clamp(0.7 * (macdHist[n - 1] / (0.1 * atr)) + 0.3 * (macdLine[n - 1] / (0.5 * atr)), -1, 1);
  const mComps = [
    { name: "RSI", weight: 0.25, value: rsiNow === null ? 0 : clamp((rsiNow - 50) / 30, -1, 1), text: rsiNow === null ? "n/a" : `RSI${rsiP} ${rsiNow.toFixed(0)}` },
    { name: "MACD", weight: 0.25, value: macdScore, text: `histogram ${macdHist[n - 1] >= 0 ? "positive" : "negative"}, line ${macdLine[n - 1] >= 0 ? "above" : "below"} zero` },
    { name: "Rate of change", weight: 0.2, value: clamp(roc / (avgRangePct * Math.sqrt(rr) * 0.8), -1, 1), text: `${roc >= 0 ? "+" : ""}${roc.toFixed(2)}% over ${rr} candles` },
    { name: "Volume flow", weight: 0.15, value: volFlow, text: `${volFlow >= 0 ? "more volume on up" : "more volume on down"} candles (last ${L})` },
    { name: "Candle movement", weight: 0.15, value: candleFlow, text: `${candleFlow >= 0 ? "bullish" : "bearish"} bodies dominate (last ${L})` },
  ];
  const agg = mComps.reduce((s, x) => s + x.value * x.weight, 0);
  const mDirRaw = agg > 0.15 ? 1 : agg < -0.15 ? -1 : 0;
  const agreeCount = mComps.filter((x) => mDirRaw !== 0 && sign(x.value, 0.1) === mDirRaw).length;
  const mDir = mDirRaw !== 0 && agreeCount >= 3 ? mDirRaw : 0; // need 3 of 5 to agree
  const momentumLabel = mDir === 1 ? "BULLISH" : mDir === -1 ? "BEARISH" : "NEUTRAL";
  const momentumScore = Math.round(clamp(Math.abs(agg) * 140, 0, 100));

  // ====================== 4. REVERSAL DETECTION ==========================
  const rangeHi = Math.max(...h);
  const rangeLo = Math.min(...l);
  const pricePct = rangeHi > rangeLo ? (last - rangeLo) / (rangeHi - rangeLo) : 0.5;
  const lastTwo = (arr) => (arr.length >= 2 ? [arr[arr.length - 2], arr[arr.length - 1]] : null);
  const hi2 = lastTwo(pivots.highs);
  const lo2 = lastTwo(pivots.lows);
  const warm = macdSlowP; // MACD / RSI values before this are still settling
  const divergence = (series, bear) => {
    const pair = bear ? hi2 : lo2;
    if (!pair) return false;
    const [a, b] = pair;
    if (b.i - a.i < 3 || a.i < warm) return false;
    const sa = series[a.i], sb = series[b.i];
    if (sa === null || sb === null || sa === undefined || sb === undefined) return false;
    const priceMove = (b.price - a.price) / a.price;
    const scale = series === macdLine ? atr * 0.1 : 2;
    return bear ? priceMove > EQ && sb < sa - scale : priceMove < -EQ && sb > sa + scale;
  };
  const rsiMax = Math.max(...rsi.slice(-third).filter((x) => x !== null));
  const rsiMin = Math.min(...rsi.slice(-third).filter((x) => x !== null));
  const histDecl3 = (bear) => {
    const a = macdHist[n - 1], b = macdHist[n - 2], d = macdHist[n - 3];
    return bear ? a > 0 && a < b && b < d : a < 0 && a > b && b > d;
  };
  const emaBreak = (bear) => {
    let touched = false;
    for (let j = n - 4; j < n - 1; j++) if (bear ? c[j] > emaF[j] : c[j] < emaF[j]) touched = true;
    return touched && (bear ? last < emaF[n - 1] : last > emaF[n - 1]);
  };
  const fbLook = clamp(Math.round(n / 3), 5, 30);
  const failedBreakout = (bear) => {
    for (let j = n - 6; j < n; j++) {
      if (j - fbLook < 0) continue;
      if (bear) {
        const prevHigh = Math.max(...h.slice(j - fbLook, j));
        if (h[j] > prevHigh && c[j] < prevHigh) return true;
      } else {
        const prevLow = Math.min(...l.slice(j - fbLook, j));
        if (l[j] < prevLow && c[j] > prevLow) return true;
      }
    }
    return false;
  };
  const volumeSignal = (bear) => {
    const vol20 = mean(v.slice(-Math.min(30, n)));
    let climax = false;
    for (let j = n - 5; j < n; j++) {
      const range = h[j] - l[j];
      if (range <= 0 || v[j] < vol20 * 1.8) continue;
      if (bear && h[j] - Math.max(o[j], c[j]) >= range * 0.5 && c[j] <= h[j] - range * 0.5) climax = true;
      if (!bear && Math.min(o[j], c[j]) - l[j] >= range * 0.5 && c[j] >= l[j] + range * 0.5) climax = true;
    }
    const atExtreme = bear ? Math.max(...h.slice(-5)) >= rangeHi - atr * 0.25 : Math.min(...l.slice(-5)) <= rangeLo + atr * 0.25;
    const fading = mean(v.slice(-3)) < avgVol * 0.7;
    return climax || (atExtreme && fading);
  };
  const structureBreak = (bear) => {
    if (bear) return pivots.lows.length >= 2 && lRel === 1 && last < pivots.lows[pivots.lows.length - 1].price;
    return pivots.highs.length >= 2 && hRel === -1 && last > pivots.highs[pivots.highs.length - 1].price;
  };
  const factorDefs = [
    { key: "rsiDiv", name: "RSI divergence", weight: 15, test: (b) => divergence(rsi, b) },
    { key: "macdDiv", name: "MACD divergence", weight: 15, test: (b) => divergence(macdLine, b) },
    {
      key: "momWeak",
      name: "Weakening momentum",
      weight: 15,
      test: (b) => (b ? (rsiMax >= 65 && rsiNow !== null && rsiNow <= rsiMax - 8) || histDecl3(true) : (rsiMin <= 35 && rsiNow !== null && rsiNow >= rsiMin + 8) || histDecl3(false)),
    },
    { key: "emaBreak", name: `Break of EMA${emaFastP}`, weight: 15, test: emaBreak },
    { key: "failBreak", name: "Failed breakout / breakdown", weight: 10, test: failedBreakout },
    { key: "volume", name: "Volume exhaustion / climax", weight: 10, test: volumeSignal },
    { key: "structure", name: "Market-structure change", weight: 20, test: structureBreak },
  ];
  const evalSide = (bear) => {
    const gateOk = bear ? pricePct >= 0.5 : pricePct <= 0.5; // needs something to reverse from
    const facs = factorDefs.map((f) => ({ key: f.key, name: f.name, weight: f.weight, hit: gateOk && f.test(bear) }));
    return { facs, score: facs.reduce((s, f) => s + (f.hit ? f.weight : 0), 0), hits: facs.filter((f) => f.hit).length };
  };
  const bearRev = evalSide(true);
  const bullRev = evalSide(false);
  const lead = bearRev.score === bullRev.score ? null : bearRev.score > bullRev.score ? "BEARISH" : "BULLISH";
  const leadSide = lead === "BEARISH" ? bearRev : lead === "BULLISH" ? bullRev : { facs: bearRev.facs.map((f) => ({ ...f, hit: false })), score: 0, hits: 0 };
  const structureHit = leadSide.facs.find((f) => f.key === "structure")?.hit;
  const revStatus = leadSide.hits >= 5 && structureHit ? "Confirmed" : leadSide.hits >= 3 ? "Probable" : leadSide.hits >= 1 ? "Possible" : "None";
  // never above the "high" band without confirmation
  const revRisk = revStatus === "Confirmed" ? leadSide.score : Math.min(leadSide.score, 74);
  const revLabel = revRisk < 25 ? "LOW" : revRisk < 50 ? "MEDIUM" : revRisk < 75 ? "HIGH" : "VERY HIGH";

  // ===================== 5/6. SUPPORT & RESISTANCE =======================
  const tol = Math.max(atr * 0.35, last * 0.0015);
  const zctx = { o, h, l, c, v, n, pivots, tol, avgVol };
  const supAll = buildZones("support", zctx);
  const resAll = buildZones("resistance", zctx);
  const support = pickSide(supAll, last, false);
  const resistance = pickSide(resAll, last, true);

  // ====================== 7. BREAKOUT / BREAKDOWN ========================
  const volAvgPrior = (j) => mean(v.slice(Math.max(0, j - 20), j)) || avgVol;
  const sideStatus = (isRes) => {
    const zones = isRes ? resAll : supAll;
    let best = null;
    const consider = (rank, zone, status, note) => {
      if (!best || rank < best.rank || (rank === best.rank && zone.strength > best.zone.strength)) best = { rank, zone, status, note };
    };
    zones.forEach((z) => {
      const edge = isRes ? z.high : z.low;
      for (let j = Math.max(1, n - 3); j < n; j++) {
        const beyond = isRes ? c[j] > edge + atr * 0.1 : c[j] < edge - atr * 0.1;
        const prevInside = isRes ? c[j - 1] <= edge : c[j - 1] >= edge;
        const stillBeyond = isRes ? last > edge : last < edge;
        if (beyond && prevInside && stillBeyond) {
          const volOk = v[j] >= volAvgPrior(j) * 1.2;
          consider(volOk ? 0 : 1, z, volOk ? (isRes ? "Breakout confirmed" : "Breakdown confirmed") : (isRes ? "Breakout probable" : "Breakdown probable"),
            volOk ? "closed beyond the zone on above-average volume" : "closed beyond the zone, but volume did not confirm");
        }
        const wickOnly = isRes ? h[j] > edge && c[j] <= edge && last <= edge : l[j] < edge && c[j] >= edge && last >= edge;
        if (wickOnly) consider(2, z, isRes ? "Rejected at resistance" : "Rejected at support", "wick-only move through the zone — not a confirmed break");
      }
      const dist = isRes ? z.low - last : last - z.high;
      const inside = last >= z.low - atr * 0.25 && last <= z.high + atr * 0.25;
      if (inside) consider(3, z, isRes ? "Testing resistance" : "Testing support", "price is inside / touching the zone");
      else if (dist > 0 && dist <= atr * 1.5) consider(4, z, isRes ? "Approaching resistance" : "Approaching support", `${((dist / last) * 100).toFixed(2)}% away`);
    });
    return best ? { status: best.status, zone: best.zone, note: best.note } : { status: "None nearby", zone: null, note: "no zone within 1.5 ATR" };
  };
  const resBreak = sideStatus(true);
  const supBreak = sideStatus(false);

  // breakout risk: how primed is price to make a decisive move
  const nearestZoneDist = Math.min(
    ...[...resAll.filter((z) => z.mid >= last).map((z) => z.low - last), ...supAll.filter((z) => z.mid <= last).map((z) => last - z.high), Infinity].map((d) => Math.max(0, d))
  );
  let brScore = 0;
  if (nearestZoneDist <= atr * 0.5) brScore += 40;
  else if (nearestZoneDist <= atr * 1.5) brScore += 25;
  else if (nearestZoneDist <= atr * 3) brScore += 10;
  const recentRange = mean(h.slice(-5).map((x, i) => x - l.slice(-5)[i]));
  const allRange = mean(h.map((x, i) => x - l[i]));
  if (allRange > 0 && recentRange < allRange * 0.7) brScore += 20; // squeeze
  if (mean(v.slice(-3)) > avgVol * 1.2) brScore += 15;
  const adxPrev = adx[n - 1 - m];
  if (adxNow !== null && adxPrev !== null && adxNow > adxPrev + 2) brScore += 10;
  if (/Testing|Rejected|probable|confirmed/i.test(resBreak.status + " " + supBreak.status)) brScore += 15;
  brScore = clamp(brScore, 0, 100);
  const breakoutRisk = brScore < 35 ? "LOW" : brScore < 65 ? "MEDIUM" : "HIGH";

  // ========================== 8. FINAL ANALYSIS ==========================
  const brBias = /Breakout confirmed/.test(resBreak.status) ? 1 : /Breakdown confirmed/.test(supBreak.status) ? -1 : /Breakout probable/.test(resBreak.status) ? 0.5 : /Breakdown probable/.test(supBreak.status) ? -0.5 : 0;
  const composite =
    0.3 * trendDir * (strengthScore / 100) +
    0.25 * mDir * (momentumScore / 100) +
    0.2 * structDir +
    0.15 * ((bullRev.score - bearRev.score) / 100) +
    0.1 * brBias;
  const overallScore = Math.round(clamp(50 + 50 * composite, 0, 100));
  const overallLabel = overallScore >= 65 ? "BULLISH BIAS" : overallScore <= 35 ? "BEARISH BIAS" : "NEUTRAL / MIXED";

  const biasSign = overallScore >= 65 ? 1 : overallScore <= 35 ? -1 : 0;
  const groups = [
    { name: "EMA alignment", dir: emaDir },
    { name: "price slope", dir: slopeDir },
    { name: "market structure", dir: structDir },
    { name: "MACD", dir: sign(macdHist[n - 1] + macdLine[n - 1]) },
    { name: "RSI", dir: rsiNow === null ? 0 : rsiNow > 55 ? 1 : rsiNow < 45 ? -1 : 0 },
    { name: "volume flow", dir: sign(volFlow, 0.1) },
  ];
  const agreeing = biasSign === 0 ? [] : groups.filter((g) => g.dir === biasSign);
  const confirmation =
    biasSign === 0 ? "No directional bias" : agreeing.length >= 5 ? "Confirmed" : agreeing.length === 4 ? "Probable" : "Possible";

  const pctAway = (z) => (z ? Math.abs(((z.mid - last) / last) * 100).toFixed(2) + "%" : null);
  const parts = [];
  parts.push(
    `Trend is ${trendLabel} (${trendDir === 0 ? "the EMA, slope and structure votes don't agree" : `${Math.abs(votes)} of 3 votes agree: ${[emaDir && "EMA alignment", slopeDir && "price slope", structDir && "market structure"].filter(Boolean).join(", ")}`}) and ${trendState.toLowerCase()}, with strength ${strengthScore}/100 (${strengthLabel}${adxNow !== null ? `, ADX ${adxNow.toFixed(0)}` : ""}).`
  );
  parts.push(
    `Momentum is ${momentumLabel} at ${momentumScore}/100 — ${mDir === 0 ? "fewer than 3 of 5 momentum measures agree" : `${agreeCount} of 5 measures agree`}${rsiNow !== null ? `, RSI ${rsiNow.toFixed(0)}` : ""}.`
  );
  parts.push(
    revStatus === "None"
      ? "No reversal factors are lining up (risk " + revRisk + "/100, " + revLabel + ")."
      : `Reversal risk ${revRisk}/100 (${revLabel}): a ${revStatus.toLowerCase()} ${lead ? lead.toLowerCase() : ""} reversal with ${leadSide.hits} of 7 factors${revStatus === "Confirmed" ? "" : " — not confirmed"}.`
  );
  const zoneBits = [];
  if (resistance[0]) zoneBits.push(`R1 ${pctAway(resistance[0])} above`);
  if (support[0]) zoneBits.push(`S1 ${pctAway(support[0])} below`);
  parts.push(`Market structure is ${structure}${zoneBits.length ? `; nearest zones: ${zoneBits.join(", ")}` : ""}. Resistance: ${resBreak.status.toLowerCase()}; support: ${supBreak.status.toLowerCase()}. Breakout risk ${breakoutRisk}.`);
  parts.push(
    `Overall ${overallScore}/100 (50 is neutral, higher is more bullish): trend ${trendDir === 0 ? "adds nothing" : `${trendDir === 1 ? "adds" : "subtracts"} weight`}, momentum ${mDir === 0 ? "adds nothing" : mDir === 1 ? "adds" : "subtracts"}, structure ${structDir === 0 ? "is mixed" : structDir === 1 ? "is bullish" : "is bearish"}. ${
      biasSign === 0 ? "No directional bias is strong enough to call." : `${confirmation} ${biasSign === 1 ? "bullish" : "bearish"} lean — ${agreeing.length} of ${groups.length} independent factors agree (${agreeing.map((g) => g.name).join(", ")}).`
    } This is a read of the candles you chose, not a buy or sell signal.`
  );

  return {
    n,
    last,
    params,
    atr,
    trend: { label: trendLabel, dir: trendDir, votes: { ema: emaDir, slope: slopeDir, structure: structDir }, state: trendState, weakSignals, counts, slopePct: totalSlopePct, r2: reg.r2 },
    strength: { score: strengthScore, label: strengthLabel, components: comps.map((x) => ({ name: x.name, score: Math.round(x.score), weight: x.weight, text: x.text })) },
    momentum: { label: momentumLabel, score: momentumScore, dir: mDir, agree: agreeCount, components: mComps.map((x) => ({ name: x.name, value: x.value, text: x.text })) },
    reversal: { lead, status: revStatus, risk: Math.round(revRisk), label: revLabel, hits: leadSide.hits, factors: leadSide.facs, bearScore: bearRev.score, bullScore: bullRev.score },
    support,
    resistance,
    breakout: { resistance: resBreak, support: supBreak, risk: breakoutRisk, score: Math.round(brScore) },
    structure,
    overall: { score: overallScore, label: overallLabel, confirmation, agreeing: agreeing.map((g) => g.name), total: groups.length },
    explanation: parts,
  };
}
