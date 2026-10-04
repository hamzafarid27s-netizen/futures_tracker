import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { supabase, isBackgroundAlertsConfigured } from "./supabaseClient";

const DARK_THEME = {
  bg: "#0B0F14",
  panel: "#11161D",
  panelAlt: "#0E1319",
  panelRaised: "#161D26",
  border: "#1E2630",
  borderLight: "#2A3440",
  text: "#D8DEE6",
  textMuted: "#6B7684",
  textDim: "#4A535F",
  gain: "#2FD480",
  gainBg: "rgba(47,212,128,0.12)",
  loss: "#FF5C7A",
  lossBg: "rgba(255,92,122,0.12)",
  amber: "#E8A33D",
  blue: "#4F9CFF",
  purple: "#B58EFF",
  teal: "#2DD4CF",
  pink: "#FF7AB8",
  shadow: "0 8px 24px rgba(0,0,0,0.4)",
};

const LIGHT_THEME = {
  bg: "#F5F6F8",
  panel: "#FFFFFF",
  panelAlt: "#F0F2F5",
  panelRaised: "#FAFBFC",
  border: "#E1E4E9",
  borderLight: "#CBD2D9",
  text: "#1B2430",
  textMuted: "#5B6472",
  textDim: "#8A94A3",
  gain: "#1B9E6B",
  gainBg: "rgba(27,158,107,0.10)",
  loss: "#D6425A",
  lossBg: "rgba(214,66,90,0.10)",
  amber: "#B7791F",
  blue: "#1D6FD1",
  purple: "#7C4DFF",
  teal: "#0E8A86",
  pink: "#D1368A",
  shadow: "0 8px 24px rgba(20,25,35,0.10)",
};

// A mutable palette object. Rather than threading a theme prop through every
// component, toggling the theme mutates this object's values in place and
// triggers a root re-render — every component reads C.xxx fresh at render
// time, so the whole tree picks up the new colors without prop drilling.
// The one thing this can't fix is a color baked into a plain object at
// module-load time (see getFieldStyle below, used instead of a static const).
let C = { ...DARK_THEME };
function applyTheme(mode) {
  Object.assign(C, mode === "light" ? LIGHT_THEME : DARK_THEME);
}

const mono =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
const sans =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

const INTERVALS = [
  { label: "5m", min: 5 },
  { label: "15m", min: 15 },
  { label: "30m", min: 30 },
  { label: "1h", min: 60 },
  { label: "2h", min: 120 },
  { label: "3h", min: 180 },
  { label: "4h", min: 240 },
  { label: "5h", min: 300 },
  { label: "6h", min: 360 },
  { label: "7h", min: 420 },
  { label: "8h", min: 480 },
  { label: "10h", min: 600 },
  { label: "12h", min: 720 },
  { label: "16h", min: 960 },
  { label: "20h", min: 1200 },
  { label: "24h", min: 1440 },
  { label: "28h", min: 1680 },
  { label: "32h", min: 1920 },
  { label: "36h", min: 2160 },
  { label: "40h", min: 2400 },
  { label: "44h", min: 2640 },
  { label: "48h", min: 2880 },
  { label: "2.5d", min: 3600 },
  { label: "3d", min: 4320 },
  { label: "3.5d", min: 5040 },
  { label: "4d", min: 5760 },
];
// Ceiling for anything the background job (Edge Function) evaluates for
// EVERY pair at once — global alerts and the default rules. A per-pair
// custom alert can still go further via the app's own foreground history,
// but a market-wide background check beyond this gets expensive fast
// (every symbol's price history has to be retained that far back).
const GLOBAL_BG_MAX_MIN = 1440; // 24h

const DEFAULT_RULES = [
  { min: 5, pct: 4 },
  { min: 15, pct: 6 },
  { min: 30, pct: 8 },
  { min: 60, pct: 10 },
];

// crypto icon CDN (community icon set) — falls back to a lettered badge if missing
function iconUrl(symbol) {
  const base = symbol.replace("USDT", "").toLowerCase();
  return `https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/${base}.png`;
}
function CoinIcon({ symbol, size = 20, logos }) {
  const base = symbol.replace("USDT", "");
  const primaryUrl = logos && logos[base];
  const [stage, setStage] = useState(primaryUrl ? 0 : 1); // 0=coingecko, 1=jsdelivr, 2=badge

  if (stage === 2) {
    return (
      <span
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          background: C.borderLight,
          color: C.text,
          fontSize: size * 0.38,
          fontWeight: 700,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {base.slice(0, 2)}
      </span>
    );
  }
  const src = stage === 0 ? primaryUrl : iconUrl(symbol);
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      onError={() => setStage((s) => s + 1)}
      style={{ borderRadius: "50%", flexShrink: 0, display: "inline-block", verticalAlign: "middle", background: C.borderLight }}
    />
  );
}

function fmtCompact(n) {
  const num = Number(n);
  if (!isFinite(num)) return "—";
  const abs = Math.abs(num);
  if (abs >= 1e9) return (num / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (num / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (num / 1e3).toFixed(2) + "K";
  return num.toFixed(2);
}
function fmtPrice(n) {
  const num = Number(n);
  if (!isFinite(num)) return "—";
  if (num >= 1000) return num.toFixed(2);
  if (num >= 1) return num.toFixed(4);
  if (num >= 0.01) return num.toFixed(5);
  return num.toFixed(8);
}
function fmtPct(n) {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}
// Label for any minute value, including custom ones with no matching
// INTERVALS entry (e.g. an 11h custom alert) — falls back to composing
// "Xh Ym" instead of showing nothing.
function minutesLabel(min) {
  const preset = INTERVALS.find((i) => i.min === min);
  if (preset) return preset.label;
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
function pctColor(n) {
  if (n === null || n === undefined || !isFinite(n)) return C.textDim;
  return n >= 0 ? C.gain : C.loss;
}

// ---- alert hysteresis ----
// A value that hovers right at a threshold (e.g. PNL sitting at -9.95,
// -10.03, -9.55 tick to tick) would otherwise flip the edge-triggered state
// back and forth and fire a fresh notification on every tiny wobble. Once a
// threshold is hit, require the value to retreat past a small buffer before
// it's considered to have genuinely reversed — that buffer is the "dead
// zone" where the alert stays in whatever state it's already in.
function hysteresisBuffer(target) {
  return Math.max(Math.abs(target) * 0.08, 0.3);
}
function passesThreshold(value, target) {
  return target >= 0 ? value >= target : value <= target;
}
function staysPastThreshold(value, target, buffer) {
  return target >= 0 ? value >= target - buffer : value <= target + buffer;
}

// ---- shared Binance rate-limit guard ----
// Every call to fapi.binance.com goes through this, so a single 418/429
// anywhere (bulk ATH/ATL, the main ticker poll, bootstrap, anything) stops
// EVERY other Binance request app-wide until the ban clears, instead of each
// piece of the app continuing to hammer an IP that's already blocked.
const binanceGuard = { blockedUntil: 0, reason: null, consecutiveBans: 0, lastBanAt: 0, usedWeight: 0, weightSeenAt: 0 };
// Binance's documented per-IP budget is 2400 request-weight per rolling
// minute. Staying at a hard ceiling well under that (not 2400 itself) means
// normal jitter/latency/other requests never accidentally tip it over.
const WEIGHT_CEILING = 1600;
function binanceBlockedSecondsLeft() {
  return Math.max(0, Math.ceil((binanceGuard.blockedUntil - Date.now()) / 1000));
}
function currentUsedWeight() {
  // The header is a snapshot from whenever we last saw it; Binance's window
  // is rolling, so treat a stale reading as unknown (0) rather than acting
  // on a number that may no longer be true.
  if (Date.now() - binanceGuard.weightSeenAt > 15000) return 0;
  return binanceGuard.usedWeight;
}
// Call before a *discretionary* batch of requests (bulk ATH/ATL, background
// scans) — waits until Binance's own reported usage has enough headroom,
// instead of guessing at a fixed delay and finding out the hard way.
async function waitForWeightHeadroom(neededWeight) {
  let waited = 0;
  while (currentUsedWeight() + neededWeight > WEIGHT_CEILING && waited < 60000) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 1200));
    waited += 1200;
  }
}
async function fapiFetch(url, opts) {
  if (Date.now() < binanceGuard.blockedUntil) {
    throw new Error(`HTTP 418 (blocked) — Binance is rate-limiting this IP, retrying in ~${binanceBlockedSecondsLeft()}s`);
  }
  const res = await fetch(url, opts);
  const usedWeightHeader = res.headers.get("X-MBX-USED-WEIGHT-1M");
  if (usedWeightHeader) {
    binanceGuard.usedWeight = parseInt(usedWeightHeader, 10);
    binanceGuard.weightSeenAt = Date.now();
  }
  if (res.status === 418 || res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    const headerWaitSec = retryAfter ? parseFloat(retryAfter) : 120;

    // If we get banned again shortly after a previous ban cleared, Binance's
    // own counter clearly hadn't reset yet — trusting the same short
    // Retry-After again just repeats the ban-clear-reban cycle. Escalate
    // instead: each rapid repeat roughly doubles the wait and adds a safety
    // margin, so the app backs off further than Binance's minimum each time.
    const now = Date.now();
    const sinceLastBan = now - binanceGuard.lastBanAt;
    if (binanceGuard.lastBanAt && sinceLastBan < 90 * 1000) {
      binanceGuard.consecutiveBans += 1;
    } else {
      binanceGuard.consecutiveBans = 1;
    }
    const escalation = Math.pow(1.8, binanceGuard.consecutiveBans - 1);
    const waitSec = Math.max(headerWaitSec, 20) * escalation + 10; // +10s safety margin every time

    binanceGuard.blockedUntil = now + waitSec * 1000;
    binanceGuard.reason = res.status;
    binanceGuard.lastBanAt = now;
    throw new Error(`HTTP ${res.status} — Binance is rate-limiting this IP, pausing all requests for ~${Math.round(waitSec)}s`);
  }
  // A clean response resolves the streak — only reset after we've actually
  // gotten real data through, not just because the countdown expired.
  binanceGuard.consecutiveBans = 0;
  return res;
}

async function safeStorageGet(key) {
  try {
    const v = localStorage.getItem("ft:" + key);
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}
async function safeStorageSet(key, value) {
  try {
    localStorage.setItem("ft:" + key, JSON.stringify(value));
  } catch {
    /* best effort */
  }
}

// Web Push's applicationServerKey wants the VAPID public key as a raw
// Uint8Array, not the base64url string it's normally shared as.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

function getDeviceId() {
  const key = "ft:device-id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(key, id);
  }
  return id;
}

export default function FuturesTracker() {
  const [tab, setTab] = useState("market"); // market | analyze | trades | screener | alerts
  const [themeMode, setThemeMode] = useState("dark");
  const [showSettings, setShowSettings] = useState(false);
  const [rows, setRows] = useState([]); // ticker rows
  const [funding, setFunding] = useState({}); // symbol -> rate
  const [status, setStatus] = useState("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [lastUpdated, setLastUpdated] = useState(null);
  const [bootProgress, setBootProgress] = useState(0);
  const [booting, setBooting] = useState(true);

  const [query, setQuery] = useState("");
  const [watchOnly, setWatchOnly] = useState(false);
  const [sortKey, setSortKey] = useState("quoteVolume");
  const [sortDir, setSortDir] = useState("desc");
  const [expanded, setExpanded] = useState(null);

  const [watchlist, setWatchlist] = useState([]);
  const [customAlerts, setCustomAlerts] = useState([]);
  const [globalAlerts, setGlobalAlerts] = useState([]); // {id, min, pct, dir} — applies to every pair
  const [newGlobalAlertForm, setNewGlobalAlertForm] = useState({ min: 15, pct: 5, dir: "either", customAmount: 2, customUnit: "h" });
  const [rulesEnabled, setRulesEnabled] = useState({ 5: true, 15: true, 30: true, 60: true });
  // Master switches: one for the 4 default "global rules" as a group, one
  // shared between global alerts and custom alerts (per-pair/per-rule
  // checkboxes above still narrow things further when the master is on).
  const [globalRulesMasterOn, setGlobalRulesMasterOn] = useState(true);
  const [otherAlertsMasterOn, setOtherAlertsMasterOn] = useState(true);
  // User-editable % thresholds for the 5m/15m/30m/1h default rules
  // (minutes stay fixed; only the percent is adjustable).
  const [defaultRulePcts, setDefaultRulePcts] = useState(() =>
    Object.fromEntries(DEFAULT_RULES.map((r) => [r.min, r.pct]))
  );
  const [triggered, setTriggered] = useState([]);
  const [notifPerm, setNotifPerm] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "unsupported"
  );
  // idle: not checked yet | unconfigured: no Supabase env vars set | off | enabling | on | error
  const [bgAlertsStatus, setBgAlertsStatus] = useState("idle");
  const deviceIdRef = useRef(null);

  const [detailData, setDetailData] = useState({}); // symbol -> {changes:{min:pct}, ratios, updatedAt, loading}
  const [newAlertForm, setNewAlertForm] = useState({ symbol: "", min: 60, pct: 5, dir: "either" });
  const [analyzeSymbol, setAnalyzeSymbol] = useState(null);
  const [coinLogos, setCoinLogos] = useState({});
  const [savedTrades, setSavedTrades] = useState([]); // {id, symbol, entry, margin, leverage, dir, roiAlerts:[{id,pct}], pnlAlerts:[{id,value}]}
  const [athAtlMap, setAthAtlMap] = useState({}); // symbol -> {ath, athTime, atl, atlTime, ...} (1d)
  const [athAtlBulkStatus, setAthAtlBulkStatus] = useState("idle"); // idle | loading | done
  const [athAtlBulkDone, setAthAtlBulkDone] = useState(0);
  // Screener's per-pair, on-demand 1h ATH/ATL — unlike the bulk 1d scan
  // above, this only computes for a pair once the user actually clicks it.
  // symbol -> { status: "loading"|"done"|"error", progress, ath, atl, ... }
  const [screenerAthAtl, setScreenerAthAtl] = useState({});
  const screenerAthAtlRunning = useRef(new Set());
  const [athFilterMode, setAthFilterMode] = useState("none"); // none | ath | atl
  const [extChangeMap, setExtChangeMap] = useState({}); // symbol -> {"120":pct, "240":pct, "480":pct, "720":pct}
  const [extChangeBulkStatus, setExtChangeBulkStatus] = useState("idle"); // idle | loading | done | blocked
  const [extChangeBulkDone, setExtChangeBulkDone] = useState(0);
  // TA screener: symbol -> {trend, trendStrength, momentum, support,
  // resistance, reversal, ...} from fetchTAForSymbol.
  const [taMap, setTaMap] = useState({});
  const [taBulkStatus, setTaBulkStatus] = useState("idle"); // idle | loading | done | blocked
  const [taBulkDone, setTaBulkDone] = useState(0);
  // When Supabase is configured, the TA screener is computed server-side on
  // a schedule (compute-ta Edge Function + pg_cron) so it keeps filling in
  // and staying fresh even if this tab/app isn't open — taSyncedAt is the
  // newest updated_at we've pulled, taServerCount how many pairs the server
  // has scanned so far.
  const [taSyncedAt, setTaSyncedAt] = useState(null);
  const [taServerCount, setTaServerCount] = useState(0);
  const tradeSignRef = useRef({});
  // Edge-triggered "is this rule currently passing?" state, keyed by rule
  // key (+ symbol for price rules). Replaces cooldown-timer firing: a
  // notification goes out only on the false->true transition (and, for
  // trade ROI/PNL targets, also on true->false), never on every tick while
  // the condition stays true — that repeat-while-true behavior was the
  // "same alert notification multiple times" bug.
  const ruleActiveRef = useRef({});
  const tradeThresholdActiveRef = useRef({});
  const tradeLevelActiveRef = useRef({});
  const fundingAlertFiredRef = useRef({}); // `${tradeId}:${nextFundingTime}` -> true once notified

  const bufferRef = useRef({}); // symbol -> [{t, price}]
  const storageLoaded = useRef(false);

  // ---- load persisted state ----
  useEffect(() => {
    (async () => {
      const [wl, ca, ga, re, tf, grm, oam, drp] = await Promise.all([
        safeStorageGet("watchlist"),
        safeStorageGet("custom-alerts"),
        safeStorageGet("global-alerts"),
        safeStorageGet("rules-enabled"),
        safeStorageGet("triggered-feed"),
        safeStorageGet("global-rules-master-on"),
        safeStorageGet("other-alerts-master-on"),
        safeStorageGet("default-rule-pcts"),
      ]);
      if (wl) setWatchlist(wl);
      if (ca) setCustomAlerts(ca);
      if (ga) setGlobalAlerts(ga);
      if (re) setRulesEnabled(re);
      if (tf) setTriggered(tf);
      if (grm !== null && grm !== undefined) setGlobalRulesMasterOn(grm);
      if (oam !== null && oam !== undefined) setOtherAlertsMasterOn(oam);
      if (drp) setDefaultRulePcts(drp);
      const st = await safeStorageGet("saved-trades");
      if (st) setSavedTrades(st);
      const savedTheme = await safeStorageGet("theme-mode");
      if (savedTheme === "light" || savedTheme === "dark") {
        applyTheme(savedTheme);
        setThemeMode(savedTheme);
      }
      // pick up whatever ATH/ATL has already been computed (from Analyze or a
      // previous bulk run) so the Market columns aren't empty on return visits
      const athCache = await safeStorageGet("ath-atl-cache");
      if (athCache) {
        const map = {};
        Object.entries(athCache).forEach(([key, val]) => {
          if (key.endsWith("|1d")) map[key.slice(0, -3)] = val;
        });
        setAthAtlMap(map);
        // Screener's per-pair 1h ATH/ATL shares the same cache store (keyed
        // "<symbol>|1h") as Analyze's precision toggle, so a pair scanned in
        // either place shows up already-done in the other.
        const map1h = {};
        Object.entries(athCache).forEach(([key, val]) => {
          if (key.endsWith("|1h")) map1h[key.slice(0, -3)] = { status: "done", ...val };
        });
        setScreenerAthAtl(map1h);
      }
      const extCache = await safeStorageGet("ext-change-cache");
      if (extCache) {
        const map = {};
        Object.entries(extCache).forEach(([sym, val]) => {
          if (val?.data) map[sym] = val.data;
        });
        setExtChangeMap(map);
      }
      const taCache = await safeStorageGet("ta-cache");
      if (taCache) setTaMap(taCache);
      storageLoaded.current = true;
    })();
  }, []);

  const bulkAthAtlRunning = useRef(false);
  const startAthAtlBulk = async () => {
    if (bulkAthAtlRunning.current || rows.length === 0) return;
    if (Date.now() < binanceGuard.blockedUntil) {
      setAthAtlBulkStatus("blocked");
      return;
    }
    bulkAthAtlRunning.current = true;
    setAthAtlBulkStatus("loading");
    setAthAtlBulkDone(0);
    // Highest-volume pairs first — those are what's visible at the top of
    // the table by default, so they should be the first to fill in.
    const symbols = [...rows].sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume)).map((r) => r.symbol);
    const cacheMap = (await safeStorageGet("ath-atl-cache")) || {};
    // Chunk size stays small, but the real safety mechanism is checking
    // Binance's own reported usage (X-MBX-USED-WEIGHT-1M) before every
    // chunk and waiting for real headroom — a fixed delay was a guess;
    // this responds to what Binance is actually telling us.
    const chunkSize = 3;
    const weightPerSymbol = 5; // 1000-candle klines request, worst case ~2 batches
    let done = 0;
    let blocked = false;
    for (let i = 0; i < symbols.length && !blocked; i += chunkSize) {
      const chunk = symbols.slice(i, i + chunkSize);
      // eslint-disable-next-line no-await-in-loop
      await waitForWeightHeadroom(chunk.length * weightPerSymbol * 2);
      await Promise.allSettled(
        chunk.map(async (sym) => {
          try {
            const key = sym + "|1d";
            const cached = cacheMap[key];
            const result = await fetchTrueAthAtl(sym, "1d", cached, () => {});
            cacheMap[key] = { interval: "1d", ...result };
            setAthAtlMap((m) => ({ ...m, [sym]: result }));
          } catch (e) {
            if (/HTTP (418|429)/.test(e.message || "")) blocked = true;
            /* otherwise skip this symbol, keep going */
          } finally {
            done += 1;
            setAthAtlBulkDone(done);
          }
        })
      );
      // eslint-disable-next-line no-await-in-loop
      await safeStorageSet("ath-atl-cache", cacheMap);
      if (blocked || Date.now() < binanceGuard.blockedUntil) {
        blocked = true;
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 800));
    }
    setAthAtlBulkStatus(blocked ? "blocked" : "done");
    bulkAthAtlRunning.current = false;
    if (blocked) {
      // automatically resume once the ban window (if any) has cleared
      const waitMs = Math.max(5000, binanceGuard.blockedUntil - Date.now());
      setTimeout(() => {
        setAthAtlBulkStatus("idle");
      }, waitMs);
    }
  };

  const bulkTaRunning = useRef(false);
  const startTaBulk = async () => {
    if (bulkTaRunning.current || rows.length === 0) return;
    if (Date.now() < binanceGuard.blockedUntil) {
      setTaBulkStatus("blocked");
      return;
    }
    bulkTaRunning.current = true;
    setTaBulkStatus("loading");
    setTaBulkDone(0);
    const symbols = [...rows].sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume)).map((r) => r.symbol);
    const cacheMap = { ...((await safeStorageGet("ta-cache")) || {}) };
    const chunkSize = 3;
    const weightPerSymbol = 5; // single 150-candle klines request
    let done = 0;
    let blocked = false;
    for (let i = 0; i < symbols.length && !blocked; i += chunkSize) {
      const chunk = symbols.slice(i, i + chunkSize);
      // eslint-disable-next-line no-await-in-loop
      await waitForWeightHeadroom(chunk.length * weightPerSymbol * 2);
      await Promise.allSettled(
        chunk.map(async (sym) => {
          try {
            const result = await fetchTAForSymbol(sym);
            cacheMap[sym] = result;
            setTaMap((m) => ({ ...m, [sym]: result }));
          } catch (e) {
            if (/HTTP (418|429)/.test(e.message || "")) blocked = true;
            /* otherwise skip this symbol, keep going */
          } finally {
            done += 1;
            setTaBulkDone(done);
          }
        })
      );
      // eslint-disable-next-line no-await-in-loop
      await safeStorageSet("ta-cache", cacheMap);
      if (blocked || Date.now() < binanceGuard.blockedUntil) {
        blocked = true;
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 800));
    }
    setTaBulkStatus(blocked ? "blocked" : "done");
    bulkTaRunning.current = false;
    if (blocked) {
      const waitMs = Math.max(5000, binanceGuard.blockedUntil - Date.now());
      setTimeout(() => {
        setTaBulkStatus("idle");
      }, waitMs);
    }
  };

  // Pull the server-computed TA screener (compute-ta Edge Function, run on a
  // pg_cron schedule) whenever Supabase is configured — this is what makes
  // the screener keep scanning and completing in the background, since it
  // runs on Supabase's schedule rather than needing this tab open. Falls
  // back to the client-side startTaBulk() above when Supabase isn't set up.
  useEffect(() => {
    if (!isBackgroundAlertsConfigured() || !supabase) return;
    let cancelled = false;
    const loadServerTa = async () => {
      const { data, error } = await supabase.from("ta_screener").select("*");
      if (cancelled || error || !data) return;
      const map = {};
      let latest = 0;
      data.forEach((r) => {
        map[r.symbol] = {
          trend: r.trend,
          trendStrength: r.trend_strength,
          adx: r.adx,
          momentum: r.momentum,
          rsi: r.rsi,
          support: r.support,
          resistance: r.resistance,
          nearSupportPct: r.near_support_pct,
          nearResistancePct: r.near_resistance_pct,
          reversal: r.reversal,
          price: r.price,
          updatedAt: new Date(r.updated_at).getTime(),
        };
        latest = Math.max(latest, new Date(r.updated_at).getTime());
      });
      setTaMap(map);
      setTaServerCount(data.length);
      setTaSyncedAt(latest || null);
    };
    loadServerTa();
    const id = setInterval(loadServerTa, 60000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Scans ONE pair's true all-time high/low from 1h candles, kicked off by
  // tapping its ATH or ATL cell in the Screener — no bulk pass, since 1h
  // history goes back to the Binance Futures launch and is much heavier per
  // symbol than the 1d bulk scan above.
  const scanScreenerAthAtl = useCallback(async (symbol) => {
    if (screenerAthAtlRunning.current.has(symbol)) return;
    screenerAthAtlRunning.current.add(symbol);
    setScreenerAthAtl((m) => ({ ...m, [symbol]: { status: "loading", progress: null } }));
    try {
      const cacheMap = (await safeStorageGet("ath-atl-cache")) || {};
      const key = symbol + "|1h";
      const cached = cacheMap[key];
      const result = await fetchTrueAthAtl(symbol, "1h", cached, (p) =>
        setScreenerAthAtl((m) => ({ ...m, [symbol]: { status: "loading", progress: p.batch } }))
      );
      cacheMap[key] = { interval: "1h", ...result };
      await safeStorageSet("ath-atl-cache", cacheMap);
      setScreenerAthAtl((m) => ({ ...m, [symbol]: { status: "done", ...result } }));
    } catch (e) {
      setScreenerAthAtl((m) => ({ ...m, [symbol]: { status: "error", error: e.message || "failed" } }));
    } finally {
      screenerAthAtlRunning.current.delete(symbol);
    }
  }, []);

  const toggleAthFilter = (mode) => {
    setAthFilterMode((cur) => (cur === mode ? "none" : mode));
    if (athAtlBulkStatus === "idle") startAthAtlBulk();
  };

  const bulkExtChangeRunning = useRef(false);
  const startExtChangeBulk = async () => {
    if (bulkExtChangeRunning.current || rows.length === 0) return;
    if (Date.now() < binanceGuard.blockedUntil) {
      setExtChangeBulkStatus("blocked");
      return;
    }
    bulkExtChangeRunning.current = true;
    setExtChangeBulkStatus("loading");
    setExtChangeBulkDone(0);
    const symbols = [...rows].sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume)).map((r) => r.symbol);
    const cacheMap = (await safeStorageGet("ext-change-cache")) || {};
    const chunkSize = 5; // cheaper per-request (weight 2) than ATH/ATL, so a bit more parallel
    let done = 0;
    let blocked = false;
    for (let i = 0; i < symbols.length && !blocked; i += chunkSize) {
      const chunk = symbols.slice(i, i + chunkSize);
      // eslint-disable-next-line no-await-in-loop
      await waitForWeightHeadroom(chunk.length * 4);
      await Promise.allSettled(
        chunk.map(async (sym) => {
          try {
            const result = await fetchExtChanges(sym);
            cacheMap[sym] = { data: result, updatedAt: Date.now() };
            setExtChangeMap((m) => ({ ...m, [sym]: result }));
          } catch (e) {
            if (/HTTP (418|429)/.test(e.message || "")) blocked = true;
          } finally {
            done += 1;
            setExtChangeBulkDone(done);
          }
        })
      );
      // eslint-disable-next-line no-await-in-loop
      await safeStorageSet("ext-change-cache", cacheMap);
      if (blocked || Date.now() < binanceGuard.blockedUntil) {
        blocked = true;
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 600));
    }
    setExtChangeBulkStatus(blocked ? "blocked" : "done");
    bulkExtChangeRunning.current = false;
    if (blocked) {
      const waitMs = Math.max(5000, binanceGuard.blockedUntil - Date.now());
      setTimeout(() => setExtChangeBulkStatus("idle"), waitMs);
    }
  };

  // Both background scans run automatically now rather than waiting for a
  // click — sequenced one after another (not concurrently) so they share
  // Binance's weight budget cleanly instead of two loops competing for it.
  useEffect(() => {
    if (rows.length > 0 && athAtlBulkStatus === "idle") startAthAtlBulk();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [athAtlBulkStatus, rows.length > 0]);

  useEffect(() => {
    if (athAtlBulkStatus === "done" && extChangeBulkStatus === "idle") startExtChangeBulk();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [athAtlBulkStatus, extChangeBulkStatus]);

  const changeTheme = (mode) => {
    applyTheme(mode);
    setThemeMode(mode);
    safeStorageSet("theme-mode", mode);
  };

  // ---- background alerts (Supabase + Web Push) ----
  useEffect(() => {
    if (!isBackgroundAlertsConfigured()) {
      setBgAlertsStatus("unconfigured");
      return;
    }
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setBgAlertsStatus("unconfigured");
      return;
    }
    deviceIdRef.current = getDeviceId();
    (async () => {
      try {
        const reg = await navigator.serviceWorker.register("/sw.js");
        const existing = await reg.pushManager.getSubscription();
        setBgAlertsStatus(existing ? "on" : "off");
      } catch {
        setBgAlertsStatus("error");
      }
    })();
  }, []);

  const enableBackgroundAlerts = async () => {
    if (!isBackgroundAlertsConfigured() || !supabase) return;
    setBgAlertsStatus("enabling");
    try {
      if (typeof Notification !== "undefined" && Notification.permission !== "granted") {
        const perm = await Notification.requestPermission();
        setNotifPerm(perm);
        if (perm !== "granted") {
          setBgAlertsStatus("off");
          return;
        }
      }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey),
        });
      }
      const subJson = sub.toJSON();
      const deviceId = deviceIdRef.current || getDeviceId();
      const { error: subErr } = await supabase.from("push_subscriptions").upsert({
        device_id: deviceId,
        endpoint: subJson.endpoint,
        p256dh: subJson.keys.p256dh,
        auth: subJson.keys.auth,
        updated_at: new Date().toISOString(),
      });
      if (subErr) throw subErr;
      await syncAlertConfigToServer(deviceId);
      setBgAlertsStatus("on");
    } catch {
      setBgAlertsStatus("error");
    }
  };

  const disableBackgroundAlerts = async () => {
    if (!supabase) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
      const deviceId = deviceIdRef.current || getDeviceId();
      await supabase.from("push_subscriptions").delete().eq("device_id", deviceId);
    } catch {
      /* best effort — still reflect "off" locally either way */
    }
    setBgAlertsStatus("off");
  };

  const syncAlertConfigToServer = useCallback(
    async (deviceIdOverride) => {
      if (!supabase || bgAlertsStatus !== "on" && !deviceIdOverride) return;
      const deviceId = deviceIdOverride || deviceIdRef.current;
      if (!deviceId) return;
      try {
        await supabase.from("alert_configs").upsert({
          device_id: deviceId,
          rules_enabled: rulesEnabled,
          custom_alerts: customAlerts,
          global_alerts: globalAlerts,
          saved_trades: savedTrades,
          global_rules_master_on: globalRulesMasterOn,
          other_alerts_master_on: otherAlertsMasterOn,
          default_rule_pcts: defaultRulePcts,
          updated_at: new Date().toISOString(),
        });
      } catch {
        /* best effort — foreground alerts still work regardless */
      }
    },
    [bgAlertsStatus, rulesEnabled, customAlerts, globalAlerts, savedTrades, globalRulesMasterOn, otherAlertsMasterOn, defaultRulePcts]
  );

  // keep the server-side copy in sync whenever the alert config actually
  // changes, but only once background alerts are actually turned on
  useEffect(() => {
    if (bgAlertsStatus === "on") syncAlertConfigToServer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgAlertsStatus, rulesEnabled, customAlerts, globalAlerts, savedTrades, globalRulesMasterOn, otherAlertsMasterOn, defaultRulePcts]);

  // ---- persist on change (after initial load) ----
  useEffect(() => {
    if (storageLoaded.current) safeStorageSet("watchlist", watchlist);
  }, [watchlist]);
  useEffect(() => {
    if (storageLoaded.current) safeStorageSet("custom-alerts", customAlerts);
  }, [customAlerts]);
  useEffect(() => {
    if (storageLoaded.current) safeStorageSet("global-alerts", globalAlerts);
  }, [globalAlerts]);
  useEffect(() => {
    if (storageLoaded.current) safeStorageSet("rules-enabled", rulesEnabled);
  }, [rulesEnabled]);
  useEffect(() => {
    if (storageLoaded.current) safeStorageSet("global-rules-master-on", globalRulesMasterOn);
  }, [globalRulesMasterOn]);
  useEffect(() => {
    if (storageLoaded.current) safeStorageSet("other-alerts-master-on", otherAlertsMasterOn);
  }, [otherAlertsMasterOn]);
  useEffect(() => {
    if (storageLoaded.current) safeStorageSet("default-rule-pcts", defaultRulePcts);
  }, [defaultRulePcts]);
  useEffect(() => {
    if (storageLoaded.current) safeStorageSet("triggered-feed", triggered.slice(0, 30));
  }, [triggered]);
  useEffect(() => {
    if (storageLoaded.current) safeStorageSet("saved-trades", savedTrades);
  }, [savedTrades]);

  // ---- fire an alert (in-app + best-effort browser notification) ----
  const fireAlert = useCallback(
    (ruleId, symbol, minutes, thresholdPct, actualChange) => {
      const now = Date.now();
      const intervalLabel = INTERVALS.find((i) => i.min === minutes)?.label || minutes + "m";
      const event = {
        id: symbol + "-" + minutes + "-" + now,
        symbol,
        minutes,
        label: intervalLabel,
        thresholdPct,
        actualChange,
        time: now,
      };
      setTriggered((prev) => [event, ...prev].slice(0, 50));
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        try {
          new Notification(`${symbol.replace("USDT", "/USDT")} ${actualChange >= 0 ? "+" : ""}${actualChange.toFixed(2)}%`, {
            body: `Moved ${actualChange >= 0 ? "up" : "down"} more than ${thresholdPct}% in ${intervalLabel}`,
          });
        } catch {
          /* notifications unavailable in this environment */
        }
      }
    },
    []
  );

  // ---- position flip notification (profit <-> loss) ----
  const fireTradeFlip = useCallback((trade, pnlPct, nowPositive) => {
    const now = Date.now();
    const event = {
      id: trade.id + "-flip-" + now,
      symbol: trade.symbol,
      minutes: null,
      label: nowPositive ? "now in profit" : "now in loss",
      thresholdPct: null,
      actualChange: pnlPct,
      time: now,
      isFlip: true,
    };
    setTriggered((prev) => [event, ...prev].slice(0, 50));
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        new Notification(`${trade.symbol.replace("USDT", "/USDT")} trade ${nowPositive ? "flipped to profit" : "flipped to loss"}`, {
          body: `PnL is now ${fmtPct(pnlPct)}`,
        });
      } catch {
        /* notifications unavailable */
      }
    }
  }, []);

  // ---- trade ROI% / PNL$ target notification (entered target, or reversed back past it) ----
  const fireTradeThreshold = useCallback((trade, kind, target, actual, direction = "hit") => {
    const now = Date.now();
    const unit = kind === "roi" ? "%" : " USDT";
    const kindLabel = kind === "roi" ? "ROI" : "PNL";
    const titleVerb = direction === "hit" ? "target hit" : "back past target";
    const event = {
      id: trade.id + "-" + kind + "-" + target + "-" + direction + "-" + now,
      symbol: trade.symbol,
      minutes: null,
      label: `${kindLabel} ${titleVerb}: target ${target >= 0 ? "+" : ""}${target}${unit}`,
      thresholdPct: null,
      actualChange: actual,
      time: now,
      isFlip: true,
    };
    setTriggered((prev) => [event, ...prev].slice(0, 50));
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        new Notification(`${trade.symbol.replace("USDT", "/USDT")} ${kindLabel} ${titleVerb}`, {
          body: `Target ${target >= 0 ? "+" : ""}${target}${unit} · now ${actual >= 0 ? "+" : ""}${actual.toFixed(2)}${unit}`,
        });
      } catch {
        /* notifications unavailable */
      }
    }
  }, []);

  // ---- tracked trade touches its support or resistance level ----
  const fireTradeLevel = useCallback((trade, kind, level, price) => {
    const now = Date.now();
    const kindLabel = kind === "support" ? "Support" : "Resistance";
    const event = {
      id: trade.id + "-" + kind + "-" + now,
      symbol: trade.symbol,
      minutes: null,
      label: `Price touched ${kindLabel.toLowerCase()} ${fmtPrice(level)}`,
      thresholdPct: null,
      actualChange: null,
      time: now,
      isFlip: true,
    };
    setTriggered((prev) => [event, ...prev].slice(0, 50));
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        new Notification(`${trade.symbol.replace("USDT", "/USDT")} touched ${kindLabel.toLowerCase()}`, {
          body: `Price ${fmtPrice(price)} is near ${kindLabel.toLowerCase()} ${fmtPrice(level)}`,
        });
      } catch {
        /* notifications unavailable */
      }
    }
  }, []);

  // ---- tracked trade is about to pay/receive a funding fee ----
  const fireFundingAlert = useCallback((trade, minutesLeft, rate, markPrice) => {
    const now = Date.now();
    // Funding paid/received = position notional at mark price x funding rate.
    // Positive rate: longs pay, shorts receive. Negative rate: reverse.
    let message = "Funding settlement coming up";
    if (rate !== null && rate !== undefined && markPrice && trade.entry) {
      const qty = (trade.margin * trade.leverage) / trade.entry;
      const fee = qty * markPrice * rate;
      const youPay = trade.dir === "long" ? fee > 0 : fee < 0;
      const amt = Math.abs(fee);
      const amtStr = amt >= 1 ? amt.toFixed(2) : amt.toFixed(4);
      message = youPay ? `You will pay ${amtStr} USDT as funding fee` : `You will receive ${amtStr} USDT as funding fee`;
    }
    const event = {
      id: trade.id + "-funding-" + now,
      symbol: trade.symbol,
      minutes: null,
      label: message,
      thresholdPct: null,
      actualChange: rate !== null && rate !== undefined ? rate * 100 : null,
      time: now,
      isFlip: true,
    };
    setTriggered((prev) => [event, ...prev].slice(0, 50));
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        new Notification(`${trade.symbol.replace("USDT", "/USDT")} funding fee in ${minutesLeft}m`, {
          body: message,
        });
      } catch {
        /* notifications unavailable */
      }
    }
  }, []);

  // ---- change from rolling buffer (covers up to ~65 min) ----
  const changeFromBuffer = useCallback((symbol, minutes) => {
    const buf = bufferRef.current[symbol];
    if (!buf || buf.length < 2) return null;
    const target = Date.now() - minutes * 60000;
    let closest = buf[0];
    let closestDiff = Math.abs(buf[0].t - target);
    for (let i = 1; i < buf.length; i++) {
      const diff = Math.abs(buf[i].t - target);
      if (diff < closestDiff) {
        closest = buf[i];
        closestDiff = diff;
      }
    }
    // require the reference point to be reasonably close to the requested time
    if (closestDiff > minutes * 60000 * 0.6 + 90000) return null;
    const last = buf[buf.length - 1].price;
    return ((last - closest.price) / closest.price) * 100;
  }, []);

  // ---- bootstrap rolling buffer with 1h of 5m candles, batched ----
  const bootstrapBuffer = useCallback(async (symbols) => {
    setBooting(true);
    setBootProgress(0);
    const chunkSize = 12;
    for (let i = 0; i < symbols.length; i += chunkSize) {
      const chunk = symbols.slice(i, i + chunkSize);
      // eslint-disable-next-line no-await-in-loop
      await waitForWeightHeadroom(chunk.length * 2); // limit=13 klines is weight 1 each, small margin
      await Promise.allSettled(
        chunk.map(async (sym) => {
          try {
            const res = await fapiFetch(
              `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=5m&limit=13`
            );
            if (!res.ok) return;
            const data = await res.json();
            if (!Array.isArray(data)) return;
            const pts = data.map((k) => ({ t: k[0], price: parseFloat(k[4]) }));
            bufferRef.current[sym] = pts;
          } catch {
            /* skip symbol on failure */
          }
        })
      );
      setBootProgress(Math.min(100, Math.round(((i + chunkSize) / symbols.length) * 100)));
      await new Promise((r) => setTimeout(r, 90));
    }
    setBooting(false);
  }, []);

  // ---- main poll: ticker (price/volume/24h%) every 8s ----
  const bootstrappedRef = useRef(false);
  const fetchTickers = useCallback(async () => {
    try {
      const res = await fapiFetch("https://fapi.binance.com/fapi/v1/ticker/24hr");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error("Unexpected response");
      const usdt = data.filter((d) => d.symbol.endsWith("USDT"));
      const now = Date.now();
      usdt.forEach((d) => {
        const price = parseFloat(d.lastPrice);
        if (!bufferRef.current[d.symbol]) bufferRef.current[d.symbol] = [];
        const buf = bufferRef.current[d.symbol];
        buf.push({ t: now, price });
        const cutoff = now - 65 * 60000;
        while (buf.length && buf[0].t < cutoff) buf.shift();
      });
      setRows(usdt);
      setStatus("live");
      setErrorMsg("");
      setLastUpdated(new Date());

      if (!bootstrappedRef.current) {
        bootstrappedRef.current = true;
        bootstrapBuffer(usdt.map((d) => d.symbol));
      }
    } catch (err) {
      setStatus("error");
      setErrorMsg(err.message || "Failed to reach Binance");
    }
  }, [bootstrapBuffer]);

  const fetchFunding = useCallback(async () => {
    try {
      const res = await fapiFetch("https://fapi.binance.com/fapi/v1/premiumIndex");
      const data = await res.json();
      if (!Array.isArray(data)) return;
      const map = {};
      data.forEach((d) => {
        map[d.symbol] = { rate: parseFloat(d.lastFundingRate), nextFundingTime: d.nextFundingTime };
      });
      setFunding(map);
    } catch {
      /* keep previous funding values on failure */
    }
  }, []);

  useEffect(() => {
    fetchTickers();
    fetchFunding();
    const t1 = setInterval(fetchTickers, 8000);
    const t2 = setInterval(fetchFunding, 30000);
    return () => {
      clearInterval(t1);
      clearInterval(t2);
    };
  }, [fetchTickers, fetchFunding]);

  // ---- coin logos, best-effort, fetched once ----
  useEffect(() => {
    (async () => {
      try {
        const map = {};
        for (const page of [1, 2]) {
          const res = await fetch(
            `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}&sparkline=false`
          );
          if (!res.ok) continue;
          const data = await res.json();
          if (!Array.isArray(data)) continue;
          data.forEach((c) => {
            const sym = (c.symbol || "").toUpperCase();
            if (sym && !map[sym]) map[sym] = c.image;
          });
        }
        if (Object.keys(map).length) setCoinLogos(map);
      } catch {
        /* fall back to the secondary icon source per-symbol */
      }
    })();
  }, []);

  // ---- alert evaluation every ~5s using buffer + cached detail data ----
  // Edge-triggered: a rule key only fires fireAlert() on the false->true
  // transition (passes now, didn't last tick). While a move stays past the
  // threshold it keeps "passing" every tick but ruleActiveRef is already
  // true, so nothing fires again — and once it drops back under the
  // threshold the key resets to false so the next real crossing can fire.
  useEffect(() => {
    const id = setInterval(() => {
      const active = ruleActiveRef.current;
      // value/target are both expressed so target is always the positive
      // (or correctly-signed) threshold magnitude — passesThreshold/
      // staysPastThreshold handle the hysteresis dead-zone from there.
      const checkEdge = (key, value, target, fire) => {
        const was = !!active[key];
        if (!was && passesThreshold(value, target)) {
          active[key] = true;
          fire();
        } else if (was && !staysPastThreshold(value, target, hysteresisBuffer(target))) {
          active[key] = false;
        }
      };
      if (globalRulesMasterOn) {
        rows.forEach((r) => {
          const sym = r.symbol;
          DEFAULT_RULES.forEach((rule) => {
            if (!rulesEnabled[rule.min]) return;
            const pct = defaultRulePcts[rule.min] ?? rule.pct;
            const chg = changeFromBuffer(sym, rule.min);
            if (chg === null) return;
            checkEdge(`default:${rule.min}|${sym}`, Math.abs(chg), pct, () =>
              fireAlert("default:" + rule.min, sym, rule.min, pct, chg)
            );
          });
        });
      }
      if (otherAlertsMasterOn) {
        customAlerts.forEach((a) => {
          let chg = null;
          if (a.min <= 60) {
            chg = changeFromBuffer(a.symbol, a.min);
          } else {
            const dd = detailData[a.symbol];
            chg = dd && dd.changes ? dd.changes[a.min] : null;
          }
          if (chg === null || !isFinite(chg)) return;
          const value = a.dir === "either" ? Math.abs(chg) : a.dir === "up" ? chg : -chg;
          checkEdge(`custom:${a.id}`, value, a.pct, () => fireAlert("custom:" + a.id, a.symbol, a.min, a.pct, chg));
        });
        globalAlerts.forEach((g) => {
          rows.forEach((r) => {
            const chg = changeFromBuffer(r.symbol, g.min);
            if (chg === null || !isFinite(chg)) return;
            const value = g.dir === "either" ? Math.abs(chg) : g.dir === "up" ? chg : -chg;
            checkEdge(`global:${g.id}|${r.symbol}`, value, g.pct, () => fireAlert("global:" + g.id, r.symbol, g.min, g.pct, chg));
          });
        });
      }
    }, 5000);
    return () => clearInterval(id);
  }, [rows, rulesEnabled, customAlerts, globalAlerts, detailData, changeFromBuffer, fireAlert, globalRulesMasterOn, otherAlertsMasterOn, defaultRulePcts]);

  // ---- saved trade PnL sign-flip + ROI%/PNL$ target notifications ----
  // ROI/PNL targets are edge-triggered both directions: fire once on
  // crossing INTO the target, and fire again if the value later crosses
  // back OUT of it (e.g. ROI climbs past +10% then drops back under +10%)
  // — a reversal is just as notification-worthy as reaching the target in
  // the first place, and this also stops the multi-notification pileup
  // that happened when several thresholds were satisfied at once, since
  // each threshold now fires once per crossing rather than on every tick.
  useEffect(() => {
    if (savedTrades.length === 0 || rows.length === 0) return;
    savedTrades.forEach((t) => {
      const row = rows.find((r) => r.symbol === t.symbol);
      if (!row) return;
      const current = parseFloat(row.lastPrice);
      const pnlPct = t.dir === "long" ? ((current - t.entry) / t.entry) * 100 : ((t.entry - current) / t.entry) * 100;
      const nowPositive = pnlPct >= 0;
      const prevSign = tradeSignRef.current[t.id];
      if (prevSign !== undefined && prevSign !== nowPositive) {
        fireTradeFlip(t, pnlPct, nowPositive);
      }
      tradeSignRef.current[t.id] = nowPositive;

      // leveraged PnL (USDT) and ROI% on margin — same convention as the card's own display
      const sizeUsdt = t.margin * t.leverage;
      const pnlUsdt = t.dir === "long" ? ((current - t.entry) / t.entry) * sizeUsdt : ((t.entry - current) / t.entry) * sizeUsdt;
      const roi = t.margin ? (pnlUsdt / t.margin) * 100 : null;

      const activeT = tradeThresholdActiveRef.current;
      (t.roiAlerts || []).forEach((a) => {
        if (roi === null) return;
        const key = t.id + ":roi:" + a.id;
        const was = !!activeT[key];
        if (!was && passesThreshold(roi, a.pct)) {
          activeT[key] = true;
          fireTradeThreshold(t, "roi", a.pct, roi, "hit");
        } else if (was && !staysPastThreshold(roi, a.pct, hysteresisBuffer(a.pct))) {
          activeT[key] = false;
          fireTradeThreshold(t, "roi", a.pct, roi, "reversed");
        }
      });
      (t.pnlAlerts || []).forEach((a) => {
        const key = t.id + ":pnl:" + a.id;
        const was = !!activeT[key];
        if (!was && passesThreshold(pnlUsdt, a.value)) {
          activeT[key] = true;
          fireTradeThreshold(t, "pnl", a.value, pnlUsdt, "hit");
        } else if (was && !staysPastThreshold(pnlUsdt, a.value, hysteresisBuffer(a.value))) {
          activeT[key] = false;
          fireTradeThreshold(t, "pnl", a.value, pnlUsdt, "reversed");
        }
      });

      // Mark price touches this trade's support or resistance level (from
      // the shared TA screener data) — edge-triggered with a wider reset
      // band so lingering right at the level doesn't re-fire every tick.
      const taRow = taMap[t.symbol];
      if (taRow) {
        const activeL = tradeLevelActiveRef.current;
        if (taRow.support) {
          const key = t.id + ":support";
          const nearPct = (Math.abs(current - taRow.support) / current) * 100;
          const was = !!activeL[key];
          if (!was && nearPct <= 1) {
            activeL[key] = true;
            fireTradeLevel(t, "support", taRow.support, current);
          } else if (was && nearPct > 2) {
            activeL[key] = false;
          }
        }
        if (taRow.resistance) {
          const key = t.id + ":resistance";
          const nearPct = (Math.abs(current - taRow.resistance) / current) * 100;
          const was = !!activeL[key];
          if (!was && nearPct <= 1) {
            activeL[key] = true;
            fireTradeLevel(t, "resistance", taRow.resistance, current);
          } else if (was && nearPct > 2) {
            activeL[key] = false;
          }
        }
      }
    });
  }, [rows, savedTrades, taMap, fireTradeFlip, fireTradeThreshold, fireTradeLevel]);

  // ---- tracked trades: notify 10 minutes before a funding fee settles ----
  // Keyed by trade id + that funding round's own timestamp, so each 8h
  // funding interval only ever notifies once per trade, and the next
  // interval (a new nextFundingTime) is free to fire again automatically —
  // no explicit reset needed.
  useEffect(() => {
    if (savedTrades.length === 0) return;
    const check = () => {
      const now = Date.now();
      savedTrades.forEach((t) => {
        const f = funding[t.symbol];
        if (!f || !f.nextFundingTime) return;
        const msLeft = f.nextFundingTime - now;
        if (msLeft <= 0 || msLeft > 10 * 60 * 1000) return;
        const key = t.id + ":" + f.nextFundingTime;
        if (fundingAlertFiredRef.current[key]) return;
        fundingAlertFiredRef.current[key] = true;
        const row = rows.find((r) => r.symbol === t.symbol);
        const mark = row ? parseFloat(row.lastPrice) : null;
        fireFundingAlert(t, Math.max(1, Math.round(msLeft / 60000)), f.rate, mark);
      });
    };
    check();
    const id = setInterval(check, 15000);
    return () => clearInterval(id);
  }, [savedTrades, funding, rows, fireFundingAlert]);

  // ---- detail data (full interval grid) for watchlisted / long-interval-alerted / expanded symbols ----
  const monitored = useMemo(() => {
    const s = new Set(watchlist);
    customAlerts.forEach((a) => {
      if (a.min > 60) s.add(a.symbol);
    });
    if (expanded) s.add(expanded);
    if (analyzeSymbol) s.add(analyzeSymbol);
    savedTrades.forEach((t) => s.add(t.symbol));
    return Array.from(s);
  }, [watchlist, customAlerts, expanded, analyzeSymbol, savedTrades]);
  const monitoredKey = monitored.slice().sort().join(",");

  const fetchDetail = useCallback(async (symbol) => {
    setDetailData((d) => ({ ...d, [symbol]: { ...(d[symbol] || {}), loading: true } }));
    try {
      const [klinesRes, globalRatioRes, topPosRatioRes, topAcctRatioRes] = await Promise.allSettled([
        fapiFetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=1200`),
        fapiFetch(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=15m&limit=1`),
        fapiFetch(`https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=15m&limit=1`),
        fapiFetch(`https://fapi.binance.com/futures/data/topLongShortAccountRatio?symbol=${symbol}&period=15m&limit=1`),
      ]);

      let changes = null;
      if (klinesRes.status === "fulfilled" && klinesRes.value.ok) {
        const data = await klinesRes.value.json();
        if (Array.isArray(data) && data.length >= 2) {
          const closes = data.map((k) => parseFloat(k[4]));
          const last = closes[closes.length - 1];
          changes = {};
          INTERVALS.forEach((iv) => {
            const idx = closes.length - 1 - iv.min / 5;
            if (idx >= 0) changes[iv.min] = ((last - closes[idx]) / closes[idx]) * 100;
          });
        }
      }
      if (!changes) throw new Error("no kline data");

      const parseRatio = async (settled) => {
        if (settled.status !== "fulfilled" || !settled.value.ok) return null;
        const arr = await settled.value.json();
        if (!Array.isArray(arr) || arr.length === 0) return null;
        const d = arr[arr.length - 1];
        return {
          longAccount: parseFloat(d.longAccount ?? d.longPosition ?? d.longShortRatio),
          shortAccount: parseFloat(d.shortAccount ?? d.shortPosition),
          ratio: parseFloat(d.longShortRatio),
        };
      };
      const [global, topPos, topAcct] = await Promise.all([
        parseRatio(globalRatioRes),
        parseRatio(topPosRatioRes),
        parseRatio(topAcctRatioRes),
      ]);

      setDetailData((d) => ({
        ...d,
        [symbol]: { changes, ratios: { global, topPos, topAcct }, updatedAt: Date.now(), loading: false },
      }));
    } catch {
      setDetailData((d) => ({ ...d, [symbol]: { ...(d[symbol] || {}), loading: false, failed: true } }));
    }
  }, []);

  useEffect(() => {
    if (monitored.length === 0) return;
    monitored.forEach((sym) => fetchDetail(sym));
    const id = setInterval(() => monitored.forEach((sym) => fetchDetail(sym)), 60000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitoredKey]);

  // ---- derived table rows ----
  const enriched = useMemo(() => {
    return rows.map((r) => {
      const priceNum = parseFloat(r.lastPrice);
      const athAtl = athAtlMap[r.symbol];
      // If the live price has already pushed past the cached extreme, the
      // live price IS the new extreme — don't wait for the next background
      // refresh to reflect that, since a background job only touches each
      // symbol occasionally.
      const effectiveAth = athAtl?.ath != null ? Math.max(athAtl.ath, priceNum) : null;
      const effectiveAtl = athAtl?.atl != null ? Math.min(athAtl.atl, priceNum) : null;
      const distFromAth = effectiveAth ? ((priceNum - effectiveAth) / effectiveAth) * 100 : null;
      const distFromAtl = effectiveAtl ? ((priceNum - effectiveAtl) / effectiveAtl) * 100 : null;
      return {
        ...r,
        lastPriceNum: priceNum,
        change24h: parseFloat(r.priceChangePercent),
        quoteVolumeNum: parseFloat(r.quoteVolume),
        change5m: changeFromBuffer(r.symbol, 5),
        change15m: changeFromBuffer(r.symbol, 15),
        change30m: changeFromBuffer(r.symbol, 30),
        change1h: changeFromBuffer(r.symbol, 60),
        change2h: extChangeMap[r.symbol]?.["120"] ?? null,
        change4h: extChangeMap[r.symbol]?.["240"] ?? null,
        change8h: extChangeMap[r.symbol]?.["480"] ?? null,
        change12h: extChangeMap[r.symbol]?.["720"] ?? null,
        fundingRate: funding[r.symbol]?.rate,
        tracked: watchlist.includes(r.symbol),
        ath: effectiveAth,
        atl: effectiveAtl,
        distFromAth,
        distFromAtl,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, funding, watchlist, lastUpdated, athAtlMap, extChangeMap]);

  const NEAR_THRESHOLD_PCT = 5;

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    let list = enriched;
    if (q) list = list.filter((r) => r.symbol.includes(q));
    if (watchOnly) list = list.filter((r) => r.tracked);
    if (athFilterMode === "ath") {
      list = list.filter((r) => r.distFromAth !== null && r.distFromAth >= -NEAR_THRESHOLD_PCT);
    } else if (athFilterMode === "atl") {
      list = list.filter((r) => r.distFromAtl !== null && r.distFromAtl <= NEAR_THRESHOLD_PCT);
    }
    list = [...list].sort((a, b) => {
      if (sortKey === "symbol") {
        return sortDir === "asc"
          ? a.symbol < b.symbol
            ? -1
            : 1
          : a.symbol > b.symbol
          ? -1
          : 1;
      }
      let av = a[sortKey];
      let bv = b[sortKey];
      if (av === null || av === undefined || isNaN(av)) av = -Infinity;
      if (bv === null || bv === undefined || isNaN(bv)) bv = -Infinity;
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return list;
  }, [enriched, query, watchOnly, sortKey, sortDir]);

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
    if ((key === "ath" || key === "atl") && athAtlBulkStatus === "idle") startAthAtlBulk();
    if (["change2h", "change4h", "change8h", "change12h"].includes(key) && extChangeBulkStatus === "idle") startExtChangeBulk();
  };
  const toggleWatch = (symbol) => {
    setWatchlist((w) => (w.includes(symbol) ? w.filter((s) => s !== symbol) : [...w, symbol]));
  };
  const requestNotifPermission = async () => {
    if (typeof Notification === "undefined") return;
    try {
      const p = await Notification.requestPermission();
      setNotifPerm(p);
    } catch {
      setNotifPerm("denied");
    }
  };
  const addCustomAlert = () => {
    const sym = newAlertForm.symbol.trim().toUpperCase();
    if (!sym) return;
    const symbolFull = sym.endsWith("USDT") ? sym : sym + "USDT";
    const exists = rows.some((r) => r.symbol === symbolFull);
    if (!exists) return;
    setCustomAlerts((prev) => [
      ...prev,
      {
        id: symbolFull + "-" + Date.now(),
        symbol: symbolFull,
        min: Number(newAlertForm.min),
        pct: Number(newAlertForm.pct),
        dir: newAlertForm.dir,
      },
    ]);
    setNewAlertForm({ symbol: "", min: 60, pct: 5, dir: "either" });
  };
  const removeCustomAlert = (id) => setCustomAlerts((prev) => prev.filter((a) => a.id !== id));

  const th = (col, label) => (
    <th
      key={col}
      onClick={() => toggleSort(col)}
      style={{
        position: "sticky",
        top: 0,
        background: C.panelAlt,
        textAlign: col === "symbol" ? "left" : "right",
        padding: "9px 12px",
        cursor: "pointer",
        userSelect: "none",
        color: sortKey === col ? C.amber : C.textMuted,
        fontWeight: 500,
        fontSize: 11,
        borderBottom: `1px solid ${C.border}`,
        whiteSpace: "nowrap",
      }}
    >
      {label}
      {sortKey === col && <span style={{ marginLeft: 4 }}>{sortDir === "asc" ? "↑" : "↓"}</span>}
    </th>
  );

  return (
    <div
      style={{
        background: C.bg,
        color: C.text,
        fontFamily: sans,
        minHeight: "100%",
        width: "100%",
        boxSizing: "border-box",
        padding: "18px 14px",
      }}
    >
      <style>{`
        .ft-input::placeholder { color: ${C.textDim}; }
        .ft-row:hover { background: ${C.panelAlt}; }
        .ft-scroll::-webkit-scrollbar { height: 8px; width: 8px; }
        .ft-scroll::-webkit-scrollbar-thumb { background: ${C.borderLight}; border-radius: 4px; }
        .ft-btn { cursor: pointer; }
        .ft-tab { cursor: pointer; }
        select, input { font-family: ${mono}; }
      `}</style>

      <div style={{ maxWidth: 1000, margin: "0 auto" }}>
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 10,
            marginBottom: 14,
            position: "relative",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <h1 style={{ margin: 0, fontSize: 19, fontWeight: 600, letterSpacing: "-0.01em" }}>
              Futures tracker
            </h1>
            <span style={{ fontSize: 12, color: C.textMuted }}>Binance · all USDT-M pairs</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: C.textMuted, fontFamily: mono }}>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: status === "live" ? C.gain : status === "error" ? C.loss : C.amber,
                display: "inline-block",
                boxShadow: status === "live" ? `0 0 6px ${C.gain}` : "none",
              }}
            />
            {status === "live" && lastUpdated
              ? `updated ${lastUpdated.toLocaleTimeString()}`
              : status === "error"
              ? "connection error"
              : "connecting…"}
            <button
              onClick={() => setShowSettings((s) => !s)}
              className="ft-btn"
              aria-label="Settings"
              style={{
                background: "transparent",
                border: `1px solid ${C.border}`,
                color: C.textMuted,
                borderRadius: 6,
                width: 26,
                height: 26,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 13,
                marginLeft: 4,
              }}
            >
              ⚙
            </button>
          </div>
          {showSettings && (
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                right: 0,
                zIndex: 40,
                background: C.panel,
                border: `1px solid ${C.border}`,
                borderRadius: 8,
                padding: 12,
                width: 180,
                maxWidth: "calc(100vw - 28px)",
                boxSizing: "border-box",
                boxShadow: C.shadow,
              }}
            >
              <div style={{ fontSize: 10.5, color: C.textDim, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Settings
              </div>
              <div style={{ fontSize: 12, color: C.text, marginBottom: 6 }}>Theme</div>
              <div style={{ display: "flex", gap: 6 }}>
                {["dark", "light"].map((m) => (
                  <button
                    key={m}
                    onClick={() => changeTheme(m)}
                    className="ft-btn"
                    style={{
                      flex: 1,
                      background: themeMode === m ? C.amber : C.panelAlt,
                      color: themeMode === m ? "#1A1300" : C.textMuted,
                      border: `1px solid ${themeMode === m ? C.amber : C.border}`,
                      borderRadius: 6,
                      padding: "6px 0",
                      fontSize: 11.5,
                      fontWeight: 600,
                      textTransform: "capitalize",
                    }}
                  >
                    {m}
                      </button>
                    ))}
                  </div>
                </div>
              )}
        </div>

        {booting && (
          <div
            style={{
              fontSize: 11.5,
              color: C.textMuted,
              marginBottom: 12,
              fontFamily: mono,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <div style={{ flex: 1, height: 3, background: C.border, borderRadius: 2, overflow: "hidden" }}>
              <div style={{ width: `${bootProgress}%`, height: "100%", background: C.amber, transition: "width .2s" }} />
            </div>
            warming up short-term history ({bootProgress}%) — 5m/15m/30m/1h alerts fully active once complete
          </div>
        )}

        {status === "error" && (
          <div
            style={{
              background: C.panel,
              border: `1px solid ${C.loss}`,
              borderRadius: 8,
              padding: "11px 13px",
              fontSize: 13,
              color: C.loss,
              marginBottom: 12,
            }}
          >
            {/418|429/.test(errorMsg) ? (
              <>
                Binance has temporarily rate-limited this IP (too many requests at once) — not a connection problem. All
                requests are paused app-wide and will resume automatically{binanceBlockedSecondsLeft() > 0 ? ` in about ${binanceBlockedSecondsLeft()}s` : " shortly"}.
              </>
            ) : (
              <>Couldn't reach Binance's futures API ({errorMsg}). Retrying every 8s.</>
            )}
          </div>
        )}

        {/* Tabs */}
        <div style={{ display: "flex", gap: 4, marginBottom: 14, borderBottom: `1px solid ${C.border}` }}>
          {["market", "analyze", "trades", "screener", "alerts"].map((t) => (
            <div
              key={t}
              className="ft-tab"
              onClick={() => setTab(t)}
              style={{
                padding: "8px 14px",
                fontSize: 13,
                fontWeight: 600,
                color: tab === t ? C.text : C.textMuted,
                borderBottom: tab === t ? `2px solid ${C.amber}` : "2px solid transparent",
                marginBottom: -1,
                textTransform: "capitalize",
              }}
            >
              {t === "alerts" && triggered.length > 0
                ? `Alerts · ${triggered.length}`
                : t === "trades" && savedTrades.length > 0
                ? `Trades · ${savedTrades.length}`
                : t}
            </div>
          ))}
        </div>

        {tab === "market" && (
          <>
            <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
              <input
                className="ft-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search pair, e.g. BTC, SOL…"
                style={{
                  flex: 1,
                  minWidth: 180,
                  boxSizing: "border-box",
                  background: C.panel,
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  color: C.text,
                  fontSize: 13,
                  padding: "9px 12px",
                  outline: "none",
                }}
              />
              <button
                className="ft-btn"
                onClick={() => setWatchOnly((w) => !w)}
                style={{
                  background: watchOnly ? C.amber : C.panel,
                  color: watchOnly ? "#1A1300" : C.textMuted,
                  border: `1px solid ${watchOnly ? C.amber : C.border}`,
                  borderRadius: 8,
                  padding: "9px 14px",
                  fontSize: 12.5,
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}
              >
                ★ Watchlist ({watchlist.length})
              </button>
              <button
                className="ft-btn"
                onClick={() => toggleAthFilter("atl")}
                style={{
                  background: athFilterMode === "atl" ? C.loss : C.panel,
                  color: athFilterMode === "atl" ? "#2A0A10" : C.textMuted,
                  border: `1px solid ${athFilterMode === "atl" ? C.loss : C.border}`,
                  borderRadius: 8,
                  padding: "9px 14px",
                  fontSize: 12.5,
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}
              >
                Near ATL
              </button>
              <button
                className="ft-btn"
                onClick={() => toggleAthFilter("ath")}
                style={{
                  background: athFilterMode === "ath" ? C.gain : C.panel,
                  color: athFilterMode === "ath" ? "#06231A" : C.textMuted,
                  border: `1px solid ${athFilterMode === "ath" ? C.gain : C.border}`,
                  borderRadius: 8,
                  padding: "9px 14px",
                  fontSize: 12.5,
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}
              >
                Near ATH
              </button>
            </div>

            {(athFilterMode !== "none" || athAtlBulkStatus === "loading" || athAtlBulkStatus === "blocked") && (
              <div style={{ fontSize: 11, color: athAtlBulkStatus === "blocked" ? C.loss : C.textMuted, marginBottom: 6, fontFamily: mono }}>
                {athFilterMode !== "none" ? (
                  <>Showing pairs within {NEAR_THRESHOLD_PCT}% of their {athFilterMode === "ath" ? "All-Time High" : "All-Time Low"}</>
                ) : (
                  <>All-Time High/Low columns filling in automatically</>
                )}
                {athAtlBulkStatus === "loading" && ` · ${athAtlBulkDone}/${rows.length} done (paced to stay within Binance's limits)`}
                {athAtlBulkStatus === "done" && " · complete"}
                {athAtlBulkStatus === "blocked" &&
                  " · paused — Binance rate-limited this IP, will resume automatically once it clears"}
              </div>
            )}
            {(extChangeBulkStatus === "loading" || extChangeBulkStatus === "blocked") && (
              <div style={{ fontSize: 11, color: extChangeBulkStatus === "blocked" ? C.loss : C.textMuted, marginBottom: 10, fontFamily: mono }}>
                2h/4h/8h/12h columns filling in
                {extChangeBulkStatus === "loading" && ` · ${extChangeBulkDone}/${rows.length} done`}
                {extChangeBulkStatus === "blocked" && " · paused — rate-limited, will resume automatically"}
              </div>
            )}

            <div className="ft-scroll" style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "auto", background: C.panel }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 760 }}>
                <thead>
                  <tr>
                    <th style={{ position: "sticky", top: 0, background: C.panelAlt, padding: "9px 8px", borderBottom: `1px solid ${C.border}` }}></th>
                    {th("symbol", "Pair")}
                    {th("lastPriceNum", "Price")}
                    {th("quoteVolumeNum", "24h Vol")}
                    {th("change5m", "5m")}
                    {th("change15m", "15m")}
                    {th("change30m", "30m")}
                    {th("change1h", "1h")}
                    {th("change2h", "2h")}
                    {th("change4h", "4h")}
                    {th("change8h", "8h")}
                    {th("change12h", "12h")}
                    {th("change24h", "24h")}
                    {th("fundingRate", "Funding")}
                    {th("atl", "ATL")}
                    {th("ath", "ATH")}
                    <th style={{ position: "sticky", top: 0, background: C.panelAlt, padding: "9px 8px", borderBottom: `1px solid ${C.border}` }}></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 && status === "live" && (
                    <tr>
                      <td colSpan={17} style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
                        {athFilterMode !== "none"
                          ? `No pairs currently within ${NEAR_THRESHOLD_PCT}% of their ${athFilterMode === "ath" ? "All-Time High" : "All-Time Low"}${athAtlBulkStatus === "loading" ? " yet — still computing…" : "."}`
                          : watchOnly
                          ? "No pairs on your watchlist yet."
                          : `No pairs match "${query}".`}
                      </td>
                    </tr>
                  )}
                  {filtered.map((r) => (
                    <RowGroup
                      key={r.symbol}
                      r={r}
                      expanded={expanded === r.symbol}
                      onToggleExpand={() => setExpanded(expanded === r.symbol ? null : r.symbol)}
                      onToggleWatch={() => toggleWatch(r.symbol)}
                      detail={detailData[r.symbol]}
                      logos={coinLogos}
                      customAlertsForSymbol={customAlerts.filter((a) => a.symbol === r.symbol)}
                      onRemoveAlert={removeCustomAlert}
                      onQuickAddAlert={(min, pct, dir) =>
                        setCustomAlerts((prev) => [
                          ...prev,
                          { id: r.symbol + "-" + Date.now(), symbol: r.symbol, min, pct, dir },
                        ])
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: C.textDim, display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
              <span>{filtered.length} of {rows.length || "…"} pairs</span>
              <span>Tap a row to see the full interval breakdown · funding refreshes every 30s</span>
            </div>
          </>
        )}

        {tab === "analyze" && (
          <AnalyzeTab
            rows={rows}
            funding={funding}
            detailData={detailData}
            changeFromBuffer={changeFromBuffer}
            analyzeSymbol={analyzeSymbol}
            setAnalyzeSymbol={setAnalyzeSymbol}
            savedTrades={savedTrades}
            setSavedTrades={setSavedTrades}
            logos={coinLogos}
            goToTrades={() => setTab("trades")}
          />
        )}

        {tab === "trades" && (
          <TradesTab
            rows={rows}
            funding={funding}
            logos={coinLogos}
            savedTrades={savedTrades}
            setSavedTrades={setSavedTrades}
            goToAnalyze={() => setTab("analyze")}
          />
        )}

        {tab === "screener" && (
          <ScreenerPanel
            rows={rows}
            taMap={taMap}
            taBulkStatus={taBulkStatus}
            taBulkDone={taBulkDone}
            startTaBulk={startTaBulk}
            serverMode={isBackgroundAlertsConfigured()}
            taSyncedAt={taSyncedAt}
            taServerCount={taServerCount}
            screenerAthAtl={screenerAthAtl}
            scanScreenerAthAtl={scanScreenerAthAtl}
            athAtlMap={athAtlMap}
            athAtlBulkStatus={athAtlBulkStatus}
            startAthAtlBulk={startAthAtlBulk}
            logos={coinLogos}
          />
        )}

        {tab === "alerts" && (
          <AlertsPanel
            rulesEnabled={rulesEnabled}
            setRulesEnabled={setRulesEnabled}
            globalRulesMasterOn={globalRulesMasterOn}
            setGlobalRulesMasterOn={setGlobalRulesMasterOn}
            otherAlertsMasterOn={otherAlertsMasterOn}
            setOtherAlertsMasterOn={setOtherAlertsMasterOn}
            defaultRulePcts={defaultRulePcts}
            setDefaultRulePcts={setDefaultRulePcts}
            customAlerts={customAlerts}
            removeCustomAlert={removeCustomAlert}
            globalAlerts={globalAlerts}
            setGlobalAlerts={setGlobalAlerts}
            newGlobalAlertForm={newGlobalAlertForm}
            setNewGlobalAlertForm={setNewGlobalAlertForm}
            newAlertForm={newAlertForm}
            setNewAlertForm={setNewAlertForm}
            addCustomAlert={addCustomAlert}
            triggered={triggered}
            notifPerm={notifPerm}
            requestNotifPermission={requestNotifPermission}
            bgAlertsStatus={bgAlertsStatus}
            enableBackgroundAlerts={enableBackgroundAlerts}
            disableBackgroundAlerts={disableBackgroundAlerts}
            symbols={rows.map((r) => r.symbol)}
            rows={rows}
            logos={coinLogos}
          />
        )}
      </div>
    </div>
  );
}

function RowGroup({ r, expanded, onToggleExpand, onToggleWatch, detail, customAlertsForSymbol, onRemoveAlert, onQuickAddAlert, logos }) {
  return (
    <>
      <tr className="ft-row" style={{ borderBottom: `1px solid ${C.border}` }}>
        <td style={{ padding: "8px 8px", textAlign: "center" }}>
          <span onClick={onToggleWatch} className="ft-btn" style={{ color: r.tracked ? C.amber : C.textDim, fontSize: 15 }}>
            {r.tracked ? "★" : "☆"}
          </span>
        </td>
        <td onClick={onToggleExpand} className="ft-btn" style={{ padding: "8px 12px", fontFamily: mono, fontWeight: 600, whiteSpace: "nowrap" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
            <CoinIcon symbol={r.symbol} logos={logos} />
            {r.symbol.replace("USDT", "")}
            <span style={{ color: C.textDim, fontWeight: 400 }}>/USDT</span>
          </span>
        </td>
        <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: mono }}>{fmtPrice(r.lastPriceNum)}</td>
        <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: mono, color: C.textMuted }}>{fmtCompact(r.quoteVolumeNum)}</td>
        <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: mono, color: pctColor(r.change5m) }}>{fmtPct(r.change5m)}</td>
        <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: mono, color: pctColor(r.change15m) }}>{fmtPct(r.change15m)}</td>
        <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: mono, color: pctColor(r.change30m) }}>{fmtPct(r.change30m)}</td>
        <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: mono, color: pctColor(r.change1h) }}>{fmtPct(r.change1h)}</td>
        <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: mono, color: pctColor(r.change2h) }}>{fmtPct(r.change2h)}</td>
        <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: mono, color: pctColor(r.change4h) }}>{fmtPct(r.change4h)}</td>
        <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: mono, color: pctColor(r.change8h) }}>{fmtPct(r.change8h)}</td>
        <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: mono, color: pctColor(r.change12h) }}>{fmtPct(r.change12h)}</td>
        <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: mono, color: pctColor(r.change24h), fontWeight: 600 }}>{fmtPct(r.change24h)}</td>
        <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: mono, color: C.textMuted }}>
          {r.fundingRate !== undefined ? (r.fundingRate * 100).toFixed(4) + "%" : "—"}
        </td>
        <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: mono, color: C.loss }}>
          {r.atl !== null ? fmtPrice(r.atl) : "…"}
        </td>
        <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: mono, color: C.gain }}>
          {r.ath !== null ? fmtPrice(r.ath) : "…"}
        </td>
        <td onClick={onToggleExpand} className="ft-btn" style={{ padding: "8px 8px", textAlign: "center", color: C.textMuted }}>
          {expanded ? "▲" : "▼"}
        </td>
      </tr>
      {expanded && (
        <tr style={{ borderBottom: `1px solid ${C.border}`, background: C.panelAlt }}>
          <td colSpan={17} style={{ padding: "12px 16px" }}>
            {!detail || (detail.loading && !detail.changes) ? (
              <div style={{ fontSize: 12, color: C.textMuted, fontFamily: mono }}>loading full history…</div>
            ) : detail.failed ? (
              <div style={{ fontSize: 12, color: C.loss }}>couldn't load extended history for this pair.</div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(64px, 1fr))", gap: 8, marginBottom: 10 }}>
                {INTERVALS.map((iv) => (
                  <div key={iv.min} style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 10, color: C.textDim, marginBottom: 2, fontFamily: mono }}>{iv.label}</div>
                    <div style={{ fontSize: 12, fontFamily: mono, fontWeight: 600, color: pctColor(detail.changes?.[iv.min]) }}>
                      {fmtPct(detail.changes?.[iv.min])}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {detail && detail.ratios && <PositioningPanel ratios={detail.ratios} />}
            <QuickAlert symbol={r.symbol} existing={customAlertsForSymbol} onAdd={onQuickAddAlert} onRemove={onRemoveAlert} />
          </td>
        </tr>
      )}
    </>
  );
}

function RatioBar({ label, longPct, shortPct }) {
  if (longPct === null || longPct === undefined || isNaN(longPct)) {
    return (
      <div style={{ fontSize: 11, color: C.textDim, marginBottom: 8 }}>
        {label}: <span>—</span>
      </div>
    );
  }
  const longW = Math.max(2, Math.min(98, longPct));
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: C.textMuted, marginBottom: 3 }}>
        <span>{label}</span>
        <span style={{ fontFamily: mono }}>
          <span style={{ color: C.gain }}>{longPct.toFixed(1)}% long</span> ·{" "}
          <span style={{ color: C.loss }}>{shortPct.toFixed(1)}% short</span>
        </span>
      </div>
      <div style={{ height: 6, borderRadius: 3, overflow: "hidden", display: "flex", background: C.border }}>
        <div style={{ width: `${longW}%`, background: C.gain }} />
        <div style={{ width: `${100 - longW}%`, background: C.loss }} />
      </div>
    </div>
  );
}

function PositioningPanel({ ratios }) {
  const toPcts = (r) => {
    if (!r || r.longAccount === undefined || isNaN(r.longAccount)) return { long: null, short: null };
    // Binance returns these as fractions (e.g. 0.65); normalize to 0-100
    const sum = r.longAccount + r.shortAccount;
    if (!sum || isNaN(sum)) return { long: null, short: null };
    return { long: (r.longAccount / sum) * 100, short: (r.shortAccount / sum) * 100 };
  };
  const g = toPcts(ratios.global);
  const tp = toPcts(ratios.topPos);
  const ta = toPcts(ratios.topAcct);
  const anyData = g.long !== null || tp.long !== null || ta.long !== null;
  return (
    <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 10, marginTop: 4, marginBottom: 4 }}>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8 }}>Positioning (Binance, 15m)</div>
      {anyData ? (
        <>
          <RatioBar label="All accounts" longPct={g.long} shortPct={g.short} />
          <RatioBar label="Top traders · by position size" longPct={tp.long} shortPct={tp.short} />
          <RatioBar label="Top traders · by account count" longPct={ta.long} shortPct={ta.short} />
        </>
      ) : (
        <div style={{ fontSize: 11.5, color: C.textDim }}>Positioning data unavailable for this pair right now.</div>
      )}
      <div style={{ fontSize: 10.5, color: C.textDim, marginTop: 4 }}>
        This is Binance's own long/short account data — not whale-level dollar positions or PnL, which aren't published by any free API.
      </div>
    </div>
  );
}

function QuickAlert({ symbol, existing, onAdd, onRemove }) {
  const [min, setMin] = useState(60);
  const [pct, setPct] = useState(5);
  const [dir, setDir] = useState("either");
  return (
    <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 6 }}>Alerts for {symbol.replace("USDT", "/USDT")}</div>
      {existing.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {existing.map((a) => (
            <span
              key={a.id}
              style={{
                fontSize: 11,
                fontFamily: mono,
                background: C.panel,
                border: `1px solid ${C.border}`,
                borderRadius: 6,
                padding: "3px 8px",
                color: C.text,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              ±{a.pct}% / {INTERVALS.find((i) => i.min === a.min)?.label || a.min + "m"} ({a.dir})
              <span onClick={() => onRemove(a.id)} className="ft-btn" style={{ color: C.loss }}>
                ×
              </span>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <select value={min} onChange={(e) => setMin(Number(e.target.value))} style={selStyle()}>
          {INTERVALS.map((iv) => (
            <option key={iv.min} value={iv.min}>
              {iv.label}
            </option>
          ))}
        </select>
        <input type="number" value={pct} onChange={(e) => setPct(e.target.value)} style={{ ...selStyle(), width: 56 }} />
        <span style={{ fontSize: 11, color: C.textMuted }}>%</span>
        <select value={dir} onChange={(e) => setDir(e.target.value)} style={selStyle()}>
          <option value="either">either dir.</option>
          <option value="up">up only</option>
          <option value="down">down only</option>
        </select>
        <button
          className="ft-btn"
          onClick={() => onAdd(min, Number(pct), dir)}
          style={{ background: C.amber, color: "#1A1300", border: "none", borderRadius: 6, padding: "5px 12px", fontSize: 11.5, fontWeight: 700 }}
        >
          + Add alert
        </button>
      </div>
    </div>
  );
}

// A function, not a static object — selStyle bakes in C's colors at
// whatever moment it's called, so it stays correct across theme toggles
// (a plain module-level object would freeze the colors from first load).
function selStyle() {
  return {
    background: C.panel,
    border: `1px solid ${C.border}`,
    color: C.text,
    borderRadius: 6,
    padding: "5px 8px",
    fontSize: 11.5,
  };
}

function computeRisk({ direction, entry, sizeUsdt, current, change5m, change30m, change1h, change4h, quoteVolume24h, fundingRate, positioning }) {
  const factors = [];
  let score = 50;

  // liquidity: size vs 24h volume
  if (quoteVolume24h > 0) {
    const liqPct = (sizeUsdt / quoteVolume24h) * 100;
    if (liqPct > 1) {
      score += 20;
      factors.push({ text: `Position is ${liqPct.toFixed(2)}% of this pair's 24h volume — large relative to liquidity, expect slippage.`, bad: true });
    } else if (liqPct > 0.2) {
      score += 8;
      factors.push({ text: `Position is ${liqPct.toFixed(2)}% of 24h volume — noticeable but not extreme.`, bad: true });
    } else {
      factors.push({ text: `Position is a small share (${liqPct.toFixed(3)}%) of 24h volume — liquidity isn't a concern.`, bad: false });
    }
  }

  // recent volatility
  const vol1h = change1h !== null && isFinite(change1h) ? Math.abs(change1h) : null;
  const vol4h = change4h !== null && isFinite(change4h) ? Math.abs(change4h) : null;
  if (vol1h !== null && vol1h > 5) {
    score += 15;
    factors.push({ text: `Moved ${vol1h.toFixed(1)}% in the last hour — currently volatile.`, bad: true });
  } else if (vol4h !== null && vol4h > 8) {
    score += 8;
    factors.push({ text: `Moved ${vol4h.toFixed(1)}% over 4h — above-average swings recently.`, bad: true });
  } else {
    factors.push({ text: "No unusual short-term volatility right now.", bad: false });
  }

  // momentum alignment
  const mom = change30m !== null && isFinite(change30m) ? change30m : change5m;
  if (mom !== null && isFinite(mom)) {
    const against = direction === "long" ? mom < -1 : mom > 1;
    if (against) {
      score += 15;
      factors.push({ text: `Short-term momentum (${fmtPct(mom)} / 30m) is running against a ${direction} — going against the immediate trend.`, bad: true });
    } else {
      factors.push({ text: `Short-term momentum (${fmtPct(mom)} / 30m) isn't working against this ${direction}.`, bad: false });
    }
  }

  // funding drag
  if (fundingRate !== undefined && fundingRate !== null && isFinite(fundingRate)) {
    const fPct = fundingRate * 100;
    if (direction === "long" && fPct > 0.03) {
      score += 10;
      factors.push({ text: `Funding is +${fPct.toFixed(4)}% — longs are paying shorts; holding costs add up over time.`, bad: true });
    } else if (direction === "short" && fPct < -0.03) {
      score += 10;
      factors.push({ text: `Funding is ${fPct.toFixed(4)}% — shorts are paying longs here.`, bad: true });
    } else {
      factors.push({ text: `Funding rate (${fPct.toFixed(4)}%) isn't a meaningful cost for this position right now.`, bad: false });
    }
  }

  // crowding
  if (positioning && positioning.global && positioning.global.long !== null && positioning.global.long !== undefined) {
    const longPct = positioning.global.long;
    if (direction === "long" && longPct > 68) {
      score += 12;
      factors.push({ text: `${longPct.toFixed(0)}% of accounts are already long — a crowded long raises squeeze/reversal risk.`, bad: true });
    } else if (direction === "short" && longPct < 32) {
      score += 12;
      factors.push({ text: `Only ${longPct.toFixed(0)}% of accounts are long (i.e. crowded short) — raises short-squeeze risk.`, bad: true });
    } else {
      factors.push({ text: "Positioning isn't heavily crowded against this side.", bad: false });
    }
  }

  score = Math.max(0, Math.min(100, score));
  let label, color;
  if (score < 35) {
    label = "Low caution";
    color = C.gain;
  } else if (score < 55) {
    label = "Moderate caution";
    color = C.amber;
  } else if (score < 75) {
    label = "Elevated caution";
    color = "#FF8A3D";
  } else {
    label = "High caution";
    color = C.loss;
  }
  return { score, label, color, factors };
}

// Self-contained fetch for the Analyze tab — independent of the table's monitored/detail
// pipeline so it doesn't wait on that timing and can show its own loading/error state.
function fmtDate(ms) {
  if (!ms) return "—";
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

// Binance USDT-M futures launched ~Sept 2019 — used as the earliest possible
// start point when no cached ATH/ATL exists yet for a symbol. Binance simply
// returns whatever real candles exist from a given symbol's actual listing
// date onward, so requesting from before that date is safe.
const FUTURES_LAUNCH_MS = Date.UTC(2019, 8, 1);
const ATH_ATL_STEP_MS = { "1d": 86400000, "1h": 3600000 };

// Full-history ATH/ATL scan, paginating Binance klines from the last known
// point (or launch, on first run for a symbol) up to now. Mirrors the same
// pagination/merge logic as the standalone Python version of this tool.
async function fetchTrueAthAtl(symbol, interval, cached, onProgress) {
  const stepMs = ATH_ATL_STEP_MS[interval];
  const now = Date.now();
  let ath = null, athTime = null, atl = null, atlTime = null, firstCandleTime = null, total = 0;
  let highClose = null, highCloseTime = null, lowClose = null, lowCloseTime = null;

  if (cached && cached.interval === interval) {
    ath = cached.ath;
    athTime = cached.athTime;
    atl = cached.atl;
    atlTime = cached.atlTime;
    firstCandleTime = cached.firstCandleTime;
    total = cached.totalCandles || 0;
    highClose = cached.highClose ?? null;
    highCloseTime = cached.highCloseTime ?? null;
    lowClose = cached.lowClose ?? null;
    lowCloseTime = cached.lowCloseTime ?? null;
  }

  let cur = cached && cached.interval === interval ? cached.lastUpdated + stepMs : FUTURES_LAUNCH_MS;
  let lastCandleTime = cached?.lastUpdated || null;
  let batch = 0;

  while (cur < now) {
    batch += 1;
    // limit=1000 keeps this at Binance's weight-5 tier instead of weight-10 —
    // costs a couple of extra batches for very old pairs, but roughly halves
    // the request weight everywhere this function is used (Analyze and the
    // market-wide bulk pass both call this).
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${cur}&endTime=${now}&limit=1000`;
    const res = await fapiFetch(url);
    if (!res.ok) throw new Error(`Binance request failed (HTTP ${res.status}) on batch ${batch}`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;

    if (firstCandleTime === null) firstCandleTime = data[0][0];
    data.forEach((k) => {
      const openTime = k[0];
      const high = parseFloat(k[2]);
      const low = parseFloat(k[3]);
      const close = parseFloat(k[4]);
      if (ath === null || high > ath) {
        ath = high;
        athTime = openTime;
      }
      if (atl === null || low < atl) {
        atl = low;
        atlTime = openTime;
      }
      if (highClose === null || close > highClose) {
        highClose = close;
        highCloseTime = openTime;
      }
      if (lowClose === null || close < lowClose) {
        lowClose = close;
        lowCloseTime = openTime;
      }
    });
    total += data.length;
    lastCandleTime = data[data.length - 1][0];
    if (onProgress) onProgress({ batch, totalSoFar: total });

    const nextStart = lastCandleTime + stepMs;
    if (nextStart <= cur) break; // safety valve, never allow a stall/loop
    cur = nextStart;
    if (data.length < 1000) break; // short batch = reached most recent candle
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 250)); // gentle pacing between batches
  }

  return {
    ath, athTime, atl, atlTime, firstCandleTime,
    highClose, highCloseTime, lowClose, lowCloseTime,
    totalCandles: total,
    lastUpdated: lastCandleTime || now,
  };
}

// 2h/4h/8h/12h % change for the market table's extra columns. One cheap
// request per symbol (150 5-minute candles = 12.5h of coverage, well under
// Binance's 500-candle weight-2 tier) — single request, no pagination needed.
async function fetchExtChanges(symbol) {
  const res = await fapiFetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=150`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length < 2) throw new Error("no data");
  const closes = data.map((k) => parseFloat(k[4]));
  const last = closes[closes.length - 1];
  const out = {};
  [120, 240, 480, 720].forEach((min) => {
    const idx = closes.length - 1 - min / 5;
    if (idx >= 0) out[min] = ((last - closes[idx]) / closes[idx]) * 100;
  });
  return out;
}

// ---- TA screener: pure indicator math over an array of closes/highs/lows ----
// All take plain arrays (oldest first) and return arrays/numbers aligned the
// same way standard charting libraries do, so the logic is easy to sanity
// check against any other TA tool.

function emaSeries(values, period) {
  if (!values || values.length === 0) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function rsiValue(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Wilder's ADX(14) — trend-strength regardless of direction. Computed over
// the full series (not just the tail) since +DI/-DI/DX need Wilder-smoothed
// running sums, then the ADX itself is a smoothed average of DX.
function adxValue(highs, lows, closes, period = 14) {
  const n = highs.length;
  if (n < period * 2) return null;
  const trs = [], plusDMs = [], minusDMs = [];
  for (let i = 1; i < n; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  const wilderSmooth = (arr) => {
    const out = [];
    let sum = arr.slice(0, period).reduce((a, b) => a + b, 0);
    out.push(sum);
    for (let i = period; i < arr.length; i++) {
      sum = sum - sum / period + arr[i];
      out.push(sum);
    }
    return out;
  };
  const trSm = wilderSmooth(trs);
  const plusSm = wilderSmooth(plusDMs);
  const minusSm = wilderSmooth(minusDMs);
  const dxs = [];
  for (let i = 0; i < trSm.length; i++) {
    if (trSm[i] === 0) continue;
    const plusDI = (100 * plusSm[i]) / trSm[i];
    const minusDI = (100 * minusSm[i]) / trSm[i];
    const sum = plusDI + minusDI;
    dxs.push(sum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / sum);
  }
  if (dxs.length < period) return dxs.length ? dxs[dxs.length - 1] : null;
  const firstAdx = dxs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let adx = firstAdx;
  for (let i = period; i < dxs.length; i++) {
    adx = (adx * (period - 1) + dxs[i]) / period;
  }
  return adx;
}

// Nearest recent swing high / low over a lookback window — a simple, robust
// stand-in for "possible support/resistance" that works the same way across
// every pair without needing per-symbol tuning.
function swingLevels(highs, lows, lookback = 60) {
  const h = highs.slice(-lookback);
  const l = lows.slice(-lookback);
  return { resistance: h.length ? Math.max(...h) : null, support: l.length ? Math.min(...l) : null };
}

// Pulls 4h candles (plenty of history in one weight-5 request) and derives
// the full screener row for one symbol: trend direction, trend strength,
// momentum, nearby support/resistance, and a simple reversal flag.
async function fetchTAForSymbol(symbol) {
  const res = await fapiFetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=150`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length < 60) throw new Error("not enough history");

  const highs = data.map((k) => parseFloat(k[2]));
  const lows = data.map((k) => parseFloat(k[3]));
  const closes = data.map((k) => parseFloat(k[4]));
  return {
    ...computeTaFromCandles(highs, lows, closes),
    price: closes[closes.length - 1],
    updatedAt: Date.now(),
  };
}

async function fetchAnalysisExtras(symbol) {
  const base = symbol.replace("USDT", ""); // e.g. BTC
  const okxInstId = `${base}-USDT-SWAP`;

  // Cross-exchange open interest / positioning only — the official Binance
  // ratio/taker/depth endpoints used to back the Smart Signal card were
  // dropped along with that card, saving those extra weighted requests.
  const [multiExSettled] = await Promise.allSettled([
    Promise.all([
      fapiFetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=${symbol}&period=15min&limit=1`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`https://www.okx.com/api/v5/public/open-interest?instId=${okxInstId}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${base}&period=5m`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]),
  ]);

  const pickLast = (arr) => (Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null);

  let multiExchange = { binance: null, bybit: null, okx: null };
  if (multiExSettled.status === "fulfilled") {
    const [binOi, bybitTicker, bybitRatio, okxOi, okxRatio] = multiExSettled.value;

    multiExchange.binance = binOi ? { oi: parseFloat(binOi.openInterest) } : null;

    const bybitRow = bybitTicker?.result?.list?.[0];
    const bybitRatioRow = pickLast(bybitRatio?.result?.list);
    multiExchange.bybit = bybitRow
      ? {
          oi: parseFloat(bybitRow.openInterest),
          fundingRate: parseFloat(bybitRow.fundingRate),
          longPct: bybitRatioRow ? parseFloat(bybitRatioRow.buyRatio) * 100 : null,
        }
      : null;

    const okxOiRow = okxOi?.data?.[0];
    const okxRatioRow = pickLast(okxRatio?.data)?.[1];
    multiExchange.okx = okxOiRow
      ? {
          oi: parseFloat(okxOiRow.oi),
          longPct: okxRatioRow ? (parseFloat(okxRatioRow) / (1 + parseFloat(okxRatioRow))) * 100 : null,
        }
      : null;
  }

  return { multiExchange };
}

function FundingCountdown({ nextFundingTime }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!nextFundingTime) return <span>—</span>;
  let diff = Math.max(0, nextFundingTime - now);
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  return (
    <span>
      {String(h).padStart(2, "0")}:{String(m).padStart(2, "0")}:{String(s).padStart(2, "0")}
    </span>
  );
}

function MultiExchangePanel({ multiExchange }) {
  if (!multiExchange) return null;
  const rows = [
    { name: "Binance", d: multiExchange.binance },
    { name: "Bybit", d: multiExchange.bybit },
    { name: "OKX", d: multiExchange.okx },
  ];
  const anyData = rows.some((r) => r.d);
  if (!anyData) return null;
  return (
    <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 10, marginTop: 10 }}>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8 }}>Cross-exchange check (free public data — no Binance-only blind spot)</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map(({ name, d }) => (
          <div key={name} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontFamily: mono }}>
            <span style={{ color: C.textMuted }}>{name}</span>
            <span>
              {d && isFinite(d.oi) ? (
                <>
                  OI {fmtCompact(d.oi)}
                  {d.longPct !== null && d.longPct !== undefined && isFinite(d.longPct) ? (
                    <span style={{ marginLeft: 8 }}>
                      · <span style={{ color: C.gain }}>{d.longPct.toFixed(0)}% long</span>
                    </span>
                  ) : null}
                </>
              ) : (
                <span style={{ color: C.textDim }}>not listed / unavailable</span>
              )}
            </span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10.5, color: C.textDim, marginTop: 6 }}>
        Open interest (in contracts) and long-account share, pulled directly from each exchange's public API. This still isn't whale-wallet or trader-tier data — no free source publishes that.
      </div>
    </div>
  );
}

// Custom searchable dropdown — <datalist> doesn't render suggestions reliably on iOS Safari,
// so this is a plain React dropdown instead.
function SymbolPicker({ rows, logos, value, onChange, onSelect, placeholder }) {
  const [open, setOpen] = useState(false);
  const query = value.trim().toUpperCase();
  const matches = useMemo(() => {
    const list = query
      ? rows.filter((r) => r.symbol.replace("USDT", "").includes(query))
      : [...rows].sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
    return list.slice(0, 8);
  }, [rows, query]);

  return (
    <div style={{ position: "relative" }}>
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        style={{ ...selStyle(), padding: "9px 10px", width: "100%", boxSizing: "border-box" }}
      />
      {open && matches.length > 0 && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            zIndex: 30,
            background: C.panel,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            maxHeight: 260,
            overflowY: "auto",
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          }}
        >
          {matches.map((r) => (
            <div
              key={r.symbol}
              className="ft-row"
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(r.symbol);
                setOpen(false);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "9px 10px",
                cursor: "pointer",
                fontSize: 12.5,
                fontFamily: mono,
                borderBottom: `1px solid ${C.border}`,
              }}
            >
              <CoinIcon symbol={r.symbol} logos={logos} size={18} />
              <span style={{ fontWeight: 600 }}>{r.symbol.replace("USDT", "")}</span>
              <span style={{ color: C.textDim }}>/USDT</span>
              <span style={{ marginLeft: "auto", color: C.textMuted }}>{fmtPrice(parseFloat(r.lastPrice))}</span>
              <span style={{ color: pctColor(parseFloat(r.priceChangePercent)), minWidth: 52, textAlign: "right" }}>
                {fmtPct(parseFloat(r.priceChangePercent))}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Card({ title, right, children, style }) {
  return (
    <div
      style={{
        background: C.panel,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        padding: 16,
        marginBottom: 14,
        boxShadow: C.shadow,
        ...style,
      }}
    >
      {(title || right) && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 8 }}>
          {title && (
            <div style={{ fontSize: 11.5, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.04em" }}>
              {title}
            </div>
          )}
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 10.5, color: C.textDim, marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.03em" }}>{label}</div>
      {children}
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: C.textDim, marginBottom: 2 }}>{label}</div>
      <div style={{ fontFamily: mono, fontWeight: 700, fontSize: 17, color: color || C.text }}>{value}</div>
    </div>
  );
}

function marginRatioColor(pct) {
  if (pct === null || pct === undefined) return C.textDim;
  if (pct < 25) return C.gain;
  if (pct < 60) return C.amber;
  return C.loss;
}

function TrackedTradeRow({ t, row, funding, logos, onRemove, onAddRoiAlert, onRemoveRoiAlert, onAddPnlAlert, onRemovePnlAlert }) {
  const [athAtl, setAthAtl] = useState(null);
  const [loading, setLoading] = useState(false);
  const [athAtlInterval, setAthAtlInterval] = useState("1d");
  const [roiInput, setRoiInput] = useState("");
  const [pnlInput, setPnlInput] = useState("");
  const [ta, setTa] = useState(null);
  const [taLoading, setTaLoading] = useState(false);
  const [oi, setOi] = useState(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showRoiAlerts, setShowRoiAlerts] = useState(false);
  const [showPnlAlerts, setShowPnlAlerts] = useState(false);

  const cur = row ? parseFloat(row.lastPrice) : null;
  const sizeU = t.margin * t.leverage;
  const qty = t.entry ? sizeU / t.entry : 0;
  const positionValueNow = cur !== null ? qty * cur : null;
  const pnl = cur !== null ? (t.dir === "long" ? ((cur - t.entry) / t.entry) * sizeU : ((t.entry - cur) / t.entry) * sizeU) : null;
  const roi = pnl !== null ? (pnl / t.margin) * 100 : null;
  const marginBalance = pnl !== null ? t.margin + pnl : null;
  // Estimate only — Binance's real maintenance margin rate is tiered by
  // notional and pair, and that schedule isn't available without exchange
  // account access. A flat 0.4% is a reasonable low-tier approximation for
  // most pairs at moderate size.
  const maintMargin = positionValueNow !== null ? positionValueNow * 0.004 : null;
  const marginRatio = maintMargin !== null && marginBalance !== null ? (marginBalance > 0 ? (maintMargin / marginBalance) * 100 : 999) : null;

  const roiAlerts = t.roiAlerts || [];
  const pnlAlerts = t.pnlAlerts || [];

  // Always-expanded row now loads its ATH/ATL once on mount rather than on
  // a click-to-expand toggle. Re-runs whenever the symbol or the chosen
  // interval changes — 1d is the fast default, 1h lets the user scan for
  // the exact all-time high/low off 1h candles like Analyze's precise scan.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const cacheMap = (await safeStorageGet("ath-atl-cache")) || {};
        const key = t.symbol + "|" + athAtlInterval;
        const cached = cacheMap[key];
        const result = await fetchTrueAthAtl(t.symbol, athAtlInterval, cached, () => {});
        if (cancelled) return;
        cacheMap[key] = { interval: athAtlInterval, ...result };
        await safeStorageSet("ath-atl-cache", cacheMap);
        setAthAtl(result);
      } catch {
        if (!cancelled) setAthAtl(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t.symbol, athAtlInterval]);

  // Trend / strength / momentum / support / resistance / reversal, plus
  // open interest — same read the Analyze tab and Screener use, scoped to
  // this tracked pair.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setTaLoading(true);
      try {
        const data = await fetchTAForSymbol(t.symbol);
        if (!cancelled) setTa(data);
      } catch {
        if (!cancelled) setTa(null);
      } finally {
        if (!cancelled) setTaLoading(false);
      }
      try {
        const res = await fapiFetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${t.symbol}`);
        const data = res.ok ? await res.json() : null;
        if (!cancelled) setOi(data ? parseFloat(data.openInterest) : null);
      } catch {
        if (!cancelled) setOi(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t.symbol]);

  const submitRoiAlert = () => {
    const v = parseFloat(roiInput);
    if (!isFinite(v) || v === 0) return;
    onAddRoiAlert(t.id, v);
    setRoiInput("");
  };
  const submitPnlAlert = () => {
    const v = parseFloat(pnlInput);
    if (!isFinite(v) || v === 0) return;
    onAddPnlAlert(t.id, v);
    setPnlInput("");
  };

  const statBox = (label, value, color) => (
    <div>
      <div style={{ color: C.textDim, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 3 }}>{label}</div>
      <div style={{ fontFamily: mono, fontWeight: 700, fontSize: 13, color: color || C.text }}>{value}</div>
    </div>
  );

  return (
    <div style={{ background: C.panelAlt, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
      <div style={{ padding: "11px 12px", fontSize: 12.5, fontFamily: mono }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <CoinIcon symbol={t.symbol} logos={logos} size={18} />
            <span style={{ fontWeight: 700 }}>{t.symbol.replace("USDT", "/USDT")}</span>
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                padding: "2px 6px",
                borderRadius: 4,
                textTransform: "uppercase",
                whiteSpace: "nowrap",
                color: t.dir === "long" ? C.gain : C.loss,
                border: `1px solid ${t.dir === "long" ? C.gain : C.loss}`,
              }}
            >
              {t.dir} {t.leverage}x
            </span>
          </span>
          <span onClick={() => onRemove(t.id)} className="ft-btn" style={{ color: C.loss }}>
            remove
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
          <div>
            <div style={{ color: C.textDim, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 3 }}>PNL</div>
            <span style={{ color: pctColor(pnl), fontWeight: 700 }}>{pnl !== null ? (pnl >= 0 ? "+" : "") + pnl.toFixed(2) + " USDT" : "—"}</span>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ color: C.textDim, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 3 }}>ROI%</div>
            <span style={{ color: pctColor(roi), fontWeight: 700 }}>{fmtPct(roi)}</span>
          </div>
        </div>
      </div>
      <div style={{ borderTop: `1px solid ${C.border}`, padding: "12px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", rowGap: 12, columnGap: 10, marginBottom: 14 }}>
          {statBox("Entry Price", fmtPrice(t.entry), C.blue)}
          {statBox("Mark Price", cur !== null ? fmtPrice(cur) : "—", cur !== null ? (cur > t.entry ? C.gain : cur < t.entry ? C.loss : C.text) : C.text)}
          {statBox("Position Size", sizeU > 0 ? fmtCompact(sizeU) + " USDT" : "—", C.teal)}
          {statBox("Margin", fmtCompact(t.margin) + " USDT", C.pink)}
          {statBox("Margin Ratio (est.)", marginRatio !== null ? marginRatio.toFixed(1) + "%" : "—", marginRatioColor(marginRatio))}
          {statBox(
            "Funding / countdown",
            <>
              <span style={{ color: funding[t.symbol]?.rate >= 0 ? C.gain : C.loss }}>
                {funding[t.symbol] ? (funding[t.symbol].rate * 100).toFixed(4) + "%" : "—"}
              </span>{" "}
              / <FundingCountdown nextFundingTime={funding[t.symbol]?.nextFundingTime} />
            </>
          )}
          {statBox("24h Volume", row ? fmtCompact(parseFloat(row.quoteVolume)) + " USDT" : "—")}
          {statBox("Open Interest", taLoading && oi === null ? "…" : oi !== null ? fmtCompact(oi) : "—")}
          {statBox("Trend", taLoading ? "…" : ta ? <TaBadge text={ta.trend} tone={trendTone(ta.trend)} /> : "—")}
          {statBox(
            "Strength",
            taLoading ? (
              "…"
            ) : ta ? (
              <>
                <TaBadge text={ta.trendStrength} tone={strengthTone(ta.trendStrength)} />
                {ta.adx !== null && <span style={{ marginLeft: 6, fontSize: 11, color: C.textDim }}>ADX {ta.adx.toFixed(0)}</span>}
              </>
            ) : (
              "—"
            )
          )}
          {statBox(
            "Momentum",
            taLoading ? (
              "…"
            ) : ta ? (
              <>
                <TaBadge text={ta.momentum} tone={momentumTone(ta.momentum)} />
                {ta.rsi !== null && <span style={{ marginLeft: 6, fontSize: 11, color: C.textDim }}>RSI {ta.rsi.toFixed(0)}</span>}
              </>
            ) : (
              "—"
            )
          )}
          {statBox("Reversal", taLoading ? "…" : ta ? <TaBadge text={ta.reversal} tone={reversalTone(ta.reversal)} /> : "—")}
          {statBox("▲ Support", taLoading ? "…" : ta?.support ? fmtPrice(ta.support) : "—", C.gain)}
          {statBox("▼ Resistance", taLoading ? "…" : ta?.resistance ? fmtPrice(ta.resistance) : "—", C.loss)}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontSize: 10, color: C.textMuted }}>All-Time High &amp; Low</div>
          <select
            value={athAtlInterval}
            onChange={(e) => setAthAtlInterval(e.target.value)}
            style={{ ...selStyle(), fontSize: 10.5, padding: "3px 6px" }}
          >
            <option value="1d">1d (fast)</option>
            <option value="1h">1h (precise, slower)</option>
          </select>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
          <div style={{ background: C.lossBg, borderRadius: 8, padding: "10px 12px" }}>
            <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 2 }}>All Time Low</div>
            <div style={{ fontFamily: mono, fontWeight: 700, fontSize: 14, color: C.loss }}>
              {loading ? "…" : athAtl ? fmtPrice(athAtl.atl) : "—"}
            </div>
            <div style={{ fontSize: 10, color: C.textDim, marginTop: 2 }}>
              {loading ? "" : athAtl ? fmtDate(athAtl.atlTime) : ""}
            </div>
          </div>
          <div style={{ background: C.gainBg, borderRadius: 8, padding: "10px 12px" }}>
            <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 2 }}>All Time High</div>
            <div style={{ fontFamily: mono, fontWeight: 700, fontSize: 14, color: C.gain }}>
              {loading ? "…" : athAtl ? fmtPrice(athAtl.ath) : "—"}
            </div>
            <div style={{ fontSize: 10, color: C.textDim, marginTop: 2 }}>
              {loading ? "" : athAtl ? fmtDate(athAtl.athTime) : ""}
            </div>
          </div>
        </div>
        {athAtlInterval === "1h" && loading && (
          <div style={{ fontSize: 10.5, color: C.textMuted, marginTop: -8, marginBottom: 14, fontFamily: mono }}>
            Scanning full 1h history — this can take a bit longer…
          </div>
        )}

        <div
          onClick={() => setShowHelp((v) => !v)}
          className="ft-btn"
          style={{ fontSize: 11, color: C.textMuted, marginBottom: showHelp ? 8 : 14, display: "flex", alignItems: "center", gap: 4 }}
        >
          <span>{showHelp ? "▾" : "▸"}</span> How these are worked out
        </div>
        {showHelp && <TaConditionsNote />}

        <div
          onClick={() => setShowRoiAlerts((v) => !v)}
          className="ft-btn"
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: C.text,
            textTransform: "uppercase",
            letterSpacing: "0.03em",
            marginBottom: showRoiAlerts ? 8 : 0,
            marginTop: 14,
            display: "flex",
            alignItems: "center",
            gap: 7,
            background: C.panel,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            padding: "10px 12px",
          }}
        >
          <span style={{ fontSize: 11 }}>{showRoiAlerts ? "▾" : "▸"}</span> ROI% target alerts {roiAlerts.length > 0 ? `(${roiAlerts.length})` : ""}
        </div>
        {showRoiAlerts && (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 6 }}>
              {roiAlerts.length === 0 && <div style={{ fontSize: 11.5, color: C.textDim }}>None yet.</div>}
              {roiAlerts.map((a) => (
                <div
                  key={a.id}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 10px", fontSize: 12, fontFamily: mono }}
                >
                  <span>Notify when ROI {a.pct >= 0 ? "reaches +" : "drops to "}{a.pct}%</span>
                  <span onClick={() => onRemoveRoiAlert(t.id, a.id)} className="ft-btn" style={{ color: C.loss }}>
                    remove
                  </span>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
              <input
                type="number"
                value={roiInput}
                onChange={(e) => setRoiInput(e.target.value)}
                placeholder="e.g. 25% or -15%"
                style={{ ...selStyle(), width: 130 }}
              />
              <button
                onClick={submitRoiAlert}
                className="ft-btn"
                style={{ background: C.amber, color: "#1A1300", border: "none", borderRadius: 6, padding: "6px 14px", fontSize: 12, fontWeight: 700 }}
              >
                + Add
              </button>
            </div>
          </>
        )}

        <div
          onClick={() => setShowPnlAlerts((v) => !v)}
          className="ft-btn"
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: C.text,
            textTransform: "uppercase",
            letterSpacing: "0.03em",
            marginBottom: showPnlAlerts ? 8 : 0,
            marginTop: 10,
            display: "flex",
            alignItems: "center",
            gap: 7,
            background: C.panel,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            padding: "10px 12px",
          }}
        >
          <span style={{ fontSize: 11 }}>{showPnlAlerts ? "▾" : "▸"}</span> PNL (USDT) target alerts {pnlAlerts.length > 0 ? `(${pnlAlerts.length})` : ""}
        </div>
        {showPnlAlerts && (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 6 }}>
              {pnlAlerts.length === 0 && <div style={{ fontSize: 11.5, color: C.textDim }}>None yet.</div>}
              {pnlAlerts.map((a) => (
                <div
                  key={a.id}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 10px", fontSize: 12, fontFamily: mono }}
                >
                  <span>Notify when PNL {a.value >= 0 ? "reaches +" : "drops to "}{a.value} USDT</span>
                  <span onClick={() => onRemovePnlAlert(t.id, a.id)} className="ft-btn" style={{ color: C.loss }}>
                    remove
                  </span>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="number"
                value={pnlInput}
                onChange={(e) => setPnlInput(e.target.value)}
                placeholder="e.g. 50 USDT or -20 USDT"
                style={{ ...selStyle(), width: 160 }}
              />
              <button
                onClick={submitPnlAlert}
                className="ft-btn"
                style={{ background: C.amber, color: "#1A1300", border: "none", borderRadius: 6, padding: "6px 14px", fontSize: 12, fontWeight: 700 }}
              >
                + Add
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function AnalyzeTab({ rows, funding, analyzeSymbol, setAnalyzeSymbol, savedTrades, setSavedTrades, logos, goToTrades }) {
  const [section, setSection] = useState("setup"); // setup | deep
  const [justTracked, setJustTracked] = useState(null); // symbol just added to Trades
  const [form, setForm] = useState({ symbol: "", entry: "", margin: "", leverage: 10, dir: "long" });
  const [extras, setExtras] = useState(null);
  const [extrasStatus, setExtrasStatus] = useState("idle"); // idle | loading | live | error
  const [athAtl, setAthAtl] = useState(null);
  const [athAtlLoading, setAthAtlLoading] = useState(false);
  const [athAtlProgress, setAthAtlProgress] = useState(null);
  const [athAtlInterval, setAthAtlInterval] = useState("1d");
  const [athAtlError, setAthAtlError] = useState(null);
  const [error, setError] = useState(null);
  const [ta, setTa] = useState(null);
  const [taStatus, setTaStatus] = useState("idle"); // idle | loading | live | error
  const [showHelp, setShowHelp] = useState(false);

  const matchedRow = useMemo(() => {
    const sym = form.symbol.trim().toUpperCase();
    if (!sym) return null;
    const symbolFull = sym.endsWith("USDT") ? sym : sym + "USDT";
    return rows.find((r) => r.symbol === symbolFull) || null;
  }, [form.symbol, rows]);

  const sizeUsdt = (parseFloat(form.margin) || 0) * (parseFloat(form.leverage) || 0);

  const runAnalysis = async () => {
    setError(null);
    if (!matchedRow) {
      setError("Type or pick a pair that's on the list, e.g. BTC.");
      return;
    }
    const entry = parseFloat(form.entry);
    const margin = parseFloat(form.margin);
    const leverage = parseFloat(form.leverage);
    if (!entry || !margin || !leverage) {
      setError("Entry price, margin, and leverage all need a value.");
      return;
    }
    setAnalyzeSymbol(matchedRow.symbol);
  };

  useEffect(() => {
    if (matchedRow && !form.entry) {
      setForm((f) => ({ ...f, entry: matchedRow.lastPrice }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchedRow?.symbol]);

  // Official market data (long/short ratios, taker flow, depth, cross-exchange OI)
  // loads as soon as a pair is picked — this is separate from the PnL/risk read,
  // which needs entry/margin/leverage first.
  useEffect(() => {
    if (!matchedRow) {
      setExtras(null);
      setExtrasStatus("idle");
      return;
    }
    let cancelled = false;
    setExtrasStatus("loading");
    fetchAnalysisExtras(matchedRow.symbol)
      .then((data) => {
        if (cancelled) return;
        setExtras(data);
        setExtrasStatus("live");
      })
      .catch(() => {
        if (cancelled) return;
        setExtrasStatus("error");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchedRow?.symbol]);

  // Trend / strength / momentum / support / resistance / reversal — the
  // same 4h-candle read used by the Screener tab, for whichever pair is
  // picked here.
  useEffect(() => {
    if (!matchedRow) {
      setTa(null);
      setTaStatus("idle");
      return;
    }
    let cancelled = false;
    setTaStatus("loading");
    fetchTAForSymbol(matchedRow.symbol)
      .then((data) => {
        if (cancelled) return;
        setTa(data);
        setTaStatus("live");
      })
      .catch(() => {
        if (cancelled) return;
        setTaStatus("error");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchedRow?.symbol]);

  const runAthAtl = async () => {
    if (!matchedRow) return;
    setAthAtlError(null);
    setAthAtlLoading(true);
    setAthAtlProgress(null);
    try {
      const cacheMap = (await safeStorageGet("ath-atl-cache")) || {};
      const key = matchedRow.symbol + "|" + athAtlInterval;
      const cached = cacheMap[key];
      const result = await fetchTrueAthAtl(matchedRow.symbol, athAtlInterval, cached, (p) => setAthAtlProgress(p));
      cacheMap[key] = {
        interval: athAtlInterval,
        ath: result.ath,
        athTime: result.athTime,
        atl: result.atl,
        atlTime: result.atlTime,
        firstCandleTime: result.firstCandleTime,
        highClose: result.highClose,
        highCloseTime: result.highCloseTime,
        lowClose: result.lowClose,
        lowCloseTime: result.lowCloseTime,
        totalCandles: result.totalCandles,
        lastUpdated: result.lastUpdated,
      };
      await safeStorageSet("ath-atl-cache", cacheMap);
      setAthAtl(result);
    } catch (e) {
      setAthAtlError(e.message || "Couldn't calculate the All-Time High/Low — Binance may be rate-limiting requests, try again shortly.");
    } finally {
      setAthAtlLoading(false);
    }
  };

  // Auto-run as soon as a pair is picked (or the precision interval changes)
  // — no button needed for this, unlike the PnL/risk read below which needs
  // entry/margin/leverage first.
  useEffect(() => {
    setAthAtl(null);
    setAthAtlError(null);
    if (matchedRow) {
      runAthAtl();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchedRow?.symbol, athAtlInterval]);

  const current = matchedRow ? parseFloat(matchedRow.lastPrice) : null;
  const entryNum = parseFloat(form.entry);
  const pnlUsdt =
    current && entryNum
      ? form.dir === "long"
        ? ((current - entryNum) / entryNum) * sizeUsdt
        : ((entryNum - current) / entryNum) * sizeUsdt
      : null;
  const roiPct = pnlUsdt !== null && parseFloat(form.margin) ? (pnlUsdt / parseFloat(form.margin)) * 100 : null;

  const risk =
    matchedRow && entryNum && sizeUsdt
      ? computeRisk({
          direction: form.dir,
          entry: entryNum,
          sizeUsdt,
          current,
          change5m: null,
          change30m: null,
          change1h: null,
          change4h: null,
          quoteVolume24h: parseFloat(matchedRow.quoteVolume),
          fundingRate: funding[matchedRow.symbol]?.rate,
          positioning: null,
        })
      : null;

  const trackTrade = () => {
    if (!matchedRow || !entryNum || !form.margin || !form.leverage) return;
    const newMargin = parseFloat(form.margin);
    const newLeverage = parseFloat(form.leverage);
    const newNotional = newMargin * newLeverage;
    const newQty = entryNum ? newNotional / entryNum : 0;

    setSavedTrades((prev) => {
      // Same symbol + same direction already tracked — merge into it
      // instead of adding a separate row, the way Binance nets multiple
      // fills into one position: a size-weighted average entry price,
      // combined margin, and an effective leverage so margin × leverage
      // still equals the combined notional. PnL/ROI then flow from these
      // merged numbers automatically. A trade in the opposite direction
      // stays separate (that's a reduce/hedge, not an add).
      const idx = prev.findIndex((t) => t.symbol === matchedRow.symbol && t.dir === form.dir);
      if (idx === -1) {
        return [
          ...prev,
          {
            id: matchedRow.symbol + "-" + Date.now(),
            symbol: matchedRow.symbol,
            entry: entryNum,
            margin: newMargin,
            leverage: newLeverage,
            dir: form.dir,
            roiAlerts: [],
            pnlAlerts: [],
          },
        ];
      }
      const existing = prev[idx];
      const existingNotional = existing.margin * existing.leverage;
      const existingQty = existing.entry ? existingNotional / existing.entry : 0;
      const totalQty = existingQty + newQty;
      const totalNotional = existingNotional + newNotional;
      const totalMargin = existing.margin + newMargin;
      const next = [...prev];
      next[idx] = {
        ...existing,
        entry: totalQty ? totalNotional / totalQty : existing.entry,
        margin: totalMargin,
        leverage: totalMargin ? totalNotional / totalMargin : existing.leverage,
      };
      return next;
    });
    setJustTracked(matchedRow.symbol);
  };

  const distFromAth = current && athAtl?.ath ? ((current - athAtl.ath) / athAtl.ath) * 100 : null;
  const distFromAtl = current && athAtl?.atl ? ((current - athAtl.atl) / athAtl.atl) * 100 : null;

  return (
    <div style={{ maxWidth: 480 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {[
          ["setup", "Trade Setup"],
          ["deep", "Deep Analysis"],
        ].map(([key, label]) => (
          <button
            key={key}
            className="ft-btn"
            onClick={() => setSection(key)}
            style={{
              flex: 1,
              background: section === key ? C.amber : C.panel,
              color: section === key ? "#1A1300" : C.textMuted,
              border: `1px solid ${section === key ? C.amber : C.border}`,
              borderRadius: 8,
              padding: "10px",
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {section === "deep" && <DeepAnalysis rows={rows} funding={funding} logos={logos} />}

      {section === "setup" && (
        <>
      <div style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 16 }}>
        Enter a trade you've opened elsewhere to get a live read on it. This is an automated summary of public market data, not financial advice.
      </div>

      <Card title="Trade Setup">
        <Field label="Pair">
          <SymbolPicker
            rows={rows}
            logos={logos}
            value={form.symbol}
            onChange={(v) => setForm((f) => ({ ...f, symbol: v, entry: "" }))}
            onSelect={(sym) => setForm((f) => ({ ...f, symbol: sym.replace("USDT", ""), entry: "" }))}
            placeholder="Pair, e.g. BTC — tap to browse"
          />
          {matchedRow && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, fontFamily: mono, color: C.textMuted, marginTop: 8 }}>
              <CoinIcon symbol={matchedRow.symbol} logos={logos} />
              <span style={{ color: C.text, fontWeight: 600 }}>{matchedRow.symbol.replace("USDT", "/USDT")}</span>
              <span style={{ color: C.text }}>{fmtPrice(parseFloat(matchedRow.lastPrice))}</span>
              <span style={{ color: pctColor(parseFloat(matchedRow.priceChangePercent)) }}>{fmtPct(parseFloat(matchedRow.priceChangePercent))}</span>
            </div>
          )}
        </Field>

        <Field label="Entry Price">
          <input
            type="number"
            value={form.entry}
            onChange={(e) => setForm((f) => ({ ...f, entry: e.target.value }))}
            placeholder="e.g. 63250"
            style={{ ...selStyle(), padding: "10px 12px", width: "100%", boxSizing: "border-box", fontSize: 13 }}
          />
        </Field>

        <Field label="Margin (USDT)">
          <input
            type="number"
            value={form.margin}
            onChange={(e) => setForm((f) => ({ ...f, margin: e.target.value }))}
            placeholder="e.g. 100"
            style={{ ...selStyle(), padding: "10px 12px", width: "100%", boxSizing: "border-box", fontSize: 13 }}
          />
        </Field>

        <Field
          label={
            <span style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Leverage</span>
              <span style={{ color: C.amber, fontWeight: 700 }}>{form.leverage}x</span>
            </span>
          }
        >
          <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              value={form.leverage}
              onChange={(e) => setForm((f) => ({ ...f, leverage: e.target.value }))}
              style={{ width: "100%", accentColor: C.amber, position: "relative", zIndex: 1 }}
            />
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: "50%",
                transform: "translateY(-50%)",
                display: "flex",
                justifyContent: "space-between",
                zIndex: 2,
                pointerEvents: "none",
              }}
            >
              {[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((tick) => (
                <button
                  key={tick}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, leverage: tick }))}
                  aria-label={`Set leverage to ${tick}x`}
                  className="ft-btn"
                  style={{
                    background: "transparent",
                    border: "none",
                    padding: 8,
                    margin: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    pointerEvents: "auto",
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: Number(form.leverage) >= tick ? C.amber : C.borderLight,
                      boxShadow: `0 0 0 2px ${C.panel}`,
                      display: "block",
                    }}
                  />
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.textDim, marginTop: 2 }}>
            <span>0x</span>
            <span>50x</span>
            <span>100x</span>
          </div>
        </Field>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            background: C.panelAlt,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            padding: "10px 12px",
            marginBottom: 12,
          }}
        >
          <span style={{ fontSize: 11.5, color: C.textMuted }}>Position Size</span>
          <span style={{ fontFamily: mono, fontWeight: 700, fontSize: 14, color: C.text }}>
            {sizeUsdt > 0 ? fmtCompact(sizeUsdt) + " USDT" : "—"}
          </span>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button
            onClick={() => setForm((f) => ({ ...f, dir: "long" }))}
            className="ft-btn"
            style={{
              flex: 1,
              background: form.dir === "long" ? C.gain : C.panelAlt,
              color: form.dir === "long" ? "#06231A" : C.textMuted,
              border: `1px solid ${form.dir === "long" ? C.gain : C.border}`,
              borderRadius: 8,
              padding: "10px",
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            Long
          </button>
          <button
            onClick={() => setForm((f) => ({ ...f, dir: "short" }))}
            className="ft-btn"
            style={{
              flex: 1,
              background: form.dir === "short" ? C.loss : C.panelAlt,
              color: form.dir === "short" ? "#2A0A10" : C.textMuted,
              border: `1px solid ${form.dir === "short" ? C.loss : C.border}`,
              borderRadius: 8,
              padding: "10px",
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            Short
          </button>
        </div>

        <button
          onClick={runAnalysis}
          className="ft-btn"
          style={{ width: "100%", background: C.amber, color: "#1A1300", border: "none", borderRadius: 8, padding: "12px", fontSize: 13.5, fontWeight: 700 }}
        >
          {extrasStatus === "loading" ? "Analyzing…" : "Analyze"}
        </button>
        {error && <div style={{ fontSize: 12, color: C.loss, marginTop: 10 }}>{error}</div>}
      </Card>

      {matchedRow && (
        <Card
          title="Analysis"
          right={
            entryNum > 0 && pnlUsdt !== null ? (
              <button
                onClick={trackTrade}
                className="ft-btn"
                style={{ background: "transparent", color: C.amber, border: `1px solid ${C.amber}`, borderRadius: 6, padding: "4px 10px", fontSize: 10.5, fontWeight: 600 }}
              >
                + Track for flip alerts
              </button>
            ) : null
          }
        >
          {justTracked === matchedRow.symbol && (
            <div style={{ fontSize: 12.5, color: C.gain, marginBottom: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span>✓ Added to Trades.</span>
              <button
                onClick={goToTrades}
                className="ft-btn"
                style={{ background: "transparent", color: C.amber, border: `1px solid ${C.amber}`, borderRadius: 6, padding: "3px 10px", fontSize: 11, fontWeight: 600 }}
              >
                View in Trades
              </button>
            </div>
          )}
          {entryNum > 0 && pnlUsdt !== null && (
            <div style={{ paddingBottom: 14, marginBottom: 14, borderBottom: `1px solid ${C.border}` }}>
              <div style={{ display: "flex", gap: 24, marginBottom: 16 }}>
                <Stat label="PnL" value={`${pnlUsdt >= 0 ? "+" : ""}${pnlUsdt.toFixed(2)} USDT`} color={pctColor(pnlUsdt)} />
                <Stat label="ROI (on margin)" value={fmtPct(roiPct)} color={pctColor(roiPct)} />
              </div>

              {risk && (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                    <div style={{ flex: 1, height: 8, borderRadius: 4, background: C.border, overflow: "hidden" }}>
                      <div style={{ width: `${risk.score}%`, height: "100%", background: risk.color }} />
                    </div>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: risk.color, whiteSpace: "nowrap" }}>{risk.label}</div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                    {risk.factors.map((f, i) => (
                      <div key={i} style={{ fontSize: 12, color: f.bad ? C.text : C.textMuted, display: "flex", gap: 6 }}>
                        <span style={{ color: f.bad ? C.amber : C.gain }}>{f.bad ? "!" : "✓"}</span>
                        <span>{f.text}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 13,
              fontFamily: mono,
              paddingBottom: 14,
              marginBottom: 14,
              borderBottom: `1px solid ${C.border}`,
            }}
          >
            <div>
              <div style={{ color: C.textDim, fontSize: 10.5, marginBottom: 3 }}>Funding / countdown</div>
              <div>
                <span style={{ color: funding[matchedRow.symbol]?.rate >= 0 ? C.gain : C.loss, fontWeight: 700 }}>
                  {funding[matchedRow.symbol] ? (funding[matchedRow.symbol].rate * 100).toFixed(4) + "%" : "—"}
                </span>{" "}
                / <FundingCountdown nextFundingTime={funding[matchedRow.symbol]?.nextFundingTime} />
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ color: C.textDim, fontSize: 10.5, marginBottom: 3 }}>24h high / low</div>
              <div>
                {fmtPrice(parseFloat(matchedRow.highPrice))} / {fmtPrice(parseFloat(matchedRow.lowPrice))}
              </div>
            </div>
          </div>

          <div style={{ paddingBottom: 14, marginBottom: 14, borderBottom: `1px solid ${C.border}` }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", rowGap: 14, columnGap: 10 }}>
              <Stat label="24h Volume" value={fmtCompact(parseFloat(matchedRow.quoteVolume)) + " USDT"} color={C.teal} />
              <Stat
                label="Open Interest"
                value={
                  extrasStatus === "loading"
                    ? "…"
                    : extras?.multiExchange?.binance?.oi != null
                    ? fmtCompact(extras.multiExchange.binance.oi)
                    : "—"
                }
                color={C.pink}
              />
              <Stat label="Trend" value={taStatus === "loading" ? "…" : ta ? <TaBadge text={ta.trend} tone={trendTone(ta.trend)} /> : "—"} />
              <Stat
                label="Strength"
                value={
                  taStatus === "loading" ? (
                    "…"
                  ) : ta ? (
                    <>
                      <TaBadge text={ta.trendStrength} tone={strengthTone(ta.trendStrength)} />
                      {ta.adx !== null && <span style={{ marginLeft: 6, fontSize: 11, color: C.textDim }}>ADX {ta.adx.toFixed(0)}</span>}
                    </>
                  ) : (
                    "—"
                  )
                }
              />
              <Stat
                label="Momentum"
                value={
                  taStatus === "loading" ? (
                    "…"
                  ) : ta ? (
                    <>
                      <TaBadge text={ta.momentum} tone={momentumTone(ta.momentum)} />
                      {ta.rsi !== null && <span style={{ marginLeft: 6, fontSize: 11, color: C.textDim }}>RSI {ta.rsi.toFixed(0)}</span>}
                    </>
                  ) : (
                    "—"
                  )
                }
              />
              <Stat
                label="Reversal"
                value={taStatus === "loading" ? "…" : ta ? <TaBadge text={ta.reversal} tone={reversalTone(ta.reversal)} /> : "—"}
              />
              <Stat label="▲ Support" value={taStatus === "loading" ? "…" : ta?.support ? fmtPrice(ta.support) : "—"} color={C.gain} />
              <Stat label="▼ Resistance" value={taStatus === "loading" ? "…" : ta?.resistance ? fmtPrice(ta.resistance) : "—"} color={C.loss} />
            </div>
            <div
              onClick={() => setShowHelp((v) => !v)}
              className="ft-btn"
              style={{ fontSize: 11, color: C.textMuted, marginTop: 12, display: "flex", alignItems: "center", gap: 4 }}
            >
              <span>{showHelp ? "▾" : "▸"}</span> How these are worked out
            </div>
            {showHelp && <TaConditionsNote />}
          </div>

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.03em" }}>
                All-Time High &amp; Low
              </div>
              <select
                value={athAtlInterval}
                onChange={(e) => setAthAtlInterval(e.target.value)}
                style={{ ...selStyle(), fontSize: 10.5, padding: "3px 6px" }}
              >
                <option value="1d">1d (fast)</option>
                <option value="1h">1h (precise, slower)</option>
              </select>
            </div>

            {athAtlLoading && (
              <div style={{ fontSize: 12, color: C.textMuted, fontFamily: mono }}>
                Downloading full history…{" "}
                {athAtlProgress ? `batch ${athAtlProgress.batch}, ${athAtlProgress.totalSoFar.toLocaleString()} candles so far` : "starting…"}
              </div>
            )}

            {athAtlError && <div style={{ fontSize: 12, color: C.loss }}>{athAtlError}</div>}

            {athAtl && !athAtlLoading && (
              <div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
                  <div style={{ background: C.lossBg, borderRadius: 8, padding: "10px 12px" }}>
                    <div style={{ fontSize: 10.5, color: C.textMuted, marginBottom: 2 }}>All Time Low</div>
                    <div style={{ fontFamily: mono, fontWeight: 700, fontSize: 15, color: C.loss }}>{fmtPrice(athAtl.atl)}</div>
                    <div style={{ fontSize: 10, color: C.textDim, marginTop: 2 }}>{fmtDate(athAtl.atlTime)}</div>
                  </div>
                  <div style={{ background: C.gainBg, borderRadius: 8, padding: "10px 12px" }}>
                    <div style={{ fontSize: 10.5, color: C.textMuted, marginBottom: 2 }}>All Time High</div>
                    <div style={{ fontFamily: mono, fontWeight: 700, fontSize: 15, color: C.gain }}>{fmtPrice(athAtl.ath)}</div>
                    <div style={{ fontSize: 10, color: C.textDim, marginTop: 2 }}>{fmtDate(athAtl.athTime)}</div>
                  </div>
                  <div style={{ background: C.panelAlt, borderRadius: 8, padding: "10px 12px" }}>
                    <div style={{ fontSize: 10.5, color: C.textMuted, marginBottom: 2 }}>Low Close</div>
                    <div style={{ fontFamily: mono, fontWeight: 700, fontSize: 14, color: C.text }}>{fmtPrice(athAtl.lowClose)}</div>
                    <div style={{ fontSize: 10, color: C.textDim, marginTop: 2 }}>{fmtDate(athAtl.lowCloseTime)}</div>
                  </div>
                  <div style={{ background: C.panelAlt, borderRadius: 8, padding: "10px 12px" }}>
                    <div style={{ fontSize: 10.5, color: C.textMuted, marginBottom: 2 }}>High Close</div>
                    <div style={{ fontFamily: mono, fontWeight: 700, fontSize: 14, color: C.text }}>{fmtPrice(athAtl.highClose)}</div>
                    <div style={{ fontSize: 10, color: C.textDim, marginTop: 2 }}>{fmtDate(athAtl.highCloseTime)}</div>
                  </div>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, fontFamily: mono, marginBottom: 10 }}>
                  <span style={{ color: C.textMuted }}>Distance from All-Time Low</span>
                  <span style={{ color: pctColor(distFromAtl), fontWeight: 700 }}>{fmtPct(distFromAtl)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, fontFamily: mono, marginBottom: 12 }}>
                  <span style={{ color: C.textMuted }}>Distance from All-Time High</span>
                  <span style={{ color: pctColor(distFromAth), fontWeight: 700 }}>{fmtPct(distFromAth)}</span>
                </div>

                <div style={{ fontSize: 10.5, color: C.textDim, marginBottom: 10, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
                  Since {fmtDate(athAtl.firstCandleTime)} · {athAtl.totalCandles.toLocaleString()} candles scanned · cached in this browser, future checks only fetch what's new
                </div>
                <button
                  onClick={runAthAtl}
                  className="ft-btn"
                  style={{ background: "transparent", color: C.textMuted, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 12px", fontSize: 11 }}
                >
                  Refresh
                </button>
              </div>
            )}
          </div>
        </Card>
      )}

      {matchedRow && <MultiExchangePanel multiExchange={extras?.multiExchange} />}

        </>
      )}
    </div>
  );
}



// ---------------------------------------------------------------------------
// Trades tab — the user's tracked trades (set up in Analyze → Trade Setup).
// ---------------------------------------------------------------------------
function TradesTab({ rows, funding, logos, savedTrades, setSavedTrades, goToAnalyze }) {
  const removeTrade = (id) => setSavedTrades((prev) => prev.filter((t) => t.id !== id));
  const addRoiAlert = (tradeId, pct) =>
    setSavedTrades((prev) =>
      prev.map((t) => (t.id === tradeId ? { ...t, roiAlerts: [...(t.roiAlerts || []), { id: "ra-" + Date.now(), pct }] } : t))
    );
  const removeRoiAlert = (tradeId, alertId) =>
    setSavedTrades((prev) =>
      prev.map((t) => (t.id === tradeId ? { ...t, roiAlerts: (t.roiAlerts || []).filter((a) => a.id !== alertId) } : t))
    );
  const addPnlAlert = (tradeId, value) =>
    setSavedTrades((prev) =>
      prev.map((t) => (t.id === tradeId ? { ...t, pnlAlerts: [...(t.pnlAlerts || []), { id: "pa-" + Date.now(), value }] } : t))
    );
  const removePnlAlert = (tradeId, alertId) =>
    setSavedTrades((prev) =>
      prev.map((t) => (t.id === tradeId ? { ...t, pnlAlerts: (t.pnlAlerts || []).filter((a) => a.id !== alertId) } : t))
    );

  if (savedTrades.length === 0) {
    return (
      <div style={{ maxWidth: 480 }}>
        <Card title="Trades">
          <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.5, marginBottom: 12 }}>
            No tracked trades yet. Set one up in Analyze → Trade Setup, then tap "+ Track for flip alerts" and it will show up here.
          </div>
          <button
            onClick={goToAnalyze}
            className="ft-btn"
            style={{ background: C.amber, color: "#1A1300", border: "none", borderRadius: 8, padding: "10px 14px", fontSize: 13, fontWeight: 700 }}
          >
            Go to Analyze
          </button>
        </Card>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 480 }}>
      <Card title={`Tracked Trades · ${savedTrades.length}`}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {savedTrades.map((t) => (
            <TrackedTradeRow
              key={t.id}
              t={t}
              row={rows.find((r) => r.symbol === t.symbol)}
              funding={funding}
              logos={logos}
              onRemove={removeTrade}
              onAddRoiAlert={addRoiAlert}
              onRemoveRoiAlert={removeRoiAlert}
              onAddPnlAlert={addPnlAlert}
              onRemovePnlAlert={removePnlAlert}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deep Analysis helpers
// ---------------------------------------------------------------------------
const DEEP_INTERVALS = ["5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "1w", "1M"];
// Binance's own kline intervals (ms) — anything else a user asks for under
// "Custom" is built by merging smaller candles.
const NATIVE_KLINE_MS = {
  "1m": 60000, "3m": 180000, "5m": 300000, "15m": 900000, "30m": 1800000,
  "1h": 3600000, "2h": 7200000, "4h": 14400000, "6h": 21600000, "8h": 28800000,
  "12h": 43200000, "1d": 86400000, "3d": 259200000, "1w": 604800000, "1M": 2592000000,
};
const CUSTOM_UNIT_MS = { m: 60000, h: 3600000, d: 86400000, w: 604800000 };
const MAX_BASE_CANDLES = 6000;
const MIN_TA_CANDLES = 6; // fewest candles the indicators can be read from

// Decide which Binance interval to download, and how many of those candles
// make up one analysis candle.
function planKlines(intervalKey, customAmount, customUnit) {
  if (intervalKey !== "custom") return { base: intervalKey, ratio: 1, ms: NATIVE_KLINE_MS[intervalKey], label: intervalKey };
  const amount = Math.round(Number(customAmount));
  const ms = amount * (CUSTOM_UNIT_MS[customUnit] || 0);
  if (!amount || amount < 1 || ms < 60000) return null;
  const label = `${amount}${customUnit}`;
  const exact = Object.keys(NATIVE_KLINE_MS).find((k) => NATIVE_KLINE_MS[k] === ms && k !== "1M");
  if (exact) return { base: exact, ratio: 1, ms, label };
  const bases = ["1d", "12h", "8h", "6h", "4h", "2h", "1h", "30m", "15m", "5m", "3m", "1m"];
  const base = bases.find((b) => ms % NATIVE_KLINE_MS[b] === 0);
  return { base, ratio: ms / NATIVE_KLINE_MS[base], ms, label };
}

// Downloads the most recent n candles, paging backwards (Binance returns at
// most 1500 per request).
async function fetchKlinesN(symbol, interval, n) {
  const out = [];
  let endTime = null;
  while (out.length < n) {
    const limit = Math.min(1500, n - out.length);
    const url =
      `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}` +
      (endTime ? `&endTime=${endTime}` : "");
    // eslint-disable-next-line no-await-in-loop
    const res = await fapiFetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // eslint-disable-next-line no-await-in-loop
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    out.unshift(...data);
    endTime = data[0][0] - 1;
    if (data.length < limit) break;
  }
  return out;
}

// Merges `ratio` small candles into one, counting back from the newest so the
// latest candle is always complete-aligned to "now".
function aggregateCandles(candles, ratio) {
  if (ratio === 1) return candles;
  const groups = Math.floor(candles.length / ratio);
  const start = candles.length - groups * ratio;
  const out = [];
  for (let g = 0; g < groups; g++) {
    const s = candles.slice(start + g * ratio, start + (g + 1) * ratio);
    out.push([
      s[0][0],
      s[0][1],
      Math.max(...s.map((k) => parseFloat(k[2]))),
      Math.min(...s.map((k) => parseFloat(k[3]))),
      s[s.length - 1][4],
      s.reduce((a, k) => a + parseFloat(k[5]), 0),
      s[s.length - 1][6],
      s.reduce((a, k) => a + parseFloat(k[7]), 0),
    ]);
  }
  return out;
}

// Same trend / strength / momentum / support-resistance / reversal rules the
// Screener uses, run over whatever candles are handed in.
function computeTaFromCandles(highs, lows, closes, opts = {}) {
  const { emaFast = 20, emaSlow = 50, rsiPeriod = 14, adxPeriod = 14, lookback = 60 } = opts;
  const last = closes[closes.length - 1];
  const ema20 = emaSeries(closes, emaFast);
  const ema50 = emaSeries(closes, emaSlow);
  const lastEma20 = ema20[ema20.length - 1];
  const lastEma50 = ema50[ema50.length - 1];
  const emaGapPct = ((lastEma20 - lastEma50) / lastEma50) * 100;

  let trend = "Sideways";
  if (last > lastEma20 && lastEma20 > lastEma50 && emaGapPct > 0.15) trend = "Up";
  else if (last < lastEma20 && lastEma20 < lastEma50 && emaGapPct < -0.15) trend = "Down";

  const adx = adxValue(highs, lows, closes, adxPeriod);
  let trendStrength = "Weak";
  if (adx !== null) {
    if (adx >= 35) trendStrength = "Very strong";
    else if (adx >= 25) trendStrength = "Strong";
    else if (adx >= 15) trendStrength = "Moderate";
  }

  const rsi = rsiValue(closes, rsiPeriod);
  let momentum = "Neutral";
  if (rsi !== null) {
    if (rsi >= 70) momentum = "Overbought";
    else if (rsi >= 55) momentum = "Bullish";
    else if (rsi <= 30) momentum = "Oversold";
    else if (rsi <= 45) momentum = "Bearish";
  }

  const { support, resistance } = swingLevels(highs, lows, lookback);
  const nearRes = resistance ? (Math.abs(resistance - last) / last) * 100 : null;
  const nearSup = support ? (Math.abs(last - support) / last) * 100 : null;

  let reversal = "None";
  if (rsi !== null) {
    if (rsi >= 70 && nearRes !== null && nearRes <= 2) reversal = "Possible top";
    else if (rsi <= 30 && nearSup !== null && nearSup <= 2) reversal = "Possible bottom";
    else if (rsi >= 75) reversal = "Overextended up";
    else if (rsi <= 25) reversal = "Overextended down";
  }
  return { trend, trendStrength, adx, momentum, rsi, support, resistance, nearSupportPct: nearSup, nearResistancePct: nearRes, reversal };
}

function fmtDuration(ms) {
  const trim = (n) => (Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1));
  const min = ms / 60000;
  if (min < 60) return `${trim(min)} ${Math.round(min) === 1 ? "minute" : "minutes"}`;
  const h = min / 60;
  if (h < 24) return `${trim(h)} hours`;
  const d = h / 24;
  if (d < 14) return `${trim(d)} days`;
  if (d < 60) return `${trim(d / 7)} weeks`;
  if (d < 730) return `${trim(d / 30.4375)} months`;
  return `${trim(d / 365.25)} years`;
}

// Compact volume: 1K, 12.5K, 1M, 1.2B — one decimal at most, no trailing .0
function fmtVol(n) {
  const num = Number(n);
  if (!isFinite(num)) return "—";
  const abs = Math.abs(num);
  const t = (v) => v.toFixed(1).replace(/\.0$/, "");
  if (abs >= 1e12) return t(num / 1e12) + "T";
  if (abs >= 1e9) return t(num / 1e9) + "B";
  if (abs >= 1e6) return t(num / 1e6) + "M";
  if (abs >= 1e3) return t(num / 1e3) + "K";
  return t(num);
}

let fundingIntervalCache = null; // symbol -> hours, for pairs Binance has moved off the default 8h
async function getFundingIntervalHours(symbol) {
  if (!fundingIntervalCache) {
    fundingIntervalCache = {};
    try {
      const res = await fapiFetch("https://fapi.binance.com/fapi/v1/fundingInfo");
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) data.forEach((d) => (fundingIntervalCache[d.symbol] = Number(d.fundingIntervalHours)));
      } else {
        fundingIntervalCache = null;
      }
    } catch {
      fundingIntervalCache = null;
    }
  }
  return (fundingIntervalCache && fundingIntervalCache[symbol]) || 8;
}

const LS_PERIODS = [
  ["5m", 300000], ["15m", 900000], ["30m", 1800000], ["1h", 3600000], ["2h", 7200000],
  ["4h", 14400000], ["6h", 21600000], ["12h", 43200000], ["1d", 86400000],
];

// Long/short ratios + open-interest history over the analysed window, from
// Binance's public futures-data endpoints (Binance only keeps ~30 days).
async function fetchPositioning(symbol, windowMs) {
  let period = LS_PERIODS[0];
  LS_PERIODS.forEach((p) => {
    if (p[1] <= Math.max(windowMs / 2, 300000)) period = p;
  });
  const limit = Math.max(2, Math.min(500, Math.round(windowMs / period[1])));
  const get = (path) =>
    fapiFetch(`https://fapi.binance.com/futures/data/${path}?symbol=${symbol}&period=${period[0]}&limit=${limit}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  const [global, top, oiHist] = await Promise.all([
    get("globalLongShortAccountRatio"),
    get("topLongShortPositionRatio"),
    get("openInterestHist"),
  ]);
  const lastOf = (a) => (Array.isArray(a) && a.length ? a[a.length - 1] : null);
  const g = lastOf(global);
  const tp = lastOf(top);
  const avgRatio = Array.isArray(global) && global.length ? global.reduce((s, x) => s + parseFloat(x.longShortRatio), 0) / global.length : null;
  let oiChangePct = null;
  if (Array.isArray(oiHist) && oiHist.length >= 2) {
    const first = parseFloat(oiHist[0].sumOpenInterestValue);
    const last = parseFloat(oiHist[oiHist.length - 1].sumOpenInterestValue);
    if (first > 0) oiChangePct = ((last - first) / first) * 100;
  }
  return {
    period: period[0],
    covered: Array.isArray(global) ? global.length : 0,
    requested: limit,
    globalLongPct: g ? parseFloat(g.longAccount) * 100 : null,
    globalShortPct: g ? parseFloat(g.shortAccount) * 100 : null,
    globalRatio: g ? parseFloat(g.longShortRatio) : null,
    avgRatio,
    topLongPct: tp ? parseFloat(tp.longAccount) * 100 : null,
    topShortPct: tp ? parseFloat(tp.shortAccount) * 100 : null,
    topRatio: tp ? parseFloat(tp.longShortRatio) : null,
    oiChangePct,
  };
}

function positioningRead(priceChangePct, oiChangePct) {
  if (oiChangePct === null || priceChangePct === null) return null;
  const pUp = priceChangePct > 0.1;
  const pDown = priceChangePct < -0.1;
  const oUp = oiChangePct > 0.5;
  const oDown = oiChangePct < -0.5;
  if (pUp && oUp) return { text: "New longs entering — trend is being built with fresh money", tone: "bull" };
  if (pUp && oDown) return { text: "Shorts closing — rise driven by short covering, not new buyers", tone: "warn" };
  if (pDown && oUp) return { text: "New shorts entering — fresh selling pressure", tone: "bear" };
  if (pDown && oDown) return { text: "Longs closing — liquidation / capitulation, not new shorts", tone: "warn" };
  return { text: "Price or open interest roughly flat — no clear positioning shift", tone: "neutral" };
}

function DeepAnalysis({ rows, funding, logos }) {
  const [symbolText, setSymbolText] = useState("");
  const [intervalKey, setIntervalKey] = useState("1h");
  const [customAmount, setCustomAmount] = useState("");
  const [customUnit, setCustomUnit] = useState("h");
  const [count, setCount] = useState("100");
  const [status, setStatus] = useState("idle"); // idle | loading | done | error
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [athState, setAthState] = useState({ status: "idle", data: null });
  const [showHelp, setShowHelp] = useState(false);
  const runId = useRef(0);

  const matchedRow = useMemo(() => {
    const sym = symbolText.trim().toUpperCase();
    if (!sym) return null;
    const full = sym.endsWith("USDT") ? sym : sym + "USDT";
    return rows.find((r) => r.symbol === full) || null;
  }, [symbolText, rows]);

  // Shown under the candle-count box before anything is run.
  const previewMs = useMemo(() => {
    const plan = planKlines(intervalKey, customAmount, customUnit);
    const n = Math.round(Number(count));
    if (!plan || !n || n < 1) return null;
    return plan.ms * n;
  }, [intervalKey, customAmount, customUnit, count]);

  const run = async () => {
    setError(null);
    if (!matchedRow) {
      setError("Type or pick a pair that's on the list, e.g. BTC.");
      return;
    }
    const plan = planKlines(intervalKey, customAmount, customUnit);
    if (!plan) {
      setError("Enter a custom interval of at least 1 minute, e.g. 7 and h.");
      return;
    }
    const n = Math.round(Number(count));
    if (!n || n < 2) {
      setError("Enter how many candles to analyse (at least 2).");
      return;
    }
    const need = n * plan.ratio;
    if (need > MAX_BASE_CANDLES) {
      setError(
        plan.ratio > 1
          ? `That custom interval needs ${need.toLocaleString()} small candles — reduce the candle count (max about ${Math.max(
              1,
              Math.floor(MAX_BASE_CANDLES / plan.ratio)
            )}).`
          : `Too many candles — keep it under ${MAX_BASE_CANDLES}.`
      );
      return;
    }

    const id = ++runId.current;
    const symbol = matchedRow.symbol;
    setStatus("loading");
    setResult(null);
    setAthState({ status: "idle", data: null });
    try {
      const baseCandles = await fetchKlinesN(symbol, plan.base, need);
      const candles = aggregateCandles(baseCandles, plan.ratio);
      if (candles.length < 2) throw new Error("Binance has too little history for this pair at that interval.");
      const win = candles.slice(-n);
      // Everything below reads ONLY the candles in the chosen duration, so a
      // short window and a long window give genuinely different answers.
      const highs = win.map((k) => parseFloat(k[2]));
      const lows = win.map((k) => parseFloat(k[3]));
      const closes = win.map((k) => parseFloat(k[4]));
      const wn = win.length;
      const taParams = {
        emaSlow: Math.max(3, Math.min(50, Math.round(wn / 2))),
        rsiPeriod: Math.max(2, Math.min(14, wn - 1)),
        adxPeriod: Math.max(2, Math.min(14, Math.floor(wn / 2))),
        lookback: wn,
      };
      taParams.emaFast = Math.max(2, Math.round(taParams.emaSlow * 0.4));

      let hiIdx = 0, loIdx = 0;
      win.forEach((k, i) => {
        if (parseFloat(k[2]) > parseFloat(win[hiIdx][2])) hiIdx = i;
        if (parseFloat(k[3]) < parseFloat(win[loIdx][3])) loIdx = i;
      });
      const openFirst = parseFloat(win[0][1]);
      const closeLast = parseFloat(win[win.length - 1][4]);
      const durationMs = win[win.length - 1][6] + 1 - win[0][0];
      const stats = {
        symbol,
        intervalLabel: plan.label,
        requested: n,
        actual: win.length,
        durationMs,
        high: parseFloat(win[hiIdx][2]),
        highTime: win[hiIdx][0],
        low: parseFloat(win[loIdx][3]),
        lowTime: win[loIdx][0],
        changePct: ((closeLast - openFirst) / openFirst) * 100,
        quoteVolume: win.reduce((a, k) => a + parseFloat(k[7]), 0),
        ta: wn >= MIN_TA_CANDLES ? computeTaFromCandles(highs, lows, closes, taParams) : null,
        taParams,
      };

      const [extrasS, posS, fundS] = await Promise.allSettled([
        fetchAnalysisExtras(symbol),
        fetchPositioning(symbol, durationMs),
        getFundingIntervalHours(symbol),
      ]);
      if (id !== runId.current) return;
      stats.oi = extrasS.status === "fulfilled" ? extrasS.value?.multiExchange?.binance?.oi ?? null : null;
      stats.positioning = posS.status === "fulfilled" ? posS.value : null;
      stats.fundingHours = fundS.status === "fulfilled" ? fundS.value : 8;
      setResult(stats);
      setStatus("done");

      // All-time high/low shares the same on-device cache as the rest of the app
      setAthState({ status: "loading", data: null });
      try {
        const cacheMap = (await safeStorageGet("ath-atl-cache")) || {};
        const key = symbol + "|1d";
        const res = await fetchTrueAthAtl(symbol, "1d", cacheMap[key], () => {});
        cacheMap[key] = { interval: "1d", ...res };
        await safeStorageSet("ath-atl-cache", cacheMap);
        if (id === runId.current) setAthState({ status: "done", data: res });
      } catch {
        if (id === runId.current) setAthState({ status: "error", data: null });
      }
    } catch (e) {
      if (id !== runId.current) return;
      setError(e.message || "Couldn't load that analysis — Binance may be rate-limiting, try again shortly.");
      setStatus("error");
    }
  };

  const live = result ? rows.find((r) => r.symbol === result.symbol) : null;
  const currentPrice = live ? parseFloat(live.lastPrice) : null;
  const f = result ? funding[result.symbol] : null;
  const ta = result?.ta;
  const pos = result?.positioning;
  const read = pos ? positioningRead(result.changePct, pos.oiChangePct) : null;
  const toneColor = (tone) => ({ bull: C.gain, bear: C.loss, warn: C.amber }[tone] || C.textMuted);

  const Item = ({ label, value, sub, color }) => (
    <div>
      <div style={{ fontSize: 10.5, color: C.textDim, marginBottom: 2 }}>{label}</div>
      <div style={{ fontFamily: mono, fontWeight: 700, fontSize: 15, color: color || C.text }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: C.textDim, marginTop: 2, fontFamily: mono }}>{sub}</div>}
    </div>
  );
  const sectionStyle = { paddingBottom: 14, marginBottom: 14, borderBottom: `1px solid ${C.border}` };
  const grid = { display: "grid", gridTemplateColumns: "1fr 1fr", rowGap: 14, columnGap: 10 };
  const inputStyle = { ...selStyle(), padding: "10px 12px", width: "100%", boxSizing: "border-box", fontSize: 13 };

  return (
    <>
      <Card title="Deep Analysis">
        <Field label="Pair">
          <SymbolPicker
            rows={rows}
            logos={logos}
            value={symbolText}
            onChange={(v) => setSymbolText(v)}
            onSelect={(sym) => setSymbolText(sym.replace("USDT", ""))}
            placeholder="Pair, e.g. BTC — tap to browse"
          />
        </Field>

        <Field label="Candle interval (K-line)">
          <select value={intervalKey} onChange={(e) => setIntervalKey(e.target.value)} style={inputStyle}>
            {DEEP_INTERVALS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
            <option value="custom">Custom interval…</option>
          </select>
          {intervalKey === "custom" && (
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <input
                type="number"
                min="1"
                value={customAmount}
                onChange={(e) => setCustomAmount(e.target.value)}
                placeholder="e.g. 7"
                style={{ ...inputStyle, flex: 1 }}
              />
              <select value={customUnit} onChange={(e) => setCustomUnit(e.target.value)} style={{ ...inputStyle, width: 120 }}>
                <option value="m">minutes</option>
                <option value="h">hours</option>
                <option value="d">days</option>
                <option value="w">weeks</option>
              </select>
            </div>
          )}
        </Field>

        <Field label="How many candles to analyse">
          <input
            type="number"
            min="2"
            value={count}
            onChange={(e) => setCount(e.target.value)}
            placeholder="e.g. 100"
            style={inputStyle}
          />
          {previewMs !== null && (
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 8, fontFamily: mono }}>
              Duration of analysis:{" "}
              <span style={{ color: C.amber, fontWeight: 700 }}>
                {intervalKey === "1M" ? "≈ " : ""}
                {fmtDuration(previewMs)}
              </span>
            </div>
          )}
        </Field>

        <button
          onClick={run}
          disabled={status === "loading"}
          className="ft-btn"
          style={{
            width: "100%",
            background: C.amber,
            color: "#1A1300",
            border: "none",
            borderRadius: 8,
            padding: "12px",
            fontSize: 13.5,
            fontWeight: 700,
            opacity: status === "loading" ? 0.6 : 1,
          }}
        >
          {status === "loading" ? "Analysing…" : "Run deep analysis"}
        </button>
        {error && <div style={{ fontSize: 12, color: C.loss, marginTop: 10 }}>{error}</div>}
      </Card>

      {result && (
        <Card
          title="Result"
          right={
            <span style={{ fontSize: 10.5, color: C.textDim, fontFamily: mono }}>
              {result.actual} × {result.intervalLabel} candles
            </span>
          }
        >
          <div style={{ ...sectionStyle, display: "flex", alignItems: "center", gap: 10 }}>
            <CoinIcon symbol={result.symbol} logos={logos} size={30} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 16, color: C.text }}>{result.symbol.replace("USDT", "/USDT")}</div>
              <div style={{ fontSize: 11, color: C.textDim, fontFamily: mono }}>
                Analysed {fmtDuration(result.durationMs)}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontFamily: mono, fontWeight: 700, fontSize: 15, color: C.text }}>
                {currentPrice !== null ? fmtPrice(currentPrice) : "—"}
              </div>
              <div style={{ fontSize: 10, color: C.textDim }}>Current price</div>
            </div>
          </div>

          {result.actual < result.requested && (
            <div style={{ fontSize: 11.5, color: C.amber, marginBottom: 12 }}>
              Binance only has {result.actual} candles of history for this pair at {result.intervalLabel} — you asked for {result.requested}.
            </div>
          )}

          <div style={sectionStyle}>
            <div style={grid}>
              <Item label="Duration of analysis" value={fmtDuration(result.durationMs)} sub={`${result.actual} × ${result.intervalLabel}`} />
              <Item label="Change over duration" value={fmtPct(result.changePct)} color={pctColor(result.changePct)} />
              <Item label="High" value={fmtPrice(result.high)} sub={fmtDate(result.highTime)} color={C.gain} />
              <Item label="Low" value={fmtPrice(result.low)} sub={fmtDate(result.lowTime)} color={C.loss} />
              <Item label="Volume over duration" value={fmtVol(result.quoteVolume) + " USDT"} color={C.teal} />
              <Item
                label="Open interest (now)"
                value={result.oi != null ? fmtVol(result.oi) + " " + result.symbol.replace("USDT", "") : "—"}
                sub={result.oi != null && currentPrice ? `≈ ${fmtVol(result.oi * currentPrice)} USDT` : null}
                color={C.pink}
              />
            </div>
          </div>

          <div style={sectionStyle}>
            <div style={grid}>
              <Item
                label="Funding fee"
                value={f ? (f.rate >= 0 ? "+" : "") + (f.rate * 100).toFixed(4) + "%" : "—"}
                color={f ? (f.rate >= 0 ? C.gain : C.loss) : C.textDim}
                sub={`every ${result.fundingHours}h`}
              />
              <Item label="Next funding in" value={<FundingCountdown nextFundingTime={f?.nextFundingTime} />} />
            </div>
          </div>

          <div style={sectionStyle}>
            {ta ? (
              <>
                <div style={grid}>
                  <Item label="Trend" value={<TaBadge text={ta.trend} tone={trendTone(ta.trend)} />} />
                  <Item
                    label="Strength"
                    value={
                      <>
                        <TaBadge text={ta.trendStrength} tone={strengthTone(ta.trendStrength)} />
                        {ta.adx !== null && <span style={{ marginLeft: 6, fontSize: 11, color: C.textDim }}>ADX {ta.adx.toFixed(0)}</span>}
                      </>
                    }
                  />
                  <Item
                    label="Momentum"
                    value={
                      <>
                        <TaBadge text={ta.momentum} tone={momentumTone(ta.momentum)} />
                        {ta.rsi !== null && <span style={{ marginLeft: 6, fontSize: 11, color: C.textDim }}>RSI {ta.rsi.toFixed(0)}</span>}
                      </>
                    }
                  />
                  <Item label="Reversal" value={<TaBadge text={ta.reversal} tone={reversalTone(ta.reversal)} />} />
                  <Item label="▲ Support" value={ta.support ? fmtPrice(ta.support) : "—"} color={C.gain} />
                  <Item label="▼ Resistance" value={ta.resistance ? fmtPrice(ta.resistance) : "—"} color={C.loss} />
                </div>
                <div
                  onClick={() => setShowHelp((v) => !v)}
                  className="ft-btn"
                  style={{ fontSize: 11, color: C.textMuted, marginTop: 12, display: "flex", alignItems: "center", gap: 4 }}
                >
                  <span>{showHelp ? "▾" : "▸"}</span> How these are worked out
                </div>
                {showHelp && (
                  <div style={{ fontSize: 10.5, color: C.textDim, lineHeight: 1.5, borderTop: `1px solid ${C.border}`, marginTop: 12, paddingTop: 10 }}>
                    <div style={{ marginBottom: 5 }}>
                      Worked out only from the {result.actual} × {result.intervalLabel} candles in your duration, so changing the duration changes these.
                    </div>
                    <div style={{ marginBottom: 5 }}>
                      <span style={{ color: C.textMuted, fontWeight: 700 }}>Trend</span> — EMA{result.taParams.emaFast} vs EMA{result.taParams.emaSlow} (scaled down for short durations): Up when price &gt; fast &gt; slow with a gap over 0.15%, Down when the opposite, otherwise Sideways
                    </div>
                    <div style={{ marginBottom: 5 }}>
                      <span style={{ color: C.textMuted, fontWeight: 700 }}>Strength</span> — ADX{result.taParams.adxPeriod}: Very strong ≥ 35 · Strong ≥ 25 · Moderate ≥ 15 · Weak below
                    </div>
                    <div style={{ marginBottom: 5 }}>
                      <span style={{ color: C.textMuted, fontWeight: 700 }}>Momentum</span> — RSI{result.taParams.rsiPeriod}: Overbought ≥ 70 · Bullish ≥ 55 · Neutral · Bearish ≤ 45 · Oversold ≤ 30
                    </div>
                    <div style={{ marginBottom: 5 }}>
                      <span style={{ color: C.textMuted, fontWeight: 700 }}>Support / Resistance</span> — lowest low / highest high of the whole duration
                    </div>
                    <div>
                      <span style={{ color: C.textMuted, fontWeight: 700 }}>Reversal</span> — Possible top: RSI ≥ 70 and within 2% of resistance · Possible bottom: RSI ≤ 30 and within 2% of support · Overextended: RSI ≥ 75 / ≤ 25
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div style={{ fontSize: 12, color: C.textDim }}>Use at least {MIN_TA_CANDLES} candles to get trend / strength / momentum for this duration.</div>
            )}
          </div>

          <div style={sectionStyle}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 10 }}>
              All-time range
            </div>
            {athState.status === "loading" || athState.status === "idle" ? (
              <div style={{ fontSize: 12, color: C.textMuted, fontFamily: mono }}>Loading full history…</div>
            ) : athState.data ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div style={{ background: C.lossBg, borderRadius: 8, padding: "10px 12px" }}>
                  <div style={{ fontSize: 10.5, color: C.textMuted, marginBottom: 2 }}>All Time Low</div>
                  <div style={{ fontFamily: mono, fontWeight: 700, fontSize: 15, color: C.loss }}>{fmtPrice(athState.data.atl)}</div>
                  <div style={{ fontSize: 10, color: C.textDim, marginTop: 2 }}>{fmtDate(athState.data.atlTime)}</div>
                </div>
                <div style={{ background: C.gainBg, borderRadius: 8, padding: "10px 12px" }}>
                  <div style={{ fontSize: 10.5, color: C.textMuted, marginBottom: 2 }}>All Time High</div>
                  <div style={{ fontFamily: mono, fontWeight: 700, fontSize: 15, color: C.gain }}>{fmtPrice(athState.data.ath)}</div>
                  <div style={{ fontSize: 10, color: C.textDim, marginTop: 2 }}>{fmtDate(athState.data.athTime)}</div>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: C.loss }}>Couldn't load all-time high/low right now.</div>
            )}
          </div>

          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 10 }}>
              Long / Short &amp; Positioning
            </div>
            {pos && pos.globalRatio !== null ? (
              <>
                <div style={grid}>
                  <Item
                    label="Long / Short ratio (all accounts)"
                    value={pos.globalRatio.toFixed(2)}
                    sub={`${pos.globalLongPct.toFixed(1)}% long · ${pos.globalShortPct.toFixed(1)}% short`}
                    color={pos.globalRatio >= 1 ? C.gain : C.loss}
                  />
                  <Item
                    label="Top traders (by position)"
                    value={pos.topRatio !== null ? pos.topRatio.toFixed(2) : "—"}
                    sub={pos.topLongPct !== null ? `${pos.topLongPct.toFixed(1)}% long · ${pos.topShortPct.toFixed(1)}% short` : null}
                    color={pos.topRatio !== null ? (pos.topRatio >= 1 ? C.gain : C.loss) : C.textDim}
                  />
                  <Item label="Avg ratio over duration" value={pos.avgRatio !== null ? pos.avgRatio.toFixed(2) : "—"} />
                  <Item
                    label="Open interest change"
                    value={pos.oiChangePct !== null ? fmtPct(pos.oiChangePct) : "—"}
                    color={pctColor(pos.oiChangePct)}
                  />
                </div>
                {read && (
                  <div
                    style={{
                      marginTop: 12,
                      fontSize: 12.5,
                      color: toneColor(read.tone),
                      background: C.panelAlt,
                      border: `1px solid ${C.border}`,
                      borderRadius: 8,
                      padding: "10px 12px",
                      lineHeight: 1.45,
                    }}
                  >
                    <span style={{ fontWeight: 700 }}>Positioning: </span>
                    {read.text}
                  </div>
                )}
                {pos.globalRatio > 1.5 && <div style={{ fontSize: 11.5, color: C.amber, marginTop: 8 }}>Longs look crowded — more room for a long squeeze.</div>}
                {pos.globalRatio < 0.67 && <div style={{ fontSize: 11.5, color: C.amber, marginTop: 8 }}>Shorts look crowded — more room for a short squeeze.</div>}
                <div style={{ fontSize: 10.5, color: C.textDim, marginTop: 10 }}>
                  Binance data in {pos.period} steps
                  {pos.covered < pos.requested ? ` — only ${pos.covered} of ${pos.requested} periods available (Binance keeps about 30 days)` : ""}. Positioning compares the price change with the open-interest change over the same duration.
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12, color: C.textDim }}>Long/short and positioning data isn't available for this pair right now.</div>
            )}
          </div>
        </Card>
      )}
    </>
  );
}


// Color-coded badge chip used throughout the screener table (trend,
// strength, momentum, reversal) — keeps the "pro screener" look consistent
// without repeating the same inline style object everywhere.
function TaBadge({ text, tone }) {
  const palette = {
    bull: { bg: C.gainBg, fg: C.gain, border: C.gain },
    bear: { bg: C.lossBg, fg: C.loss, border: C.loss },
    warn: { bg: "rgba(232,163,61,0.12)", fg: C.amber, border: C.amber },
    neutral: { bg: C.panelAlt, fg: C.textMuted, border: C.border },
  }[tone] || { bg: C.panelAlt, fg: C.textMuted, border: C.border };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "3px 8px",
        borderRadius: 6,
        fontSize: 11,
        fontWeight: 700,
        background: palette.bg,
        color: palette.fg,
        border: `1px solid ${palette.border}`,
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}

function trendTone(trend) {
  if (trend === "Up") return "bull";
  if (trend === "Down") return "bear";
  return "neutral";
}
function strengthTone(s) {
  if (s === "Very strong" || s === "Strong") return "warn";
  if (s === "Moderate") return "neutral";
  return "neutral";
}
function momentumTone(m) {
  if (m === "Overbought" || m === "Bullish") return "bull";
  if (m === "Oversold" || m === "Bearish") return "bear";
  return "neutral";
}
function reversalTone(r) {
  if (r === "Possible bottom") return "bull";
  if (r === "Possible top") return "bear";
  if (r === "Overextended up" || r === "Overextended down") return "warn";
  return "neutral";
}

// Plain-language breakdown of exactly how Trend/Strength/Momentum/
// Support/Resistance/Reversal are worked out — the same rules the Screener,
// Analyze tab, and Tracked Trades all use (identical math client-side and
// server-side), so numbers never disagree between them.
function TaConditionsNote() {
  const row = (label, text) => (
    <div style={{ marginBottom: 5 }}>
      <span style={{ color: C.textMuted, fontWeight: 700 }}>{label}</span> — {text}
    </div>
  );
  return (
    <div style={{ fontSize: 10.5, color: C.textDim, lineHeight: 1.5, borderTop: `1px solid ${C.border}`, marginTop: 12, paddingTop: 10 }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 6 }}>
        How these are worked out (4h candles)
      </div>
      {row("Trend", "Up: price above EMA20 above EMA50, gap > 0.15% · Down: price below EMA20 below EMA50, gap < −0.15% · otherwise Sideways")}
      {row("Strength", "ADX14 — Very strong ≥ 35 · Strong ≥ 25 · Moderate ≥ 15 · Weak < 15")}
      {row("Momentum", "RSI14 — Overbought ≥ 70 · Bullish ≥ 55 · Neutral 45–55 · Bearish ≤ 45 · Oversold ≤ 30")}
      {row("Support / Resistance", "lowest low / highest high of the last 60 candles")}
      {row(
        "Reversal",
        "Possible top: RSI ≥ 70 and within 2% of resistance · Possible bottom: RSI ≤ 30 and within 2% of support · Overextended up: RSI ≥ 75 · Overextended down: RSI ≤ 25 · otherwise None"
      )}
    </div>
  );
}

// How close price has to be to a support/resistance level (either side) to
// count as "near" it for the Support/Resistance filter buttons — same 5%
// convention used by the Market tab's Near ATH/ATL filters.
const NEAR_LEVEL_PCT = 5;

function agoLabel(ms) {
  if (!ms) return null;
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  return `${hr}h ago`;
}

function ScreenerPanel({
  rows,
  taMap,
  taBulkStatus,
  taBulkDone,
  startTaBulk,
  serverMode,
  taSyncedAt,
  taServerCount,
  screenerAthAtl,
  scanScreenerAthAtl,
  athAtlMap,
  athAtlBulkStatus,
  startAthAtlBulk,
  logos,
}) {
  const [query, setQuery] = useState("");
  const [trendFilter, setTrendFilter] = useState("all"); // all | Up | Down | Sideways
  const [levelFilter, setLevelFilter] = useState("none"); // none | support | resistance | reversal
  const [sortKey, setSortKey] = useState("volume-desc"); // volume|rsi|adx + -desc|-asc
  const scanned = serverMode ? taServerCount : Object.keys(taMap).length;

  // ATH/ATL show automatically here, sourced from the same 1d bulk scan the
  // Market tab uses — no click needed. Kick that bulk scan off the moment
  // this tab is opened if nothing has started it yet, so the columns fill
  // in on their own instead of requiring a visit to Market's Near ATH/ATL
  // filters first. The precise 1h scan (screenerAthAtl) stays strictly
  // opt-in — that one only ever runs when the user taps it for a pair.
  useEffect(() => {
    if (athAtlBulkStatus === "idle") startAthAtlBulk();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A pair the background/bulk scan hasn't reached yet gets scanned
  // on-demand the moment a search narrows down to it, instead of just
  // sitting there saying "scanning…" until its turn eventually comes up.
  // Capped to a handful of matches so a broad query doesn't trigger a pile
  // of individual scans.
  const [onDemandMap, setOnDemandMap] = useState({});
  const onDemandRunning = useRef(new Set());
  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return;
    const matches = rows.filter((r) => r.symbol.toLowerCase().includes(q));
    if (matches.length === 0 || matches.length > 6) return;
    matches.forEach((r) => {
      const sym = r.symbol;
      if (taMap[sym] || onDemandMap[sym] || onDemandRunning.current.has(sym)) return;
      onDemandRunning.current.add(sym);
      fetchTAForSymbol(sym)
        .then((result) => setOnDemandMap((m) => ({ ...m, [sym]: result })))
        .catch(() => {})
        .finally(() => onDemandRunning.current.delete(sym));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, rows, taMap]);
  const effectiveTaMap = useMemo(() => ({ ...onDemandMap, ...taMap }), [onDemandMap, taMap]);

  const sorted = useMemo(() => {
    let list = rows.filter((r) => r.symbol.toLowerCase().includes(query.trim().toLowerCase()));
    if (trendFilter !== "all") {
      list = list.filter((r) => effectiveTaMap[r.symbol]?.trend === trendFilter);
    }
    if (levelFilter === "support") {
      list = list.filter((r) => {
        const t = effectiveTaMap[r.symbol];
        return t && t.nearSupportPct != null && t.nearSupportPct <= NEAR_LEVEL_PCT;
      });
    } else if (levelFilter === "resistance") {
      list = list.filter((r) => {
        const t = effectiveTaMap[r.symbol];
        return t && t.nearResistancePct != null && t.nearResistancePct <= NEAR_LEVEL_PCT;
      });
    } else if (levelFilter === "reversal") {
      list = list.filter((r) => {
        const t = effectiveTaMap[r.symbol];
        return t && t.reversal && t.reversal !== "None";
      });
    }
    list = [...list];
    const [field, dirKey] = sortKey.split("-");
    const dir = dirKey === "asc" ? 1 : -1;
    const valueOf = (r) => {
      if (field === "rsi") return effectiveTaMap[r.symbol]?.rsi ?? null;
      if (field === "adx") return effectiveTaMap[r.symbol]?.adx ?? null;
      const v = parseFloat(r.quoteVolume);
      return isFinite(v) ? v : null;
    };
    // Pairs with no reading yet always sink to the bottom, either direction.
    list.sort((a, b) => {
      const av = valueOf(a);
      const bv = valueOf(b);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return (av - bv) * dir;
    });
    return list;
  }, [rows, effectiveTaMap, query, trendFilter, levelFilter, sortKey]);

  // One ATH/ATL cell — shows the cached value (tap to rescan), a spinner
  // with batch progress while it's running, or a "Scan" button to kick it
  // off. ATH and ATL always come from the same single scan.
  // Shows automatically from the 1d bulk scan (athAtlMap) the moment it's
  // available — no click needed. A small link underneath lets the user
  // opt into the exact 1h-based value for that one pair (screenerAthAtl);
  // once that's done it takes over as the displayed value and is marked
  // "1h" so it's clear it's the more precise figure.
  const athAtlCell = (r, field) => {
    const precise = screenerAthAtl[r.symbol];
    const bulk = athAtlMap[r.symbol];
    const timeField = field === "ath" ? "athTime" : "atlTime";
    const preciseDone = precise?.status === "done";
    const value = preciseDone ? precise[field] : bulk ? bulk[field] : null;
    const time = preciseDone ? precise[timeField] : bulk ? bulk[timeField] : null;
    const linkStyle = {
      fontSize: 9.5,
      color: C.textMuted,
      background: "none",
      border: "none",
      padding: 0,
      textAlign: "left",
      textDecoration: "underline",
      cursor: "pointer",
    };

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {value != null ? (
          <>
            <span style={{ fontFamily: mono, fontSize: 12, fontWeight: 600, color: field === "ath" ? C.gain : C.loss }}>
              {fmtPrice(value)}
            </span>
            <span style={{ fontSize: 10, color: C.textDim, fontFamily: mono }}>
              {time ? new Date(time).toISOString().slice(0, 10) : "—"}
              {preciseDone ? " · 1h" : ""}
            </span>
          </>
        ) : (
          <span style={{ fontSize: 11, color: C.textDim, fontFamily: mono }}>scanning…</span>
        )}
        {precise?.status === "loading" ? (
          <span style={{ fontSize: 9.5, color: C.textDim }}>
            {precise.progress ? `1h scan (batch ${precise.progress})…` : "1h scan…"}
          </span>
        ) : precise?.status === "error" ? (
          <button className="ft-btn" onClick={() => scanScreenerAthAtl(r.symbol)} style={{ ...linkStyle, color: C.loss }}>
            1h scan failed · retry
          </button>
        ) : (
          <button className="ft-btn" onClick={() => scanScreenerAthAtl(r.symbol)} style={linkStyle}>
            {preciseDone ? "rescan 1h" : "scan precise 1h"}
          </button>
        )}
      </div>
    );
  };

  const levelBtn = (key, label) => (
    <button
      className="ft-btn"
      onClick={() => setLevelFilter((cur) => (cur === key ? "none" : key))}
      style={{
        background: levelFilter === key ? C.amber : C.panel,
        color: levelFilter === key ? "#1A1300" : C.textMuted,
        border: `1px solid ${levelFilter === key ? C.amber : C.border}`,
        borderRadius: 8,
        padding: "9px 14px",
        fontSize: 12.5,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );

  return (
    <>
      <div style={{ display: "flex", gap: 10, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
        <input
          className="ft-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search pair, e.g. BTC, SOL…"
          style={{
            flex: 1,
            minWidth: 160,
            boxSizing: "border-box",
            background: C.panel,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            color: C.text,
            fontSize: 13,
            padding: "9px 12px",
            outline: "none",
          }}
        />
        {["all", "Up", "Down", "Sideways"].map((t) => (
          <button
            key={t}
            className="ft-btn"
            onClick={() => setTrendFilter(t)}
            style={{
              background: trendFilter === t ? C.amber : C.panel,
              color: trendFilter === t ? "#1A1300" : C.textMuted,
              border: `1px solid ${trendFilter === t ? C.amber : C.border}`,
              borderRadius: 8,
              padding: "9px 14px",
              fontSize: 12.5,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            {t === "all" ? "All trends" : t}
          </button>
        ))}
        <select
          className="ft-input"
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value)}
          style={{
            background: C.panel,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            color: C.text,
            fontSize: 12.5,
            padding: "9px 10px",
            outline: "none",
          }}
        >
          <option value="volume-desc">Volume: High → Low</option>
          <option value="volume-asc">Volume: Low → High</option>
          <option value="rsi-desc">RSI: High → Low</option>
          <option value="rsi-asc">RSI: Low → High</option>
          <option value="adx-desc">Trend strength: High → Low</option>
          <option value="adx-asc">Trend strength: Low → High</option>
        </select>
        <button
          className="ft-btn"
          onClick={startTaBulk}
          disabled={taBulkStatus === "loading"}
          style={{
            background: C.panelRaised,
            color: C.text,
            border: `1px solid ${C.borderLight}`,
            borderRadius: 8,
            padding: "9px 14px",
            fontSize: 12.5,
            fontWeight: 700,
            whiteSpace: "nowrap",
            opacity: taBulkStatus === "loading" ? 0.6 : 1,
          }}
        >
          {taBulkStatus === "loading" ? `Scanning… ${taBulkDone}/${rows.length}` : scanned > 0 ? "Rescan" : "Run scan"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        {levelBtn("support", "Support")}
        {levelBtn("resistance", "Resistance")}
        {levelBtn("reversal", "Reversal")}
      </div>

      {taBulkStatus === "blocked" && (
        <div
          style={{
            background: C.lossBg,
            border: `1px solid ${C.loss}`,
            borderRadius: 8,
            padding: "11px 13px",
            fontSize: 13,
            color: C.loss,
            marginBottom: 12,
          }}
        >
          Binance has temporarily rate-limited this IP — the scan will resume automatically shortly.
        </div>
      )}

      {!serverMode && scanned === 0 && taBulkStatus !== "loading" && (
        <div style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 12 }}>
          Run a scan to classify every pair's trend, strength, momentum, support/resistance and reversal signal from
          official Binance 4h candles. This runs in this tab only — background alerts aren't configured, so it won't
          keep scanning once you leave.
        </div>
      )}

      {serverMode && scanned === 0 && (
        <div style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 12 }}>
          The background scanner is filling this in now — it runs on a schedule server-side, so it keeps scanning and
          stays current even when this app isn't open. Check back in a minute.
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ textAlign: "left", color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.3 }}>
              <th style={{ padding: "6px 8px" }}>Pair</th>
              <th style={{ padding: "6px 8px" }}>Price</th>
              <th style={{ padding: "6px 8px" }}>Volume</th>
              <th style={{ padding: "6px 8px" }}>Trend</th>
              <th style={{ padding: "6px 8px" }}>Strength</th>
              <th style={{ padding: "6px 8px" }}>Momentum</th>
              <th style={{ padding: "6px 8px" }}>Support</th>
              <th style={{ padding: "6px 8px" }}>Resistance</th>
              <th style={{ padding: "6px 8px" }}>Reversal</th>
              <th style={{ padding: "6px 8px" }}>ATL</th>
              <th style={{ padding: "6px 8px" }}>ATH</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const t = effectiveTaMap[r.symbol];
              const price = parseFloat(r.lastPrice);
              return (
                <tr key={r.symbol} className="ft-row" style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: "8px 8px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <CoinIcon symbol={r.symbol} size={18} logos={logos} />
                      <span style={{ fontWeight: 600, color: C.text }}>{r.symbol.replace("USDT", "")}</span>
                    </div>
                  </td>
                  <td style={{ padding: "8px 8px", fontFamily: mono, color: C.text }}>
                    {isFinite(price) ? fmtPrice(price) : "—"}
                  </td>
                  <td style={{ padding: "8px 8px", fontFamily: mono, color: C.teal }}>{fmtVol(r.quoteVolume)}</td>
                  {!t ? (
                    <td colSpan={6} style={{ padding: "8px 8px", color: C.textDim, fontFamily: mono, fontSize: 11.5 }}>
                      scanning…
                    </td>
                  ) : (
                    <>
                      <td style={{ padding: "8px 8px" }}>
                        <TaBadge text={t.trend} tone={trendTone(t.trend)} />
                      </td>
                      <td style={{ padding: "8px 8px" }}>
                        <TaBadge text={t.trendStrength} tone={strengthTone(t.trendStrength)} />
                        {t.adx !== null && (
                          <span style={{ marginLeft: 6, fontFamily: mono, fontSize: 11, color: C.textDim }}>
                            ADX {t.adx.toFixed(0)}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: "8px 8px" }}>
                        <TaBadge text={t.momentum} tone={momentumTone(t.momentum)} />
                        {t.rsi !== null && (
                          <span style={{ marginLeft: 6, fontFamily: mono, fontSize: 11, color: C.textDim }}>
                            RSI {t.rsi.toFixed(0)}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: "8px 8px", fontFamily: mono, color: C.gain }}>
                        {t.support != null ? t.support.toPrecision(6) : "—"}
                        {t.nearSupportPct != null && (
                          <span style={{ marginLeft: 6, fontSize: 11, color: C.textDim }}>
                            ({t.nearSupportPct.toFixed(1)}%)
                          </span>
                        )}
                      </td>
                      <td style={{ padding: "8px 8px", fontFamily: mono, color: C.loss }}>
                        {t.resistance != null ? t.resistance.toPrecision(6) : "—"}
                        {t.nearResistancePct != null && (
                          <span style={{ marginLeft: 6, fontSize: 11, color: C.textDim }}>
                            ({t.nearResistancePct.toFixed(1)}%)
                          </span>
                        )}
                      </td>
                      <td style={{ padding: "8px 8px" }}>
                        <TaBadge text={t.reversal} tone={reversalTone(t.reversal)} />
                      </td>
                    </>
                  )}
                  <td style={{ padding: "8px 8px" }}>{athAtlCell(r, "atl")}</td>
                  <td style={{ padding: "8px 8px" }}>{athAtlCell(r, "ath")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: C.textDim, display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
        <span>{sorted.length} of {rows.length || "…"} pairs · {scanned} scanned</span>
        <span>
          {serverMode
            ? `Scanned server-side${taSyncedAt ? ` · newest ${agoLabel(taSyncedAt)}` : ""} · EMA20/50, RSI14, ADX14, 60-candle swing levels`
            : "Based on official Binance 4h candles · EMA20/50, RSI14, ADX14, 60-candle swing levels"}
          {" · ATH/ATL fill in automatically · tap \"scan precise 1h\" for the exact 1h-based value"}
        </span>
      </div>
    </>
  );
}

function AlertsPanel({
  rulesEnabled,
  setRulesEnabled,
  globalRulesMasterOn,
  setGlobalRulesMasterOn,
  otherAlertsMasterOn,
  setOtherAlertsMasterOn,
  defaultRulePcts,
  setDefaultRulePcts,
  customAlerts,
  removeCustomAlert,
  globalAlerts,
  setGlobalAlerts,
  newGlobalAlertForm,
  setNewGlobalAlertForm,
  newAlertForm,
  setNewAlertForm,
  addCustomAlert,
  triggered,
  notifPerm,
  requestNotifPermission,
  bgAlertsStatus,
  enableBackgroundAlerts,
  disableBackgroundAlerts,
  symbols,
  rows,
  logos,
}) {
  const addGlobalAlert = () => {
    let minutes;
    if (newGlobalAlertForm.min === "custom") {
      const amount = Number(newGlobalAlertForm.customAmount) || 0;
      const raw = newGlobalAlertForm.customUnit === "h" ? amount * 60 : amount;
      minutes = Math.max(5, Math.min(GLOBAL_BG_MAX_MIN, Math.round(raw)));
    } else {
      minutes = Number(newGlobalAlertForm.min);
    }
    setGlobalAlerts((prev) => [
      ...prev,
      { id: "g-" + Date.now(), min: minutes, pct: Number(newGlobalAlertForm.pct), dir: newGlobalAlertForm.dir },
    ]);
    setNewGlobalAlertForm({ min: 15, pct: 5, dir: "either", customAmount: 2, customUnit: "h" });
  };
  const removeGlobalAlert = (id) => setGlobalAlerts((prev) => prev.filter((g) => g.id !== id));

  return (
    <div>
      {notifPerm !== "granted" && notifPerm !== "unsupported" && (
        <div
          style={{
            background: C.panel,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            padding: "11px 13px",
            marginBottom: 16,
            fontSize: 12.5,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <span style={{ color: C.textMuted }}>
            Enable browser notifications — only fires while this app is open in an active tab.
          </span>
          <button
            className="ft-btn"
            onClick={requestNotifPermission}
            style={{ background: C.amber, color: "#1A1300", border: "none", borderRadius: 6, padding: "6px 12px", fontSize: 12, fontWeight: 700 }}
          >
            Enable
          </button>
        </div>
      )}
      {notifPerm === "unsupported" && (
        <div
          style={{
            background: C.panel,
            border: `1px solid ${C.border}`,
            borderLeft: `3px solid ${C.amber}`,
            borderRadius: 8,
            padding: "11px 13px",
            marginBottom: 16,
            fontSize: 12.5,
            color: C.text,
            lineHeight: 1.45,
          }}
        >
          {typeof navigator !== "undefined" && navigator.standalone ? (
            <>
              <b>Notifications aren't available here.</b> Even installed to your Home Screen, iOS needs 16.4 or later for
              web app notifications — everything below still works, alerts just show in the feed rather than as a system
              popup.
            </>
          ) : (
            <>
              <b>Notification popups need one extra step on iPhone.</b> Regular Safari tabs can't show system
              notifications at all — that's an iOS restriction, not something this app can work around. Add this to your
              Home Screen (Share → Add to Home Screen) and open it from there, then come back to this tab to enable them.
              Until then, triggered alerts still show in the feed below — you just won't get a popup outside the app.
            </>
          )}
        </div>
      )}

      <div
        style={{
          background: C.panel,
          border: `1px solid ${bgAlertsStatus === "on" ? C.gain : C.border}`,
          borderRadius: 8,
          padding: "12px 13px",
          marginBottom: 20,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: C.text }}>Background alerts</div>
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              color: bgAlertsStatus === "on" ? C.gain : bgAlertsStatus === "error" ? C.loss : C.textDim,
            }}
          >
            {bgAlertsStatus === "on" && "● ON"}
            {bgAlertsStatus === "off" && "○ OFF"}
            {bgAlertsStatus === "enabling" && "enabling…"}
            {bgAlertsStatus === "error" && "● error"}
          </span>
        </div>

        {bgAlertsStatus === "unconfigured" ? (
          <div style={{ fontSize: 11.5, color: C.textDim, lineHeight: 1.4 }}>
            Not set up on this deployment — background alerts need a Supabase project connected (see SETUP.md). Foreground
            alerts above still work normally without it.
          </div>
        ) : (
          <>
            <div style={{ fontSize: 11.5, color: C.textMuted, lineHeight: 1.4, marginBottom: 8 }}>
              Runs on a server, not your phone — alerts still fire and notify you even with the app fully closed. Covers
              the four global rules and any custom/global alert set to 1h or under, plus profit/loss flips on tracked
              trades. Requires installing to your Home Screen first (Share → Add to Home Screen) and iOS 16.4+.
            </div>
            {bgAlertsStatus === "on" ? (
              <button
                onClick={disableBackgroundAlerts}
                className="ft-btn"
                style={{ background: "transparent", color: C.loss, border: `1px solid ${C.loss}`, borderRadius: 6, padding: "7px 14px", fontSize: 12, fontWeight: 600 }}
              >
                Turn off
              </button>
            ) : (
              <button
                onClick={enableBackgroundAlerts}
                disabled={bgAlertsStatus === "enabling"}
                className="ft-btn"
                style={{ background: C.amber, color: "#1A1300", border: "none", borderRadius: 6, padding: "7px 14px", fontSize: 12, fontWeight: 700 }}
              >
                {bgAlertsStatus === "enabling" ? "Enabling…" : "Turn on background alerts"}
              </button>
            )}
            {bgAlertsStatus === "error" && (
              <div style={{ fontSize: 11, color: C.loss, marginTop: 6 }}>
                Couldn't enable — check notification permission is allowed, and that you opened this from your Home
                Screen icon rather than Safari directly.
              </div>
            )}
          </>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
        <SectionTitle>Global rules — apply to every pair</SectionTitle>
        <MasterToggle on={globalRulesMasterOn} onToggle={() => setGlobalRulesMasterOn((v) => !v)} />
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          marginBottom: 18,
          opacity: globalRulesMasterOn ? 1 : 0.45,
          pointerEvents: globalRulesMasterOn ? "auto" : "none",
        }}
      >
        {DEFAULT_RULES.map((rule) => (
          <label
            key={rule.min}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              fontSize: 13,
              background: C.panel,
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              padding: "9px 12px",
            }}
          >
            <input
              type="checkbox"
              checked={!!rulesEnabled[rule.min]}
              onChange={(e) => setRulesEnabled((r) => ({ ...r, [rule.min]: e.target.checked }))}
            />
            <span>
              Notify if any pair moves ±
              <input
                type="number"
                min="0.1"
                step="0.1"
                value={defaultRulePcts[rule.min] ?? rule.pct}
                onChange={(e) =>
                  setDefaultRulePcts((p) => ({ ...p, [rule.min]: Math.max(0.1, Number(e.target.value) || rule.pct) }))
                }
                style={{
                  width: 52,
                  margin: "0 4px",
                  background: C.panelAlt,
                  border: `1px solid ${C.border}`,
                  borderRadius: 5,
                  color: C.text,
                  fontSize: 12.5,
                  padding: "2px 5px",
                  fontFamily: mono,
                }}
              />
              % within {INTERVALS.find((i) => i.min === rule.min)?.label}
            </span>
          </label>
        ))}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
        <SectionTitle>Global alerts & custom alerts — any pair, your own threshold</SectionTitle>
        <MasterToggle on={otherAlertsMasterOn} onToggle={() => setOtherAlertsMasterOn((v) => !v)} />
      </div>
      <div style={{ fontSize: 11.5, color: C.textDim, marginBottom: 8, marginTop: -4 }}>
        Runs across every pair, checked by the background job once a minute. Any interval up to 24h — pick a preset or
        choose Custom for anything else (e.g. 9h, 11h, 18h). This switch covers both the Global alerts and Custom
        alerts sections below.
      </div>
      <div
        style={{
          opacity: otherAlertsMasterOn ? 1 : 0.45,
          pointerEvents: otherAlertsMasterOn ? "auto" : "none",
        }}
      >
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
        {globalAlerts.length === 0 && (
          <div style={{ fontSize: 12.5, color: C.textDim }}>None yet.</div>
        )}
        {globalAlerts.map((g) => (
          <div
            key={g.id}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              background: C.panel,
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              padding: "8px 12px",
              fontSize: 12.5,
              fontFamily: mono,
            }}
          >
            <span>
              Any pair · ±{g.pct}% / {minutesLabel(g.min)} · {g.dir}
            </span>
            <span onClick={() => removeGlobalAlert(g.id)} className="ft-btn" style={{ color: C.loss }}>
              remove
            </span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <select
          value={newGlobalAlertForm.min}
          onChange={(e) => setNewGlobalAlertForm((f) => ({ ...f, min: e.target.value === "custom" ? "custom" : Number(e.target.value) }))}
          style={selStyle()}
        >
          {INTERVALS.filter((iv) => iv.min <= 960).map((iv) => (
            <option key={iv.min} value={iv.min}>
              {iv.label}
            </option>
          ))}
          <option value="custom">Custom…</option>
        </select>
        {newGlobalAlertForm.min === "custom" && (
          <>
            <input
              type="number"
              value={newGlobalAlertForm.customAmount}
              onChange={(e) => setNewGlobalAlertForm((f) => ({ ...f, customAmount: e.target.value }))}
              style={{ ...selStyle(), width: 56 }}
            />
            <select
              value={newGlobalAlertForm.customUnit}
              onChange={(e) => setNewGlobalAlertForm((f) => ({ ...f, customUnit: e.target.value }))}
              style={selStyle()}
            >
              <option value="m">min</option>
              <option value="h">hours</option>
            </select>
          </>
        )}
        <input
          type="number"
          value={newGlobalAlertForm.pct}
          onChange={(e) => setNewGlobalAlertForm((f) => ({ ...f, pct: e.target.value }))}
          style={{ ...selStyle(), width: 56 }}
        />
        <span style={{ fontSize: 11, color: C.textMuted }}>%</span>
        <select
          value={newGlobalAlertForm.dir}
          onChange={(e) => setNewGlobalAlertForm((f) => ({ ...f, dir: e.target.value }))}
          style={selStyle()}
        >
          <option value="either">either dir.</option>
          <option value="up">up only</option>
          <option value="down">down only</option>
        </select>
        <button
          className="ft-btn"
          onClick={addGlobalAlert}
          style={{ background: C.amber, color: "#1A1300", border: "none", borderRadius: 6, padding: "6px 14px", fontSize: 12, fontWeight: 700 }}
        >
          + Add
        </button>
      </div>
      {newGlobalAlertForm.min === "custom" && (
        <div style={{ fontSize: 10.5, color: C.textDim, marginTop: 6, marginBottom: 22 }}>
          Custom values are clamped to 5 minutes–24 hours — background alerts covering every pair get expensive past
          that, since price history has to be kept that far back for all ~300 pairs at once.
        </div>
      )}
      {newGlobalAlertForm.min !== "custom" && <div style={{ marginBottom: 22 }} />}

      <SectionTitle>Custom alerts — one specific pair</SectionTitle>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
        {customAlerts.length === 0 && (
          <div style={{ fontSize: 12.5, color: C.textDim }}>None yet — add one below, or use "+ Add alert" on any pair in Market.</div>
        )}
        {customAlerts.map((a) => (
          <div
            key={a.id}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              background: C.panel,
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              padding: "8px 12px",
              fontSize: 12.5,
              fontFamily: mono,
            }}
          >
            <span>
              {a.symbol.replace("USDT", "/USDT")} · ±{a.pct}% / {INTERVALS.find((i) => i.min === a.min)?.label} · {a.dir}
            </span>
            <span onClick={() => removeCustomAlert(a.id)} className="ft-btn" style={{ color: C.loss }}>
              remove
            </span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 22 }}>
        <div style={{ width: 160 }}>
          <SymbolPicker
            rows={rows}
            logos={logos}
            value={newAlertForm.symbol}
            onChange={(v) => setNewAlertForm((f) => ({ ...f, symbol: v }))}
            onSelect={(sym) => setNewAlertForm((f) => ({ ...f, symbol: sym.replace("USDT", "") }))}
            placeholder="Symbol e.g. BTC"
          />
        </div>
        <select value={newAlertForm.min} onChange={(e) => setNewAlertForm((f) => ({ ...f, min: Number(e.target.value) }))} style={selStyle()}>
          {INTERVALS.map((iv) => (
            <option key={iv.min} value={iv.min}>
              {iv.label}
            </option>
          ))}
        </select>
        <input
          type="number"
          value={newAlertForm.pct}
          onChange={(e) => setNewAlertForm((f) => ({ ...f, pct: e.target.value }))}
          style={{ ...selStyle(), width: 56 }}
        />
        <span style={{ fontSize: 11, color: C.textMuted }}>%</span>
        <select value={newAlertForm.dir} onChange={(e) => setNewAlertForm((f) => ({ ...f, dir: e.target.value }))} style={selStyle()}>
          <option value="either">either dir.</option>
          <option value="up">up only</option>
          <option value="down">down only</option>
        </select>
        <button
          className="ft-btn"
          onClick={addCustomAlert}
          style={{ background: C.amber, color: "#1A1300", border: "none", borderRadius: 6, padding: "6px 14px", fontSize: 12, fontWeight: 700 }}
        >
          + Add
        </button>
      </div>
      </div>

      <SectionTitle>Recent triggers</SectionTitle>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {triggered.length === 0 && <div style={{ fontSize: 12.5, color: C.textDim }}>Nothing yet — triggers will show up here.</div>}
        {triggered.map((e) => (
          <div
            key={e.id}
            style={{
              display: "flex",
              justifyContent: "space-between",
              background: C.panel,
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              padding: "8px 12px",
              fontSize: 12,
              fontFamily: mono,
            }}
          >
            <span>
              <b style={{ color: pctColor(e.actualChange) }}>{e.symbol.replace("USDT", "/USDT")}</b>{" "}
              <span style={{ color: pctColor(e.actualChange) }}>{fmtPct(e.actualChange)}</span>{" "}
              {e.isFlip ? (
                <span style={{ color: C.textDim }}>({e.label})</span>
              ) : (
                <>
                  in {e.label} <span style={{ color: C.textDim }}>(≥{e.thresholdPct}%)</span>
                </>
              )}
            </span>
            <span style={{ color: C.textDim }}>{new Date(e.time).toLocaleTimeString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SectionTitle({ children }) {
  return <div style={{ fontSize: 12.5, fontWeight: 600, color: C.text, marginBottom: 8 }}>{children}</div>;
}

// Small pill switch for a group of alert rules — on/off for the whole
// section at once. Visually distinct from the per-rule checkboxes below it.
function MasterToggle({ on, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="ft-btn"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: on ? C.gainBg : C.panelAlt,
        border: `1px solid ${on ? C.gain : C.border}`,
        borderRadius: 999,
        padding: "3px 10px 3px 4px",
        fontSize: 10.5,
        fontWeight: 700,
        color: on ? C.gain : C.textDim,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          width: 26,
          height: 15,
          borderRadius: 999,
          background: on ? C.gain : C.border,
          position: "relative",
          display: "inline-block",
          transition: "background 0.15s",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: on ? 13 : 2,
            width: 11,
            height: 11,
            borderRadius: "50%",
            background: "#fff",
            transition: "left 0.15s",
          }}
        />
      </span>
      {on ? "ON" : "OFF"}
    </button>
  );
}
