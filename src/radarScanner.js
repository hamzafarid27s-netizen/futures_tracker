// src/radarScanner.js
//
// Data layer for Entry Radar. It owns every network call the radar makes and
// keeps them polite:
//   * caching (exchange info 1h, klines by candle boundary, book 10s, derivs 5m)
//   * request de-duplication (two callers asking for the same thing share one request)
//   * bounded concurrency (a small worker pool, never "fire 500 at once")
//   * exponential backoff on network / 5xx errors
//   * 418 / 429 handling: wait out Binance's ban (via the app's shared guard),
//     retry a couple of times, then give up on THAT symbol only — the scan goes on
//   * weight headroom: asks the shared guard before each request
//
// Only documented public Binance USDⓈ-M endpoints are used; none needs an API
// key. The Binance rate-limit guard lives in App.jsx, so its functions are
// injected (this also makes the scanner unit-testable with a fake fetch).
//
//   GET /fapi/v1/exchangeInfo                         weight 1
//   GET /fapi/v1/klines?symbol&interval&limit=250     weight 2   (limit 100–499)
//   GET /fapi/v1/ticker/bookTicker                    weight 5   (all symbols)
//   GET /futures/data/openInterestHist?period=1h      (own limit: 1000 / 5 min / IP)
//   GET /futures/data/globalLongShortAccountRatio     (own limit: 1000 / 5 min / IP)
// 24h ticker and funding come from the app's existing pollers (not re-fetched).

import { analyzeFrame, evaluateSymbol, TF_MS } from "./entryRadar.js";

export const KLINE_LIMIT = 250; // enough closed candles for EMA200 with margin
const MAX_KLINE_AGE = { "5m": 10 * 60_000, "15m": 15 * 60_000, "1h": 20 * 60_000, "4h": 30 * 60_000 };
const EXCHANGE_TTL = 60 * 60_000;
const BOOK_TTL = 10_000;
const DERIV_TTL = 5 * 60_000;

export class RateLimitedError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "RateLimitedError";
    this.rateLimited = true;
  }
}

// Which symbols are eligible: USDT-quoted, perpetual, currently trading.
export function filterEligible(exchangeInfo) {
  const list = exchangeInfo && Array.isArray(exchangeInfo.symbols) ? exchangeInfo.symbols : [];
  return list
    .filter((s) => s && s.quoteAsset === "USDT" && s.contractType === "PERPETUAL" && s.status === "TRADING" && typeof s.symbol === "string")
    .map((s) => ({ symbol: s.symbol, base: s.baseAsset || s.symbol.replace(/USDT$/, "") }));
}

// Order symbols for scanning: priority symbols (selected / visible) first,
// then by 24h quote volume, highest first.
export function orderSymbols(eligible, tickerBySymbol, priority = []) {
  const prio = new Map(priority.map((s, i) => [s, i]));
  return [...eligible].sort((a, b) => {
    const pa = prio.has(a.symbol), pb = prio.has(b.symbol);
    if (pa !== pb) return pa ? -1 : 1;
    if (pa && pb) return prio.get(a.symbol) - prio.get(b.symbol);
    const va = parseFloat(tickerBySymbol[a.symbol]?.quoteVolume) || 0;
    const vb = parseFloat(tickerBySymbol[b.symbol]?.quoteVolume) || 0;
    return vb - va;
  });
}

export function createRadarScanner(deps) {
  const {
    fapiFetch,
    waitForWeightHeadroom = async () => {},
    blockedSecondsLeft = () => 0,
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    concurrency = 2,
    base = "https://fapi.binance.com",
    maxRetries = 3,
    // Max request-weight the radar itself may spend in any rolling 60 s.
    // The app's own polling shares the same Binance IP budget, so the radar
    // stays well below it. Infinity = no self-limit (used by unit tests).
    weightBudgetPerMin = Infinity,
  } = deps;
  const spent = []; // [timestamp, weight] of recent radar requests

  const cache = { exchange: null, book: null, klines: new Map(), deriv: new Map() };
  const inflight = new Map();
  const stats = { requests: 0, retries: 0, rateLimited: 0, dedupHits: 0 };

  const dedupe = (key, fn) => {
    if (inflight.has(key)) {
      stats.dedupHits++;
      return inflight.get(key);
    }
    const p = Promise.resolve()
      .then(fn)
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };

  // One HTTP GET with weight headroom, backoff and 418/429 handling.
  async function request(url, weight = 1) {
    let attempt = 0;
    let limited = 0;
    for (;;) {
      try {
        await waitForWeightHeadroom(weight);
        // self-imposed budget: wait until the last 60 s of radar traffic leaves room
        for (;;) {
          const t = now();
          while (spent.length && t - spent[0][0] >= 60_000) spent.shift();
          const used = spent.reduce((a, x) => a + x[1], 0);
          if (used + weight <= weightBudgetPerMin || spent.length === 0) break;
          // eslint-disable-next-line no-await-in-loop
          await sleep(Math.min(5000, Math.max(250, 60_000 - (t - spent[0][0]) + 50)));
        }
        spent.push([now(), weight]);
        stats.requests++;
        const res = await fapiFetch(url);
        if (res.status === 418 || res.status === 429) {
          const e = new Error(`HTTP ${res.status}`);
          e.status = res.status;
          throw e;
        }
        if (!res.ok) {
          const e = new Error(`HTTP ${res.status}`);
          e.status = res.status;
          throw e;
        }
        return await res.json();
      } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        const isLimit = e.status === 418 || e.status === 429 || /HTTP (418|429)/.test(msg);
        if (isLimit) {
          stats.rateLimited++;
          if (++limited > 2) throw new RateLimitedError(msg);
          const waitMs = Math.min(Math.max(blockedSecondsLeft() * 1000, 5000 * 2 ** limited), 180_000);
          await sleep(waitMs);
          continue;
        }
        // 4xx other than rate limit (e.g. 400 invalid symbol): retrying cannot help
        if (e.status && e.status >= 400 && e.status < 500) throw e;
        if (attempt >= maxRetries) throw e;
        stats.retries++;
        await sleep(Math.min(8000, 500 * 2 ** attempt + Math.random() * 250));
        attempt++;
      }
    }
  }

  // ---------------------------------------------------------- exchange info
  async function loadExchangeInfo({ force = false } = {}) {
    const t = now();
    if (!force && cache.exchange && t - cache.exchange.at < EXCHANGE_TTL) return { symbols: cache.exchange.symbols, at: cache.exchange.at, stale: false, statusMap: cache.exchange.statusMap };
    try {
      const data = await dedupe("exchangeInfo", () => request(`${base}/fapi/v1/exchangeInfo`, 1));
      if (!data || !Array.isArray(data.symbols)) throw new Error("Unexpected exchangeInfo response");
      const statusMap = {};
      data.symbols.forEach((x) => {
        if (x && typeof x.symbol === "string") statusMap[x.symbol] = { status: x.status, contractType: x.contractType, quoteAsset: x.quoteAsset };
      });
      cache.exchange = { at: now(), symbols: filterEligible(data), statusMap };
      return { symbols: cache.exchange.symbols, at: cache.exchange.at, stale: false, statusMap };
    } catch (e) {
      if (cache.exchange) return { symbols: cache.exchange.symbols, at: cache.exchange.at, stale: true, error: e.message, statusMap: cache.exchange.statusMap };
      throw e;
    }
  }

  // -------------------------------------------------------------- book/spread
  async function loadBook() {
    const t = now();
    if (cache.book && t - cache.book.at < BOOK_TTL) return cache.book;
    try {
      const data = await dedupe("book", () => request(`${base}/fapi/v1/ticker/bookTicker`, 5));
      if (!Array.isArray(data)) throw new Error("Unexpected bookTicker response");
      const map = {};
      data.forEach((d) => {
        const bid = parseFloat(d.bidPrice), ask = parseFloat(d.askPrice);
        if (bid > 0 && ask > 0) map[d.symbol] = { bid, ask };
      });
      cache.book = { at: now(), map };
    } catch (e) {
      if (!cache.book) cache.book = { at: 0, map: {}, error: e.message }; // spread shows UNAVAILABLE
    }
    return cache.book;
  }

  // ------------------------------------------------------------------ klines
  const bucketStart = (tf, t) => Math.floor(t / TF_MS[tf]) * TF_MS[tf];
  function klinesFresh(entry, tf, t) {
    if (!entry) return false;
    // a new candle has opened since we fetched -> the previous one just closed
    if (entry.at < bucketStart(tf, t)) return false;
    return t - entry.at <= MAX_KLINE_AGE[tf];
  }
  async function getKlines(symbol, tf, { force = false } = {}) {
    if (!TF_MS[tf]) throw new Error("Unsupported timeframe " + tf);
    const key = `${symbol}|${tf}`;
    const entry = cache.klines.get(key);
    if (!force && klinesFresh(entry, tf, now())) return entry;
    return dedupe("k:" + key, async () => {
      const data = await request(`${base}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${tf}&limit=${KLINE_LIMIT}`, 2);
      if (!Array.isArray(data)) throw new Error("Unexpected klines response");
      const e = { at: now(), raw: data, frame: null, frameValidUntil: 0 };
      cache.klines.set(key, e);
      return e;
    });
  }

  // ------------------------------------------------------------ derivatives
  const pctChange = (a, b) => (b > 0 ? ((a - b) / b) * 100 : null);
  async function getDeriv(symbol, { force = false } = {}) {
    const hit = cache.deriv.get(symbol);
    if (!force && hit && now() - hit.at < DERIV_TTL) return hit.data;
    return dedupe("d:" + symbol, async () => {
      const s = encodeURIComponent(symbol);
      const [oi, ls] = await Promise.allSettled([
        request(`${base}/futures/data/openInterestHist?symbol=${s}&period=1h&limit=26`, 1),
        request(`${base}/futures/data/globalLongShortAccountRatio?symbol=${s}&period=1h&limit=1`, 1),
      ]);
      const data = { oiChange1hPct: null, oiChange4hPct: null, oiChange24hPct: null, longPct: null, shortPct: null, lsRatio: null, partial: false, errors: [] };
      if (oi.status === "fulfilled" && Array.isArray(oi.value) && oi.value.length >= 2) {
        const v = oi.value.map((x) => parseFloat(x.sumOpenInterestValue)).filter((x) => Number.isFinite(x) && x > 0);
        const last = v[v.length - 1];
        data.oiChange1hPct = v.length >= 2 ? pctChange(last, v[v.length - 2]) : null;
        data.oiChange4hPct = v.length >= 5 ? pctChange(last, v[v.length - 5]) : null;
        data.oiChange24hPct = v.length >= 2 ? pctChange(last, v[0]) : null;
      } else data.errors.push("open interest: " + (oi.status === "rejected" ? oi.reason?.message : "no data"));
      if (ls.status === "fulfilled" && Array.isArray(ls.value) && ls.value.length) {
        const r = ls.value[ls.value.length - 1];
        const lp = parseFloat(r.longAccount) * 100, sp = parseFloat(r.shortAccount) * 100, ratio = parseFloat(r.longShortRatio);
        data.longPct = Number.isFinite(lp) ? lp : null;
        data.shortPct = Number.isFinite(sp) ? sp : null;
        data.lsRatio = Number.isFinite(ratio) ? ratio : null;
      } else data.errors.push("long/short ratio: " + (ls.status === "rejected" ? ls.reason?.message : "no data"));
      data.partial = data.errors.length > 0;
      if (oi.status === "rejected" && oi.reason?.rateLimited) throw oi.reason;
      cache.deriv.set(symbol, { at: now(), data });
      return data;
    });
  }

  // ----------------------------------------------------- scanning (worker pool)
  // Runs `task` over `items` with at most `concurrency` in flight. A failure in
  // one item never stops the others.
  async function pool(items, task, { isCancelled = () => false, onProgress } = {}) {
    let next = 0, done = 0, errors = 0;
    const total = items.length;
    const worker = async () => {
      while (!isCancelled()) {
        const i = next++;
        if (i >= items.length) return;
        // honour an active Binance ban before starting more work
        while (blockedSecondsLeft() > 0 && !isCancelled()) {
          onProgress && onProgress({ done, total, errors, state: "paused", pausedSeconds: blockedSecondsLeft() });
          await sleep(1000);
        }
        if (isCancelled()) return;
        try {
          await task(items[i], i);
        } catch (e) {
          errors++;
          items[i] && typeof items[i] === "object" && (items[i].error = e.message);
          if (task.onError) task.onError(items[i], e);
        }
        done++;
        onProgress && onProgress({ done, total, errors, state: "scanning" });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, worker));
    return { done, total, errors, cancelled: isCancelled() };
  }

  // Download (or reuse cached) candles for each symbol's timeframes.
  async function scanKlines(symbols, { tfs = ["4h", "1h", "15m"], isCancelled, onProgress, onSymbol, onError } = {}) {
    const items = symbols.map((s) => ({ symbol: typeof s === "string" ? s : s.symbol }));
    const task = async (item) => {
      for (const tf of tfs) {
        if (isCancelled && isCancelled()) return;
        // eslint-disable-next-line no-await-in-loop
        await getKlines(item.symbol, tf);
      }
      onSymbol && onSymbol(item.symbol);
    };
    task.onError = (item, e) => onError && onError(item.symbol, e);
    return pool(items, task, { isCancelled, onProgress });
  }

  async function scanDeriv(symbols, { isCancelled, onProgress, onSymbol, onError } = {}) {
    const items = symbols.map((s) => ({ symbol: typeof s === "string" ? s : s.symbol }));
    const task = async (item) => {
      await getDeriv(item.symbol);
      onSymbol && onSymbol(item.symbol);
    };
    task.onError = (item, e) => onError && onError(item.symbol, e);
    return pool(items, task, { isCancelled: isCancelled || (() => false), onProgress });
  }

  // ----------------------------------------------------------- evaluation
  // Analysed frame, cached until the next candle closes.
  function frameFor(symbol, tf, t) {
    const e = cache.klines.get(`${symbol}|${tf}`);
    if (!e) return null;
    if (!e.frame || t > e.frameValidUntil) {
      e.frame = analyzeFrame(e.raw, t, tf);
      e.frameValidUntil = e.frame.forming ? e.frame.forming.ct : Infinity;
    }
    return e.frame;
  }
  // Age relative to what should be available: 0 while the cache covers the
  // current candle period, otherwise the real elapsed time.
  function behindMs(symbol, tf, t) {
    const e = cache.klines.get(`${symbol}|${tf}`);
    if (!e) return Infinity;
    return e.at >= bucketStart(tf, t) ? 0 : t - e.at;
  }

  function evaluate(symbol, { ticker, funding, tickerAgeMs = 0, settings, tfs = ["4h", "1h", "15m"] } = {}) {
    const t = now();
    const frames = {};
    const ages = { ticker: tickerAgeMs };
    for (const tf of tfs) {
      const f = frameFor(symbol, tf, t);
      if (f) frames[tf] = f;
      ages[tf] = behindMs(symbol, tf, t);
    }
    const d = cache.deriv.get(symbol);
    const book = cache.book && cache.book.map ? cache.book.map[symbol] || null : null;
    const result = evaluateSymbol({
      symbol,
      frames,
      live: { ticker, book, funding: funding || null, deriv: d ? d.data : null },
      ages,
      settings,
      now: t,
    });
    result.freshness = {
      klinesFetchedAt: Object.fromEntries(tfs.map((tf) => [tf, cache.klines.get(`${symbol}|${tf}`)?.at ?? null])),
      derivFetchedAt: d ? d.at : null,
      bookFetchedAt: cache.book && cache.book.at ? cache.book.at : null,
      tickerAgeMs,
    };
    result.haveKlines = tfs.every((tf) => !!frames[tf]);
    return result;
  }

  // Analysed frames + data ages for one symbol (used by Smart Entry Zone).
  function getFrames(symbol, tfs = ["4h", "1h", "15m"]) {
    const t = now();
    const frames = {};
    const ages = {};
    const fetchedAt = {};
    for (const tf of tfs) {
      const f = frameFor(symbol, tf, t);
      if (f) frames[tf] = f;
      ages[tf] = behindMs(symbol, tf, t);
      fetchedAt[tf] = cache.klines.get(`${symbol}|${tf}`)?.at ?? null;
    }
    return { frames, ages, fetchedAt, at: t };
  }

  return {
    getFrames,
    loadExchangeInfo,
    loadBook,
    getKlines,
    getDeriv,
    scanKlines,
    scanDeriv,
    evaluate,
    hasKlines: (symbol, tfs = ["4h", "1h", "15m"]) => tfs.every((tf) => cache.klines.has(`${symbol}|${tf}`)),
    hasDeriv: (symbol) => cache.deriv.has(symbol),
    clear: () => {
      cache.klines.clear();
      cache.deriv.clear();
      cache.book = null;
    },
    stats,
    _cache: cache,
  };
}
