// Public liquidation-order stream (Binance USDⓈ-M "All Market Liquidation Order Streams",
// wss://fstream.binance.com/ws/!forceOrder@arr — documented, no API key).
// Events are collected ONLY while this is running; Binance offers no public historical liquidation
// data, so these are "observed since the page was opened". Nothing is estimated here.
// Binance sends at most one liquidation snapshot per symbol per second, so tiny bursts can be missed.

const isNum = (x) => typeof x === "number" && Number.isFinite(x);

// {"e":"forceOrder","E":..,"o":{"s":"BTCUSDT","S":"SELL","q":"0.014","p":"9910","ap":"9910","X":"FILLED","l":"0.014","z":"0.014","T":..}}
// S = SELL means a LONG position was liquidated; BUY means a SHORT was liquidated.
export function parseForceOrder(msg) {
  const m = msg && msg.e === "forceOrder" ? msg : null;
  const o = m && m.o;
  if (!o || typeof o.s !== "string") return null;
  if (o.S !== "SELL" && o.S !== "BUY") return null;
  const price = parseFloat(o.ap) > 0 ? parseFloat(o.ap) : parseFloat(o.p);
  const qty = parseFloat(o.z) > 0 ? parseFloat(o.z) : parseFloat(o.q);
  const t = Number(o.T || m.E);
  if (!isNum(price) || !(price > 0) || !isNum(qty) || !(qty > 0) || !isNum(t)) return null;
  return { t, symbol: o.s, side: o.S, price, qty, notional: price * qty };
}

export function createLiqStream({ WebSocketImpl, url = "wss://fstream.binance.com/ws/!forceOrder@arr", now = () => Date.now(), perSymbol = 300, retryMs = 5000, maxRetryMs = 60000 } = {}) {
  const WS = WebSocketImpl || (typeof WebSocket !== "undefined" ? WebSocket : null);
  const bySymbol = new Map();
  let ws = null;
  let status = "idle"; // idle | connecting | open | closed | error | unsupported
  let startedAt = null;
  let total = 0;
  let stopped = true;
  let retry = retryMs;
  let timer = null;
  let lastError = null;
  const listeners = new Set();
  const emit = () => listeners.forEach((f) => { try { f(); } catch { /* listener errors never break the stream */ } });
  const push = (e) => {
    const arr = bySymbol.get(e.symbol) || [];
    arr.push(e);
    if (arr.length > perSymbol) arr.splice(0, arr.length - perSymbol);
    bySymbol.set(e.symbol, arr);
    total++;
  };
  function connect() {
    if (!WS) { status = "unsupported"; emit(); return; }
    status = "connecting";
    emit();
    try { ws = new WS(url); } catch (e) { status = "error"; lastError = String(e && e.message ? e.message : e); emit(); schedule(); return; }
    ws.onopen = () => { status = "open"; retry = retryMs; if (startedAt === null) startedAt = now(); emit(); };
    ws.onmessage = (ev) => {
      let data;
      try { data = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); } catch { return; } // malformed frame: ignore
      const e = parseForceOrder(data && data.data ? data.data : data);
      if (e) { push(e); emit(); }
    };
    ws.onerror = () => { lastError = "WebSocket error"; status = "error"; emit(); };
    ws.onclose = () => { if (stopped) { status = "closed"; emit(); return; } status = "closed"; emit(); schedule(); };
  }
  function schedule() {
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = null; if (!stopped) connect(); }, retry);
    retry = Math.min(maxRetryMs, retry * 2);
  }
  return {
    start() { if (!stopped) return; stopped = false; connect(); },
    stop() { stopped = true; if (timer) { clearTimeout(timer); timer = null; } try { ws && ws.close(); } catch { /* already closed */ } status = "closed"; emit(); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    eventsFor(symbol) { return (bySymbol.get(symbol) || []).slice(); },
    info() { return { status, startedAt, total, lastError, since: startedAt === null ? null : now() - startedAt }; },
    _push: push, // tests
  };
}
