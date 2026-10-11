// Tests for the Entry Radar data layer (fake network, fake clock).  node --test src/
import test from "node:test";
import assert from "node:assert/strict";
import { createRadarScanner, filterEligible, orderSymbols, RateLimitedError, KLINE_LIMIT } from "./radarScanner.js";
import { TF_MS } from "./entryRadar.js";

let clock = Date.UTC(2026, 9, 11, 12, 7, 30);
const now = () => clock;
const noSleep = async () => {};

function klineRows(tf, n = 250) {
  const ms = TF_MS[tf];
  const lastOpen = Math.floor(clock / ms) * ms;
  return Array.from({ length: n }, (_, i) => {
    const open = lastOpen - (n - 1 - i) * ms;
    const p = 100 + i * 0.1;
    return [open, String(p), String(p + 1), String(p - 1), String(p + 0.2), "10", open + ms - 1, String(1000)];
  });
}
const resp = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// A scriptable fake of the shared fapiFetch.
function fakeNet(handler) {
  const calls = [];
  let inflight = 0, maxInflight = 0;
  const fapiFetch = async (url) => {
    calls.push(url);
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    await new Promise((r) => setImmediate(r));
    try {
      return await handler(url, calls.length);
    } finally {
      inflight--;
    }
  };
  return { fapiFetch, calls, maxInflight: () => maxInflight };
}

test("filterEligible keeps only USDT PERPETUAL TRADING contracts", () => {
  const info = {
    symbols: [
      { symbol: "BTCUSDT", quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING", baseAsset: "BTC" },
      { symbol: "BTCUSDT_261225", quoteAsset: "USDT", contractType: "CURRENT_QUARTER", status: "TRADING" },
      { symbol: "ETHUSDC", quoteAsset: "USDC", contractType: "PERPETUAL", status: "TRADING" },
      { symbol: "OLDUSDT", quoteAsset: "USDT", contractType: "PERPETUAL", status: "BREAK" },
      { symbol: "NEWUSDT", quoteAsset: "USDT", contractType: "PERPETUAL", status: "PENDING_TRADING" },
      { symbol: "XRPUSDT", quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING", baseAsset: "XRP" },
      null,
    ],
  };
  assert.deepEqual(filterEligible(info).map((s) => s.symbol), ["BTCUSDT", "XRPUSDT"]);
  assert.deepEqual(filterEligible(null), []);
  assert.deepEqual(filterEligible({ symbols: "nope" }), []);
});

test("orderSymbols: priority first, then by 24h volume", () => {
  const el = ["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT"].map((symbol) => ({ symbol }));
  const tk = { AAAUSDT: { quoteVolume: "10" }, BBBUSDT: { quoteVolume: "500" }, CCCUSDT: { quoteVolume: "100" } };
  assert.deepEqual(orderSymbols(el, tk, []).map((s) => s.symbol), ["BBBUSDT", "CCCUSDT", "AAAUSDT", "DDDUSDT"]);
  assert.deepEqual(orderSymbols(el, tk, ["DDDUSDT", "AAAUSDT"]).map((s) => s.symbol), ["DDDUSDT", "AAAUSDT", "BBBUSDT", "CCCUSDT"]);
});

test("exchangeInfo is cached for an hour and falls back to stale cache on failure", async () => {
  let fail = false;
  const net = fakeNet(async () => (fail ? resp({}, 500) : resp({ symbols: [{ symbol: "BTCUSDT", quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING" }] })));
  const sc = createRadarScanner({ fapiFetch: net.fapiFetch, now, sleep: noSleep });
  const a = await sc.loadExchangeInfo();
  await sc.loadExchangeInfo();
  assert.equal(net.calls.length, 1);
  assert.equal(a.symbols.length, 1);
  clock += 61 * 60_000;
  fail = true;
  const b = await sc.loadExchangeInfo();
  assert.equal(b.stale, true);
  assert.equal(b.symbols.length, 1);
  clock -= 61 * 60_000;
});

test("a fresh scanner with no cache and a dead API throws (caller shows an error state)", async () => {
  const net = fakeNet(async () => resp({}, 500));
  const sc = createRadarScanner({ fapiFetch: net.fapiFetch, now, sleep: noSleep });
  await assert.rejects(() => sc.loadExchangeInfo());
});

test("identical concurrent kline requests are de-duplicated into one", async () => {
  const net = fakeNet(async () => resp(klineRows("1h")));
  const sc = createRadarScanner({ fapiFetch: net.fapiFetch, now, sleep: noSleep });
  await Promise.all([sc.getKlines("BTCUSDT", "1h"), sc.getKlines("BTCUSDT", "1h"), sc.getKlines("BTCUSDT", "1h")]);
  assert.equal(net.calls.length, 1);
  assert.equal(sc.stats.dedupHits, 2);
  assert.match(net.calls[0], new RegExp(`limit=${KLINE_LIMIT}`));
});

test("klines are cached within a candle period and refetched after the candle boundary", async () => {
  const net = fakeNet(async () => resp(klineRows("15m")));
  const sc = createRadarScanner({ fapiFetch: net.fapiFetch, now, sleep: noSleep });
  await sc.getKlines("ETHUSDT", "15m");
  clock += 60_000; // same 15m candle (12:08:30)
  await sc.getKlines("ETHUSDT", "15m");
  assert.equal(net.calls.length, 1);
  clock = Math.floor(clock / TF_MS["15m"]) * TF_MS["15m"] + TF_MS["15m"] + 1000; // next candle opened
  await sc.getKlines("ETHUSDT", "15m");
  assert.equal(net.calls.length, 2);
  clock = Date.UTC(2026, 9, 11, 12, 7, 30);
});

test("network / 5xx errors back off exponentially then succeed", async () => {
  const sleeps = [];
  let n = 0;
  const net = fakeNet(async () => (++n <= 2 ? resp({}, 503) : resp(klineRows("4h"))));
  const sc = createRadarScanner({ fapiFetch: net.fapiFetch, now, sleep: async (ms) => sleeps.push(ms) });
  const e = await sc.getKlines("SOLUSDT", "4h");
  assert.equal(e.raw.length, 250);
  assert.equal(net.calls.length, 3);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[1] > sleeps[0], "backoff grows: " + sleeps);
});

test("thrown network errors are retried and eventually surface", async () => {
  const net = fakeNet(async () => {
    throw new Error("Failed to fetch");
  });
  const sc = createRadarScanner({ fapiFetch: net.fapiFetch, now, sleep: noSleep, maxRetries: 2 });
  await assert.rejects(() => sc.getKlines("BADUSDT", "1h"), /Failed to fetch/);
  assert.equal(net.calls.length, 3);
});

test("invalid symbol (HTTP 400) is NOT retried", async () => {
  const net = fakeNet(async () => resp({ code: -1121, msg: "Invalid symbol." }, 400));
  const sc = createRadarScanner({ fapiFetch: net.fapiFetch, now, sleep: noSleep });
  await assert.rejects(() => sc.getKlines("NOPE", "1h"), /HTTP 400/);
  assert.equal(net.calls.length, 1);
});

test("429 waits out the ban then retries; a persistent ban raises RateLimitedError", async () => {
  const sleeps = [];
  let n = 0;
  const net = fakeNet(async () => (++n === 1 ? resp({}, 429) : resp(klineRows("1h"))));
  const sc = createRadarScanner({ fapiFetch: net.fapiFetch, now, sleep: async (ms) => sleeps.push(ms), blockedSecondsLeft: () => 30 });
  const e = await sc.getKlines("BTCUSDT", "1h");
  assert.equal(e.raw.length, 250);
  assert.ok(sleeps[0] >= 30_000, "waited for the ban window");
  assert.equal(sc.stats.rateLimited, 1);

  const net2 = fakeNet(async () => resp({}, 418));
  const sc2 = createRadarScanner({ fapiFetch: net2.fapiFetch, now, sleep: noSleep });
  await assert.rejects(() => sc2.getKlines("BTCUSDT", "1h"), (err) => err instanceof RateLimitedError);
});

test("the shared guard throwing 'HTTP 429' (as the app's fapiFetch does) is handled the same way", async () => {
  let n = 0;
  const fapiFetch = async () => {
    if (++n === 1) throw new Error("HTTP 429 — Binance is rate-limiting this IP");
    return resp(klineRows("1h"));
  };
  const sc = createRadarScanner({ fapiFetch, now, sleep: noSleep });
  assert.equal((await sc.getKlines("BTCUSDT", "1h")).raw.length, 250);
});

test("garbage / non-array payloads become errors, not crashes", async () => {
  const net = fakeNet(async () => resp({ unexpected: true }));
  const sc = createRadarScanner({ fapiFetch: net.fapiFetch, now, sleep: noSleep });
  await assert.rejects(() => sc.getKlines("BTCUSDT", "1h"), /Unexpected klines response/);
  // evaluate() with nothing cached degrades to INSUFFICIENT DATA rather than throwing
  const r = sc.evaluate("BTCUSDT", { ticker: { lastPrice: "100", priceChangePercent: "1", quoteVolume: "1e9" } });
  assert.equal(r.status, "INSUFFICIENT DATA");
  assert.equal(r.haveKlines, false);
});

test("scan: bounded concurrency, one failing symbol does not stop the others, progress reported", async () => {
  const net = fakeNet(async (url) => {
    if (url.includes("symbol=BAD")) return resp({ msg: "Invalid symbol." }, 400);
    return resp(klineRows(url.match(/interval=(\w+)/)[1]));
  });
  const sc = createRadarScanner({ fapiFetch: net.fapiFetch, now, sleep: noSleep, concurrency: 3 });
  const symbols = ["AAAUSDT", "BADUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT", "EEEUSDT", "FFFUSDT"];
  const done = [], errs = [];
  const progress = [];
  const r = await sc.scanKlines(symbols, { onSymbol: (s) => done.push(s), onError: (s) => errs.push(s), onProgress: (p) => progress.push(p) });
  assert.equal(r.total, 7);
  assert.equal(r.errors, 1);
  assert.deepEqual(errs, ["BADUSDT"]);
  assert.equal(done.length, 6);
  assert.ok(net.maxInflight() <= 3, `max in flight ${net.maxInflight()}`);
  assert.equal(progress[progress.length - 1].done, 7);
  assert.ok(sc.hasKlines("AAAUSDT") && !sc.hasKlines("BADUSDT"));
});

test("scan: a rate-limited symbol is skipped, later symbols still scan", async () => {
  const net = fakeNet(async (url) => (url.includes("symbol=LIMITED") ? resp({}, 429) : resp(klineRows(url.match(/interval=(\w+)/)[1]))));
  const sc = createRadarScanner({ fapiFetch: net.fapiFetch, now, sleep: noSleep, concurrency: 1 });
  const r = await sc.scanKlines(["LIMITEDUSDT", "OKUSDT"]);
  assert.equal(r.errors, 1);
  assert.ok(sc.hasKlines("OKUSDT"));
});

test("scan: rapid cancellation stops further work (symbol switching / new scan)", async () => {
  const net = fakeNet(async (url) => resp(klineRows(url.match(/interval=(\w+)/)[1])));
  const sc = createRadarScanner({ fapiFetch: net.fapiFetch, now, sleep: noSleep, concurrency: 1 });
  let cancelled = false;
  const syms = Array.from({ length: 30 }, (_, i) => `S${i}USDT`);
  const r = await sc.scanKlines(syms, { isCancelled: () => cancelled, onSymbol: (s) => s === "S2USDT" && (cancelled = true) });
  assert.equal(r.cancelled, true);
  assert.ok(net.calls.length < 30 * 3, "stopped early: " + net.calls.length);
});

test("scan pauses while a Binance ban is active and resumes afterwards", async () => {
  let left = 3;
  const sleeps = [];
  const net = fakeNet(async (url) => resp(klineRows(url.match(/interval=(\w+)/)[1])));
  const sc = createRadarScanner({
    fapiFetch: net.fapiFetch, now, concurrency: 1,
    blockedSecondsLeft: () => left,
    sleep: async (ms) => { sleeps.push(ms); left = Math.max(0, left - 1); },
  });
  const states = [];
  await sc.scanKlines(["AUSDT"], { onProgress: (p) => states.push(p.state) });
  assert.ok(states.includes("paused"));
  assert.ok(sc.hasKlines("AUSDT"));
});

test("derivatives: OI change computed from history (DERIVED), long/short from the official ratio; partial failures labelled", async () => {
  const oi = Array.from({ length: 26 }, (_, i) => ({ sumOpenInterestValue: String(1000 + i * 10), timestamp: i }));
  const net = fakeNet(async (url) => {
    if (url.includes("openInterestHist")) return resp(oi);
    if (url.includes("globalLongShortAccountRatio")) return resp([{ longAccount: "0.62", shortAccount: "0.38", longShortRatio: "1.63" }]);
    return resp({}, 404);
  });
  const sc = createRadarScanner({ fapiFetch: net.fapiFetch, now, sleep: noSleep });
  const d = await sc.getDeriv("BTCUSDT");
  assert.ok(Math.abs(d.oiChange1hPct - ((1250 - 1240) / 1240) * 100) < 1e-9);
  assert.ok(Math.abs(d.oiChange24hPct - ((1250 - 1000) / 1000) * 100) < 1e-9);
  assert.equal(d.longPct, 62);
  assert.equal(d.partial, false);
  await sc.getDeriv("BTCUSDT"); // cached
  assert.equal(net.calls.length, 2);

  const net2 = fakeNet(async (url) => (url.includes("openInterestHist") ? resp({}, 400) : resp([{ longAccount: "0.4", shortAccount: "0.6", longShortRatio: "0.67" }])));
  const sc2 = createRadarScanner({ fapiFetch: net2.fapiFetch, now, sleep: noSleep });
  const d2 = await sc2.getDeriv("XUSDT");
  assert.equal(d2.oiChange1hPct, null); // UNAVAILABLE, not invented
  assert.equal(d2.longPct, 40);
  assert.equal(d2.partial, true);
});

test("book ticker: spreads parsed, zero/negative quotes ignored, failure leaves spread unavailable", async () => {
  const net = fakeNet(async () => resp([{ symbol: "BTCUSDT", bidPrice: "100", askPrice: "100.01" }, { symbol: "ZEROUSDT", bidPrice: "0", askPrice: "0" }]));
  const sc = createRadarScanner({ fapiFetch: net.fapiFetch, now, sleep: noSleep });
  const b = await sc.loadBook();
  assert.deepEqual(Object.keys(b.map), ["BTCUSDT"]);
  const bad = createRadarScanner({ fapiFetch: fakeNet(async () => resp({}, 500)).fapiFetch, now, sleep: noSleep, maxRetries: 0 });
  const b2 = await bad.loadBook();
  assert.deepEqual(b2.map, {});
});

test("evaluate: end to end from cached klines, with a stale ticker flagged", async () => {
  const net = fakeNet(async (url) => resp(klineRows(url.match(/interval=(\w+)/)[1])));
  const sc = createRadarScanner({ fapiFetch: net.fapiFetch, now, sleep: noSleep });
  await sc.scanKlines(["TESTUSDT"]);
  const tk = { lastPrice: "125", priceChangePercent: "1", quoteVolume: "5e8" };
  const ok = sc.evaluate("TESTUSDT", { ticker: tk, tickerAgeMs: 2000 });
  assert.equal(ok.haveKlines, true);
  assert.ok(ok.freshness.klinesFetchedAt["1h"]);
  assert.ok(ok.score.long >= 0 && ok.score.long <= 100);
  const dead = sc.evaluate("TESTUSDT", { ticker: tk, tickerAgeMs: 25 * 60_000 });
  assert.equal(dead.status, "INSUFFICIENT DATA");
  const bad = sc.evaluate("TESTUSDT", { ticker: { lastPrice: "-1", priceChangePercent: "0", quoteVolume: "1" } });
  assert.equal(bad.status, "INSUFFICIENT DATA");
});
