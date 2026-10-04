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

// Clusters swing points, rejection wicks and flipped (broken) levels into
// price zones and scores them. One engine feeds the summary AND the
// breakout / breakdown section.
function buildZones(kind, ctx) {
  const { o, h, l, c, v, n, pivots, tol, avgVol, atr, last } = ctx;
  const isSup = kind === "support";
  const pts = new Map();
  const pivotList = isSup ? pivots.lows : pivots.highs;
  pivotList.forEach((p) => pts.set(p.i, { i: p.i, price: p.price, pivot: true, wick: false, flip: false }));
  // previous breakout / breakdown levels: a broken swing high that price now
  // sits above becomes support (and a broken swing low below becomes resistance)
  const flipList = isSup ? pivots.highs : pivots.lows;
  flipList.forEach((p) => {
    for (let j = p.i + 1; j < n; j++) {
      const broke = isSup ? c[j] > p.price + atr * 0.1 : c[j] < p.price - atr * 0.1;
      if (broke) {
        const stillSide = isSup ? last > p.price : last < p.price;
        if (stillSide) pts.set("f" + p.i, { i: j, price: p.price, pivot: false, wick: false, flip: true });
        break;
      }
    }
  });
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
    else pts.set("w" + j, { i: j, price, pivot: false, wick: true, flip: false });
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

  return clusters.map((cl) => {
    const low = cl.min;
    const high = cl.max;
    const touches = cl.pts.length;
    const wicks = cl.pts.filter((p) => p.wick).length;
    const flips = cl.pts.filter((p) => p.flip).length;
    const lastIdx = Math.max(...cl.pts.map((p) => p.i));
    // volume traded while price was testing the zone, relative to normal
    const testVols = [];
    let closesIn = 0;
    for (let j = 0; j < n; j++) {
      const edge = isSup ? l[j] : h[j];
      if (edge >= low - tol && edge <= high + tol) testVols.push(v[j]);
      if (c[j] >= low - tol * 0.5 && c[j] <= high + tol * 0.5) closesIn++;
    }
    const volRatio = avgVol > 0 && testVols.length ? mean(testVols) / avgVol : 1;
    const volScore = clamp(volRatio * 50, 0, 100);
    const consScore = clamp((closesIn / Math.max(1, n * 0.12)) * 100, 0, 100);
    const strength =
      0.35 * Math.min(100, (touches / 4) * 100) +
      0.2 * Math.min(100, (wicks / 3) * 100) +
      0.15 * volScore +
      0.1 * ((lastIdx / Math.max(1, n - 1)) * 100) +
      0.1 * consScore +
      0.1 * (flips > 0 ? 100 : 0);
    return {
      low,
      high,
      mid: (low + high) / 2,
      touches,
      wicks,
      flips,
      closesIn,
      volRatio,
      lastIdx,
      strength: Math.round(clamp(strength, 0, 100)),
    };
  });
}

function pickSide(zones, price, above, count = 3) {
  const side = zones.filter((z) => (above ? z.mid > price : z.mid < price));
  const top = [...side].sort((a, b) => b.strength - a.strength).slice(0, count);
  // S1/R1 = nearest of the strongest, then outward
  return top.sort((a, b) => (above ? a.mid - b.mid : b.mid - a.mid));
}

const strengthWord = (s) => (s < 20 ? "VERY WEAK" : s < 40 ? "WEAK" : s < 60 ? "MODERATE" : s < 80 ? "STRONG" : "VERY STRONG");

// ------------------------------------------------------------------ main

// allCandles = warm-up candles + the candles the user chose (newest last).
// winLen     = how many of the NEWEST candles are the analysis window.
// Indicators (EMA / RSI / MACD / ADX) are computed on all candles so they are
// settled, but every score, swing, zone and breakout reads the window only.
// ext = optional derivatives data: { oiChangePct, oiRecentPct, longPct, fundingRate }
export function analyzeCandles(allCandles, winLen, ext = {}) {
  const N = allCandles.length;
  const n = Math.min(winLen || N, N);
  if (n < MIN_ANALYSIS_CANDLES) return null;
  const s0 = N - n;
  const warmup = s0;
  const pf = (k, i) => parseFloat(k[i]);
  const oA = allCandles.map((k) => pf(k, 1));
  const hA = allCandles.map((k) => pf(k, 2));
  const lA = allCandles.map((k) => pf(k, 3));
  const cA = allCandles.map((k) => pf(k, 4));

  // periods follow the TOTAL history available (standard 20/50, 14, 12/26/9
  // once warm-up exists; scaled down when there is little history)
  const emaSlowP = clamp(Math.round(N / 2), 3, 50);
  const emaFastP = Math.max(2, Math.round(emaSlowP * 0.4));
  const rsiP = clamp(N - 1, 2, 14);
  const adxP = clamp(Math.floor(N / 2) - 1, 2, 14);
  const macdSlowP = clamp(Math.round(N / 3), 5, 26);
  const macdFastP = Math.max(2, Math.round((macdSlowP * 12) / 26));
  const macdSigP = Math.max(2, Math.round((macdSlowP * 9) / 26));
  const swingK = n >= 300 ? 5 : n >= 120 ? 3 : 2;
  const params = { emaFastP, emaSlowP, rsiP, adxP, macdFastP, macdSlowP, macdSigP, swingK };

  const emaFA = emaSeries(cA, emaFastP);
  const emaSA = emaSeries(cA, emaSlowP);
  const rsiA = rsiSeries(cA, rsiP);
  const adxA = adxSeries(hA, lA, cA, adxP);
  const mFast = emaSeries(cA, macdFastP);
  const mSlow = emaSeries(cA, macdSlowP);
  const macdLineA = mFast.map((x, i) => x - mSlow[i]);
  const macdSigA = emaSeries(macdLineA, macdSigP);
  const macdHistA = macdLineA.map((x, i) => x - macdSigA[i]);

  // ---- everything below is the analysis window only ----
  const win = allCandles.slice(s0);
  const o = oA.slice(s0), h = hA.slice(s0), l = lA.slice(s0), c = cA.slice(s0);
  const v = win.map((k) => pf(k, 7));
  const tbRaw = win.map((k) => (k[10] === undefined ? NaN : pf(k, 10)));
  const hasTaker = tbRaw.every((x) => Number.isFinite(x)) && v.some((x) => x > 0);
  const emaF = emaFA.slice(s0), emaS = emaSA.slice(s0);
  const rsi = rsiA.slice(s0), adx = adxA.slice(s0);
  const macdLine = macdLineA.slice(s0), macdHist = macdHistA.slice(s0);
  const last = c[n - 1];
  const avgVol = mean(v);

  const trs = [];
  for (let i = 1; i < n; i++) trs.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  const atr = mean(trs.slice(-Math.max(3, rsiP))) || last * 0.005;
  const avgRangePct = mean(h.map((x, i) => ((x - l[i]) / c[i]) * 100)) || 0.1;

  const pivots = findPivots(h, l, swingK);
  const counts = labelSwings(pivots.highs, pivots.lows);
  const hRel = pivotRel(pivots.highs);
  const lRel = pivotRel(pivots.lows);
  const rangeHi = Math.max(...h);
  const rangeLo = Math.min(...l);
  const pricePct = rangeHi > rangeLo ? (last - rangeLo) / (rangeHi - rangeLo) : 0.5;
  const m = Math.max(3, Math.round(n / 5));
  const third = Math.max(5, Math.round(n / 3));
  const adxNow = adx[n - 1];
  const rsiNow = rsi[n - 1];

  // ============================ 1. TREND =================================
  const emaDir = last > emaF[n - 1] && emaF[n - 1] > emaS[n - 1] ? 1 : last < emaF[n - 1] && emaF[n - 1] < emaS[n - 1] ? -1 : 0;
  const emaTilt = emaDir !== 0 ? emaDir : 0.5 * sign(emaF[n - 1] - emaS[n - 1]);
  const reg = linReg(c);
  const slopePct = ((reg.slope * (n - 1)) / mean(c)) * 100;
  const swingTotal = counts.HH + counts.LH + counts.HL + counts.LL;
  const structScore = swingTotal ? (counts.HH + counts.HL - counts.LH - counts.LL) / swingTotal : 0;
  const slopeScore = Math.abs(slopePct) >= avgRangePct * 1.5 ? sign(reg.slope) * clamp(reg.r2 / 0.6, 0, 1) : 0;
  const lr = linReg(c.slice(-third));
  const recentPct = ((lr.slope * (third - 1)) / mean(c.slice(-third))) * 100;
  const recentDir = Math.abs(recentPct) >= avgRangePct * 0.8 && lr.r2 >= 0.25 ? sign(lr.slope) : 0;
  const recentScore = recentDir !== 0 ? recentDir * clamp(lr.r2 / 0.5, 0, 1) : 0;
  const trendComposite = 0.3 * structScore + 0.3 * slopeScore + 0.2 * emaTilt + 0.2 * recentScore;
  let trendDir = trendComposite > 0.2 ? 1 : trendComposite < -0.2 ? -1 : 0;
  // a big, clean directional move is a trend even if the swings look mixed
  const bigMove = reg.r2 >= 0.6 && Math.abs(slopePct) >= avgRangePct * 3;
  if (bigMove && sign(reg.slope) * structScore > -0.5) trendDir = sign(reg.slope);
  const trendLabel = trendDir === 1 ? "BULLISH" : trendDir === -1 ? "BEARISH" : "SIDEWAYS";

  const structure = hRel === 1 && lRel === 1 ? "BULLISH" : hRel === -1 && lRel === -1 ? "BEARISH" : "MIXED";
  const structDir = structure === "BULLISH" ? 1 : structure === "BEARISH" ? -1 : 0;

  const weakSignals = [];
  if (trendDir !== 0) {
    const adxBefore = adx[n - 1 - m];
    if (adxNow !== null && adxBefore !== null && adxBefore - adxNow >= 3) weakSignals.push("ADX is falling");
    if (trendDir * lr.slope < trendDir * reg.slope * 0.4) weakSignals.push("recent price slope has flattened or turned");
    const hPeak = trendDir === 1 ? Math.max(...macdHist.slice(-third)) : Math.min(...macdHist.slice(-third));
    if (trendDir * macdHist[n - 1] < trendDir * hPeak * 0.6 && trendDir * hPeak > 0) weakSignals.push("MACD histogram is shrinking");
    if (trendDir * (last - emaF[n - 1]) < 0) weakSignals.push(`price is below/above the EMA${emaFastP} against the trend`);
  }
  let condition;
  if (trendDir === 0) {
    condition = recentDir === 0 ? "Sideways / range" : recentDir === 1 ? "Range with an upside push" : "Range with a downside push";
  } else if (recentDir === trendDir) {
    condition = weakSignals.length >= 2 ? "Trend continuing, but weakening" : weakSignals.length === 1 ? "Trend continuing, early fatigue" : "Trend continuing";
  } else if (recentDir === 0) {
    condition = trendDir * (last - emaF[n - 1]) < 0 ? "Pullback / Consolidation" : "Consolidation";
  } else {
    condition = "Pullback";
  }

  // ======================== 2. TREND STRENGTH ============================
  const dirFor = trendDir !== 0 ? trendDir : sign(reg.slope);
  const comps = [];
  if (swingTotal > 0) {
    const bullFrac = (counts.HH + counts.HL) / swingTotal;
    const dom = dirFor === -1 ? 1 - bullFrac : dirFor === 1 ? bullFrac : Math.max(bullFrac, 1 - bullFrac);
    comps.push({ name: "Market structure", weight: 0.3, score: dom * 100, text: `${counts.HH} HH · ${counts.HL} HL · ${counts.LH} LH · ${counts.LL} LL` });
  }
  const slopeAgree = dirFor === 0 || sign(reg.slope) === dirFor ? 1 : 0.4;
  comps.push({
    name: "Price slope",
    weight: 0.2,
    score: clamp(reg.r2 * 100 * slopeAgree * clamp(Math.abs(slopePct) / (avgRangePct * 2), 0.25, 1), 0, 100),
    text: `${slopePct >= 0 ? "+" : ""}${slopePct.toFixed(1)}% over the period, R² ${reg.r2.toFixed(2)}`,
  });
  comps.push({
    name: "EMA alignment",
    weight: 0.2,
    score: emaDir === 0 ? 30 : emaDir === dirFor ? clamp(40 + (Math.abs(emaF[n - 1] - emaS[n - 1]) / atr) * 30, 0, 100) : 10,
    text: emaDir === 0 ? "EMAs mixed" : `price, EMA${emaFastP}, EMA${emaSlowP} aligned ${emaDir === 1 ? "up" : "down"}`,
  });
  if (adxNow !== null) comps.push({ name: "ADX", weight: 0.2, score: clamp(adxNow * 2, 0, 100), text: `ADX ${adxNow.toFixed(0)}` });
  {
    const segs = Math.max(2, Math.min(6, Math.floor(n / 4)));
    let agreeSeg = 0;
    for (let g = 0; g < segs; g++) {
      const a = Math.floor((g * n) / segs);
      const b = Math.floor(((g + 1) * n) / segs) - 1;
      if (b > a && sign(c[b] - c[a]) === dirFor && dirFor !== 0) agreeSeg++;
    }
    const sideShare = c.filter((x, i) => (dirFor === 1 ? x > emaS[i] : dirFor === -1 ? x < emaS[i] : false)).length / n;
    comps.push({
      name: "Consistency",
      weight: 0.1,
      score: dirFor === 0 ? 0 : (0.5 * (agreeSeg / segs) + 0.5 * sideShare) * 100,
      text: dirFor === 0 ? "no direction" : `${agreeSeg} of ${segs} segments and ${(sideShare * 100).toFixed(0)}% of closes agree`,
    });
  }
  const wSum = comps.reduce((s, x) => s + x.weight, 0);
  const strengthScore = Math.round(comps.reduce((s, x) => s + x.score * x.weight, 0) / wSum);
  const strengthLabel = strengthWord(strengthScore);

  // =========================== 3. MOMENTUM ===============================
  const rr = clamp(Math.round(n / 5), 3, 14);
  const roc = ((last - c[n - 1 - rr]) / c[n - 1 - rr]) * 100;
  let upV = 0, dnV = 0, bodySigned = 0, bodyAbs = 0;
  for (let i = n - third; i < n; i++) {
    if (c[i] >= o[i]) upV += v[i];
    else dnV += v[i];
    bodySigned += c[i] - o[i];
    bodyAbs += Math.abs(c[i] - o[i]);
  }
  const volFlow = upV + dnV > 0 ? (upV - dnV) / (upV + dnV) : 0;
  const candleFlow = bodyAbs > 0 ? bodySigned / bodyAbs : 0;
  const macdVal = clamp(0.7 * (macdHist[n - 1] / (0.1 * atr)) + 0.3 * (macdLine[n - 1] / (0.5 * atr)), -1, 1);
  const cls = (x) => (x > 0.15 ? "BULLISH" : x < -0.15 ? "BEARISH" : "NEUTRAL");
  const mComps = [
    { name: "RSI", weight: 0.25, value: rsiNow === null ? 0 : clamp((rsiNow - 50) / 30, -1, 1), text: rsiNow === null ? "n/a" : `RSI${rsiP} ${rsiNow.toFixed(0)}` },
    { name: "MACD histogram", weight: 0.25, value: macdVal, text: `histogram ${macdHist[n - 1] >= 0 ? "positive" : "negative"}, line ${macdLine[n - 1] >= 0 ? "above" : "below"} zero` },
    { name: "Rate of change", weight: 0.2, value: clamp(roc / (avgRangePct * Math.sqrt(rr) * 0.8), -1, 1), text: `${roc >= 0 ? "+" : ""}${roc.toFixed(2)}% over ${rr} candles` },
    { name: "Volume flow", weight: 0.15, value: volFlow, text: `${volFlow >= 0 ? "more volume on up" : "more volume on down"} candles (last ${third})` },
    { name: "Candle bodies", weight: 0.15, value: candleFlow, text: `${candleFlow >= 0 ? "bullish" : "bearish"} bodies dominate (last ${third})` },
  ].map((x) => ({ ...x, cls: cls(x.value) }));
  const agg = mComps.reduce((s, x) => s + x.value * x.weight, 0);
  const bullN = mComps.filter((x) => x.cls === "BULLISH").length;
  const bearN = mComps.filter((x) => x.cls === "BEARISH").length;
  const mDir = agg > 0.15 && bullN >= 3 && bearN <= 1 ? 1 : agg < -0.15 && bearN >= 3 && bullN <= 1 ? -1 : 0;
  let momentumScore = Math.round(clamp(Math.abs(agg) * 140, 0, 100));
  if (mDir === 0) momentumScore = Math.min(momentumScore, 39);
  const kShift = Math.max(2, Math.round(n / 10));
  const histDelta = macdHist[n - 1] - macdHist[n - 1 - kShift];
  const rsiPrev = rsi[n - 1 - kShift];
  const rsiDelta = rsiNow !== null && rsiPrev !== null ? rsiNow - rsiPrev : 0;
  const shift = mDir * (sign(histDelta, 0.02 * atr) + sign(rsiDelta, 2));
  const mTrend = mDir === 0 ? "" : shift <= -1 ? "Weakening " : shift >= 1 ? "Strengthening " : "";
  const dirWord = mDir === 1 ? "Bullish" : mDir === -1 ? "Bearish" : "";
  const momentumDisplay = mDir === 0 ? "Mixed / Weak" : mTrend + dirWord;
  const mAgree = mDir === 1 ? bullN : mDir === -1 ? bearN : Math.max(bullN, bearN);
  const momentumCondition =
    mDir === 0
      ? "Indicators disagree — no clear momentum edge"
      : mAgree >= 4
      ? `${dirWord} momentum is established across most measures${mTrend ? ` but ${mTrend.trim().toLowerCase()}` : ""}`
      : `${dirWord} momentum is developing but not confirmed${mTrend ? ` (${mTrend.trim().toLowerCase()})` : ""}`;

  // ====================== 4. EARLY REVERSAL ==============================
  const lastTwo = (arr) => (arr.length >= 2 ? [arr[arr.length - 2], arr[arr.length - 1]] : null);
  const hi2 = lastTwo(pivots.highs);
  const lo2 = lastTwo(pivots.lows);
  const warm = Math.max(0, macdSlowP - warmup); // values this early in the window are still settling only when little warm-up exists
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
  const rsiVals = rsi.slice(-third).filter((x) => x !== null);
  const rsiMax = rsiVals.length ? Math.max(...rsiVals) : 50;
  const rsiMin = rsiVals.length ? Math.min(...rsiVals) : 50;
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
    const volRef = mean(v.slice(-Math.min(30, n)));
    let climax = false;
    for (let j = n - 5; j < n; j++) {
      const range = h[j] - l[j];
      if (range <= 0 || v[j] < volRef * 1.8) continue;
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
      name: "Momentum weakening",
      weight: 15,
      test: (b) => (b ? (rsiMax >= 65 && rsiNow !== null && rsiNow <= rsiMax - 8) || histDecl3(true) : (rsiMin <= 35 && rsiNow !== null && rsiNow >= rsiMin + 8) || histDecl3(false)),
    },
    { key: "emaBreak", name: `EMA${emaFastP} break`, weight: 15, test: emaBreak },
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
  const revLead = bearRev.score === bullRev.score ? null : bearRev.score > bullRev.score ? "BEARISH" : "BULLISH";
  const leadSide = revLead === "BEARISH" ? bearRev : revLead === "BULLISH" ? bullRev : { facs: bearRev.facs.map((f) => ({ ...f, hit: false })), score: 0, hits: 0 };
  const revScore = leadSide.score;
  const structureHit = !!leadSide.facs.find((f) => f.key === "structure")?.hit;
  const revBand = revScore <= 20 ? "No reversal" : revScore <= 40 ? "Early warning" : revScore <= 60 ? "Possible" : revScore <= 80 ? "Probable" : "Strong reversal";
  const revConfirmed = structureHit && revScore >= 61;
  const revText =
    revBand === "No reversal"
      ? "No reversal"
      : revBand === "Early warning"
      ? "Early warning — not confirmed"
      : revConfirmed
      ? revBand
      : `${revBand} — not confirmed (market structure has not changed)`;
  const revShort = revBand === "No reversal" ? "None" : `${revLead === "BEARISH" ? "Bearish" : "Bullish"} ${revBand === "Early warning" ? "Warning" : revBand === "Strong reversal" ? "Reversal" : revBand}`;

  // ===================== 5/6. SUPPORT & RESISTANCE =======================
  const tol = Math.max(atr * 0.35, last * 0.0015);
  const zctx = { o, h, l, c, v, n, pivots, tol, avgVol, atr, last };
  const supAll = buildZones("support", zctx);
  const resAll = buildZones("resistance", zctx);
  const support = pickSide(supAll, last, false);
  const resistance = pickSide(resAll, last, true);
  const zoneLabel = (z) => {
    if (!z) return null;
    const si = support.indexOf(z);
    if (si >= 0) return "S" + (si + 1);
    const ri = resistance.indexOf(z);
    return ri >= 0 ? "R" + (ri + 1) : null;
  };

  // ======================= 7/8. BREAKOUT & BREAKDOWN =====================
  const volPrior = (j) => mean(v.slice(Math.max(0, j - 20), j)) || avgVol;
  const L = Math.max(3, Math.min(8, Math.round(n / 8)));
  const evalBreak = (isRes) => {
    const zones = isRes ? resAll : supAll;
    let best = null;
    const consider = (rank, zone, status, note, extra = {}) => {
      if (!best || rank < best.rank || (rank === best.rank && zone.strength > best.zone.strength))
        best = { rank, zone, status, note, volume: "n/a", retest: "n/a", ...extra };
    };
    const word = isRes ? "resistance" : "support";
    zones.forEach((z) => {
      if (Math.abs(z.mid - last) > atr * 5) return;
      const edge = isRes ? z.high : z.low;
      const beyond = (x, k = 0.1) => (isRes ? x > edge + atr * k : x < edge - atr * k);
      const inside = (x) => (isRes ? x <= edge : x >= edge);
      // first candle in the recent window that closed beyond the zone after being inside
      let b = -1;
      for (let j = Math.max(1, n - L); j < n; j++) {
        if (beyond(c[j]) && inside(c[j - 1])) {
          b = j;
          break;
        }
      }
      if (b >= 0) {
        let failed = false;
        for (let j = b + 1; j < n; j++) if (inside(c[j])) failed = true;
        const meaningful = beyond(c[b], 0.25);
        const volOk = v[b] >= volPrior(b) * 1.2 || (b + 1 < n && v[b + 1] >= volPrior(b + 1) * 1.2);
        const held = n - 1 - b >= 1 && !failed;
        let retest = "Not retested yet";
        for (let j = b + 1; j < n; j++) {
          const touched = isRes ? l[j] <= edge + atr * 0.25 : h[j] >= edge - atr * 0.25;
          if (touched) {
            retest = isRes ? (c[j] > edge ? "Held" : "Failed") : c[j] < edge ? "Held" : "Failed";
            break;
          }
        }
        const checks = [
          { name: `Close ${isRes ? "above" : "below"} the zone`, ok: true },
          { name: "Meaningful distance beyond it (≥ 0.25 ATR)", ok: meaningful },
          { name: `${isRes ? "Buying" : "Selling"} volume above normal`, ok: volOk },
          { name: `Price ${isRes ? "holds above" : "stays below"} the zone`, ok: held },
          { name: "Retest", ok: retest === "Held" ? true : retest === "Failed" ? false : null },
        ];
        if (failed) {
          consider(2, z, isRes ? "Failed breakout" : "Failed breakdown", "price closed beyond the zone, then closed back inside it", { volume: volOk ? "Confirmed" : "Not confirmed", retest, checks, brk: true, failed: true });
        } else if (meaningful && volOk && held && retest !== "Failed") {
          consider(0, z, `${isRes ? "Breakout" : "Breakdown"} confirmed${retest === "Held" ? " (retest held)" : ""}`, "closed beyond the zone with distance and volume, and has held", { volume: "Confirmed", retest, checks, brk: true, confirmed: true });
        } else {
          const missing = [!meaningful && "distance is small", !volOk && "volume did not confirm", !held && "no follow-through candle yet", retest === "Failed" && "retest failed"].filter(Boolean);
          consider(1, z, `${isRes ? "Breakout" : "Breakdown"} probable — not confirmed`, `closed beyond the zone, but ${missing.join(", ")}`, { volume: volOk ? "Confirmed" : "Not confirmed", retest, checks, brk: true, probable: true });
        }
        return;
      }
      const wickOnly = (() => {
        for (let j = Math.max(0, n - L); j < n; j++) {
          const poked = isRes ? h[j] > edge && c[j] <= edge : l[j] < edge && c[j] >= edge;
          if (poked && inside(last)) return true;
        }
        return false;
      })();
      if (wickOnly) {
        consider(2, z, `Rejected at ${word} (wick only)`, "a wick went through the zone but no candle closed beyond it — not a breakout", { volume: "n/a", wick: true });
        return;
      }
      const dist = isRes ? z.low - last : last - z.high;
      const touching = last >= z.low - atr * 0.25 && last <= z.high + atr * 0.25;
      if (touching) consider(3, z, `Testing ${word}`, "price is inside / touching the zone");
      else if (dist > 0 && dist <= atr * 1.5) consider(4, z, `Approaching ${word}`, `${((dist / last) * 100).toFixed(2)}% away`);
    });
    return best || { rank: 9, zone: null, status: "None nearby", note: `no ${word} zone within reach`, volume: "n/a", retest: "n/a" };
  };
  const resBreak = evalBreak(true);
  const supBreak = evalBreak(false);

  // ===================== WHALE-STYLE POSITIONING =========================
  const buyRatio = (a, b) => {
    let tb = 0, tv = 0;
    for (let j = a; j <= b; j++) {
      tb += tbRaw[j];
      tv += v[j];
    }
    return tv > 0 ? tb / tv : null;
  };
  const tNow = hasTaker ? buyRatio(n - third, n - 1) : null;
  const tPrev = hasTaker && n - third >= 6 ? buyRatio(0, n - third - 1) : null;
  const tAll = hasTaker ? buyRatio(0, n - 1) : null;
  const chgPct = ((last - c[0]) / c[0]) * 100;
  const rangePct = ((rangeHi - rangeLo) / mean(c)) * 100;
  const pxState = Math.abs(chgPct) < 0.3 * rangePct ? 0 : sign(chgPct);
  const oiChg = Number.isFinite(ext.oiChangePct) ? ext.oiChangePct : null;
  const oiKnown = oiChg !== null;
  const volRise = mean(v.slice(-third)) / (avgVol || 1);
  const longPct = Number.isFinite(ext.longPct) ? ext.longPct : null;
  const fundPct = Number.isFinite(ext.fundingRate) ? ext.fundingRate * 100 : null;
  const s1 = support[0] || null;
  const r1 = resistance[0] || null;
  let absDown = 0, absUp = 0;
  for (let j = Math.max(0, n - Math.max(10, Math.round(n / 2))); j < n; j++) {
    const range = h[j] - l[j];
    if (range <= 0 || v[j] < avgVol * 1.3) continue;
    if (Math.min(o[j], c[j]) - l[j] >= range * 0.4 && c[j] >= l[j] + range * 0.5) absDown++;
    if (h[j] - Math.max(o[j], c[j]) >= range * 0.4 && c[j] <= h[j] - range * 0.5) absUp++;
  }
  const flowF = [];
  const addF = (name, weight, a, d, ok, text) => flowF.push({ name, weight, accum: a, dist: d, available: ok, text });
  addF(
    "Price vs open interest",
    20,
    oiKnown ? (pxState >= 0 && oiChg > 1.5 ? (pxState === 0 ? 1 : 0.7) : pxState >= 0 && Math.abs(oiChg) <= 1.5 ? 0.3 : pxState === -1 && oiChg > 1.5 ? 0.1 : 0) : 0,
    oiKnown ? (pxState <= 0 && pricePct >= 0.55 && oiChg > 1.5 ? 1 : pxState === -1 && oiChg > 1.5 ? 0.6 : pxState === 0 && oiChg > 1.5 ? 0.4 : 0) : 0,
    oiKnown,
    oiKnown ? `price ${chgPct >= 0 ? "+" : ""}${chgPct.toFixed(2)}% (${pxState === 0 ? "range-bound" : pxState > 0 ? "rising" : "falling"}), open interest ${oiChg >= 0 ? "+" : ""}${oiChg.toFixed(1)}%` : "open interest history unavailable for this window"
  );
  const vr = clamp((volRise - 0.9) / 0.6, 0, 1);
  addF("Volume", 10, vr * (pxState >= 0 ? 1 : 0.3), vr * (pxState <= 0 || pricePct >= 0.6 ? 1 : 0.4), true, `recent volume ${volRise.toFixed(2)}× the period average`);
  if (hasTaker) {
    const ab = clamp((tNow - 0.5) / 0.06, -1, 1);
    const rb = tPrev !== null ? clamp((tNow - tPrev) / 0.04, -1, 1) : 0;
    addF("Taker buy / sell", 20, clamp(0.6 * Math.max(0, ab) + 0.4 * Math.max(0, rb), 0, 1), clamp(0.6 * Math.max(0, -ab) + 0.4 * Math.max(0, -rb), 0, 1), true, `aggressive buyers took ${(tNow * 100).toFixed(1)}% of recent volume${tPrev !== null ? ` (earlier ${(tPrev * 100).toFixed(1)}%)` : ""}`);
  } else addF("Taker buy / sell", 20, 0, 0, false, "taker data not available");
  addF("Long / short ratio", 5, longPct === null ? 0 : longPct < 45 ? 1 : longPct < 50 ? 0.5 : 0, longPct === null ? 0 : longPct > 62 ? 1 : longPct > 56 ? 0.5 : 0, longPct !== null, longPct === null ? "not available" : `${longPct.toFixed(0)}% of accounts are long`);
  addF("Funding rate", 5, fundPct === null ? 0 : fundPct < 0 ? clamp(-fundPct / 0.03, 0, 1) : 0, fundPct === null ? 0 : fundPct > 0 ? clamp(fundPct / 0.05, 0, 1) : 0, fundPct !== null, fundPct === null ? "not available" : `${fundPct >= 0 ? "+" : ""}${fundPct.toFixed(4)}% (${fundPct > 0 ? "longs pay shorts" : fundPct < 0 ? "shorts pay longs" : "flat"})`);
  {
    const heldSup = s1 ? !c.slice(-third).some((x) => x < s1.low - atr * 0.1) : false;
    const nearSup = s1 ? (last - s1.high) / atr <= 3 : false;
    const aS = s1 && heldSup ? clamp(0.4 + (s1.strength / 100) * 0.6, 0, 1) * (nearSup ? 1 : 0.5) : 0;
    let rej = 0;
    if (r1) for (let j = n - third; j < n; j++) if (h[j] >= r1.low - atr * 0.15 && c[j] <= r1.high) rej++;
    const nearRes = r1 ? (r1.low - last) / atr <= 3 : false;
    const dR = r1 ? clamp(rej / 3, 0, 1) * 0.7 + (nearRes ? 0.3 : 0) : pricePct >= 0.9 ? 0.3 : 0;
    addF("Support defended / resistance rejecting", 20, aS, dR, true, `${s1 ? (heldSup ? `support S1 is holding (strength ${s1.strength})` : "support S1 has been closed below") : "no support zone under price"}; ${r1 ? `${rej} recent rejection${rej === 1 ? "" : "s"} near R1` : "no resistance above"}`);
  }
  addF("Repeated absorption", 20, clamp(absDown / 3, 0, 1), clamp(absUp / 3, 0, 1), true, `${absDown} high-volume candles that absorbed selling, ${absUp} that absorbed buying`);
  const avail = flowF.filter((f) => f.available);
  const wAvail = avail.reduce((s, f) => s + f.weight, 0) || 1;
  let accum = (avail.reduce((s, f) => s + f.accum * f.weight, 0) / wAvail) * 100;
  const distr = (avail.reduce((s, f) => s + f.dist * f.weight, 0) / wAvail) * 100;
  const shortCovering = oiKnown && pxState === 1 && oiChg < -1.5;
  const longLiq = oiKnown && pxState === -1 && oiChg < -1.5;
  if (shortCovering) accum *= 0.6;
  if (longLiq) accum *= 0.7;
  accum = Math.round(clamp(accum, 0, 100));
  const distScore = Math.round(clamp(distr, 0, 100));
  const flowState = shortCovering
    ? "Short covering"
    : longLiq
    ? "Long liquidation"
    : accum >= 45 && accum >= distScore + 10
    ? "Possible accumulation"
    : distScore >= 45 && distScore >= accum + 10
    ? "Possible distribution"
    : "No clear accumulation or distribution";
  const flowNote =
    flowState === "Short covering"
      ? "Price is rising while open interest falls — shorts are closing rather than new buyers arriving."
      : flowState === "Long liquidation"
      ? "Price is falling while open interest falls — longs are being closed out rather than new shorts opening."
      : flowState === "Possible accumulation"
      ? "Price is holding, support is being defended and buying pressure / open interest are building."
      : flowState === "Possible distribution"
      ? "Price is stalling or rejecting near resistance while selling pressure / open interest build."
      : "The evidence points both ways or is too thin to call.";

  // ---- probabilities ----
  const nearestDist = (isUp) => {
    const z = isUp ? resistance[0] : support[0];
    if (!z) return null;
    return (isUp ? z.low - last : last - z.high) / atr;
  };
  const squeeze = (() => {
    const rec = mean(h.slice(-5).map((x, i) => x - l.slice(-5)[i]));
    const all = mean(h.map((x, i) => x - l[i]));
    return all > 0 && rec < all * 0.7;
  })();
  const volUp = mean(v.slice(-3)) > avgVol * 1.2;
  const sideProb = (isUp) => {
    const st = isUp ? resBreak : supBreak;
    const sd = isUp ? 1 : -1;
    if (st.confirmed) return 85;
    if (st.probable) return 62;
    let p = 0;
    const d = nearestDist(isUp);
    if (d !== null) p += d <= 0.5 ? 30 : d <= 1.5 ? 22 : d <= 3 ? 10 : 2;
    p += trendDir === sd ? 15 : trendDir === 0 ? 5 : 0;
    p += mDir === sd ? 15 : mDir === 0 ? 5 : 0;
    p += volUp ? 10 : 0;
    p += squeeze ? 8 : 0;
    p += structDir === sd ? 8 : 0;
    p += (isUp ? accum - distScore : distScore - accum) >= 15 ? 8 : 0;
    if (st.wick || st.failed) p -= 15;
    return Math.round(clamp(Math.min(p, 70), 0, 100));
  };
  const breakoutProb = sideProb(true);
  const breakdownProb = sideProb(false);
  const facHit = (side, key) => !!side.facs.find((f) => f.key === key)?.hit;
  const falseBreakoutRisk = Math.round(
    clamp(
      (resBreak.wick || resBreak.failed ? 30 : 0) +
        (resBreak.volume === "Not confirmed" ? 15 : 0) +
        (mean(v.slice(-3)) < avgVol ? 10 : 0) +
        (rsiNow !== null && rsiNow > 70 ? 10 : 0) +
        (facHit(bearRev, "rsiDiv") ? 15 : 0) +
        (facHit(bearRev, "macdDiv") ? 10 : 0) +
        (mDir !== 1 ? 10 : 0) +
        (facHit(bearRev, "failBreak") ? 10 : 0) +
        (distScore >= 60 ? 10 : 0) +
        (longPct !== null && longPct > 62 ? 5 : 0) +
        (fundPct !== null && fundPct > 0.05 ? 5 : 0),
      0,
      100
    )
  );
  const bearTrapRisk = Math.round(
    clamp(
      (supBreak.wick || supBreak.failed ? 30 : 0) +
        (supBreak.volume === "Not confirmed" ? 15 : 0) +
        (mean(v.slice(-3)) < avgVol ? 10 : 0) +
        (rsiNow !== null && rsiNow < 30 ? 10 : 0) +
        (facHit(bullRev, "rsiDiv") ? 15 : 0) +
        (facHit(bullRev, "macdDiv") ? 10 : 0) +
        (mDir !== -1 ? 10 : 0) +
        (facHit(bullRev, "failBreak") ? 10 : 0) +
        (accum >= 60 ? 10 : 0) +
        (longPct !== null && longPct < 45 ? 5 : 0) +
        (fundPct !== null && fundPct < -0.03 ? 5 : 0),
      0,
      100
    )
  );
  const shape = (st, prob, risk, riskName) => ({
    status: st.status,
    probability: prob,
    volume: st.volume,
    retest: st.retest,
    risk,
    riskName,
    note: st.note,
    zone: st.zone,
    zoneLabel: zoneLabel(st.zone),
    checks: st.checks || null,
  });
  const breakout = shape(resBreak, breakoutProb, falseBreakoutRisk, "False breakout risk");
  const breakdown = shape(supBreak, breakdownProb, bearTrapRisk, "Bear trap risk");

  // ========================== FINAL ANALYSIS =============================
  const composite =
    0.28 * trendDir * (strengthScore / 100) +
    0.22 * mDir * (momentumScore / 100) +
    0.18 * structDir +
    0.12 * ((bullRev.score - bearRev.score) / 100) +
    0.1 * ((breakoutProb - breakdownProb) / 100) +
    0.1 * ((accum - distScore) / 100);
  const overallScore = Math.round(clamp(50 + 50 * composite, 0, 100));
  const overallLabel = overallScore >= 65 ? "BULLISH BIAS" : overallScore <= 35 ? "BEARISH BIAS" : "NEUTRAL / MIXED";
  const biasSign = overallScore >= 65 ? 1 : overallScore <= 35 ? -1 : 0;
  const slopeDirSimple = Math.abs(slopePct) >= avgRangePct * 1.5 && reg.r2 >= 0.35 ? sign(reg.slope) : 0;
  const groups = [
    { name: "EMA alignment", dir: emaDir },
    { name: "price slope", dir: slopeDirSimple },
    { name: "market structure", dir: structDir },
    { name: "MACD", dir: sign(macdHist[n - 1] + macdLine[n - 1]) },
    { name: "RSI", dir: rsiNow === null ? 0 : rsiNow > 55 ? 1 : rsiNow < 45 ? -1 : 0 },
    { name: "volume flow", dir: sign(volFlow, 0.1) },
  ];
  const agreeing = biasSign === 0 ? [] : groups.filter((g) => g.dir === biasSign);
  const confirmation = biasSign === 0 ? "No directional bias" : agreeing.length >= 5 ? "Confirmed" : agreeing.length === 4 ? "Probable" : "Possible";

  // market state + what to watch
  const nearR = r1 && (r1.low - last) / atr <= 1.5;
  const nearS = s1 && (last - s1.high) / atr <= 1.5;
  const where = nearR ? "near resistance" : nearS ? "near support" : "mid-range";
  const trendWord = trendDir === 1 ? "Bullish" : trendDir === -1 ? "Bearish" : "Sideways";
  const marketState = `${trendWord} trend → ${trendDir === 0 ? "ranging" : "currently " + condition.toLowerCase().replace("trend ", "")} ${where}`;
  const fp = (z) => (z ? fmtP(z.mid) : null);
  const watch = [];
  if (trendDir === 1) {
    watch.push(r1 ? `A candle close above R1 (${fp(r1)}) with above-average volume would strengthen the bullish continuation scenario.` : "Price is at the top of this period with no resistance zone above — watch for a pullback and whether it holds support.");
    watch.push(s1 ? `A rejection followed by a break below the nearest support (${fp(s1)}) would increase reversal probability.` : "A drop back through recent swing lows would increase reversal probability.");
  } else if (trendDir === -1) {
    watch.push(s1 ? `A candle close below S1 (${fp(s1)}) with above-average volume would strengthen the bearish continuation scenario.` : "Price is at the bottom of this period with no support zone below — watch for a bounce and whether it fails at resistance.");
    watch.push(r1 ? `A rejection followed by a close above the nearest resistance (${fp(r1)}) on volume would increase reversal probability.` : "A rise back through recent swing highs would increase reversal probability.");
  } else {
    watch.push(r1 ? `A close above R1 (${fp(r1)}) on above-average volume would be the first sign of an upside breakout.` : "No resistance zone above — watch for a push to new highs on volume.");
    watch.push(s1 ? `A close below S1 (${fp(s1)}) on above-average volume would be the first sign of a downside breakdown.` : "No support zone below — watch for a push to new lows on volume.");
  }

  const explanation = [];
  explanation.push(
    `Overall trend is ${trendLabel} (structure ${structScore > 0.15 ? "bullish" : structScore < -0.15 ? "bearish" : "mixed"}, slope ${slopePct >= 0 ? "+" : ""}${slopePct.toFixed(1)}% with R² ${reg.r2.toFixed(2)}, EMAs ${emaDir === 0 ? "mixed" : emaDir === 1 ? "aligned up" : "aligned down"}); right now it is "${condition.toLowerCase()}". Strength ${strengthScore}/100 (${strengthLabel.toLowerCase()}).`
  );
  explanation.push(`Momentum is ${momentumDisplay.toLowerCase()} at ${momentumScore}/100 — ${momentumCondition.toLowerCase()}.`);
  explanation.push(
    revBand === "No reversal"
      ? `No meaningful reversal factors are lining up (${revScore}/100).`
      : `Reversal: ${revText.toLowerCase()} — ${revLead ? revLead.toLowerCase() : ""} side scores ${revScore}/100 with ${leadSide.hits} of 7 factors.`
  );
  explanation.push(`Positioning reads as "${flowState.toLowerCase()}" (accumulation ${accum}/100, distribution ${distScore}/100) — inferred from price, volume and derivatives data, not proof of what large traders are doing.`);
  explanation.push(
    `Overall market score ${overallScore}/100 (50 is neutral): ${biasSign === 0 ? "no directional bias is strong enough to call" : `${confirmation.toLowerCase()} ${biasSign === 1 ? "bullish" : "bearish"} lean, ${agreeing.length} of ${groups.length} independent groups agree`}. This is a read of the candles you chose, not a buy or sell signal.`
  );

  return {
    n,
    warmup,
    last,
    params,
    atr,
    trend: { label: trendLabel, dir: trendDir, condition, recentDir, weakSignals, counts, slopePct, r2: reg.r2, recentPct },
    strength: { score: strengthScore, label: strengthLabel, components: comps.map((x) => ({ name: x.name, score: Math.round(x.score), weight: x.weight, text: x.text })) },
    momentum: {
      display: momentumDisplay,
      dir: mDir,
      dirLabel: mDir === 1 ? "BULLISH" : mDir === -1 ? "BEARISH" : "MIXED / WEAK",
      score: momentumScore,
      strengthLabel: strengthWord(momentumScore),
      condition: momentumCondition,
      agree: mAgree,
      components: mComps.map((x) => ({ name: x.name, cls: x.cls, value: x.value, text: x.text })),
    },
    reversal: { lead: revLead, score: revScore, band: revBand, text: revText, short: revShort, confirmed: revConfirmed, structureHit, hits: leadSide.hits, factors: leadSide.facs, bearScore: bearRev.score, bullScore: bullRev.score },
    flow: { accum, dist: distScore, state: flowState, note: flowNote, factors: flowF, usedOi: oiKnown, usedTaker: hasTaker },
    support,
    resistance,
    breakout,
    breakdown,
    structure,
    overall: { score: overallScore, label: overallLabel, confirmation, agreeing: agreeing.map((g) => g.name), total: groups.length },
    marketState,
    watch,
    explanation,
  };
}

function fmtP(x) {
  if (!Number.isFinite(x)) return "—";
  const a = Math.abs(x);
  return a >= 1000 ? x.toFixed(1) : a >= 1 ? x.toFixed(3) : a >= 0.01 ? x.toFixed(5) : x.toPrecision(4);
}
