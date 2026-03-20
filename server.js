import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 3001);
const FMP_KEY = process.env.FMP_KEY || "";
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 60000);

if (!FMP_KEY) {
  throw new Error("Falta FMP_KEY en el archivo .env");
}

const cache = new Map();

function getCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

function setCache(key, data) {
  cache.set(key, { ts: Date.now(), data });
}

function num(v, fallback = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function avg(arr) {
  if (!Array.isArray(arr) || !arr.length) return 0;
  return arr.reduce((a, b) => a + num(b), 0) / arr.length;
}

function stdevSample(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return 0;
  const mean = avg(arr);
  const variance = arr.reduce((sum, x) => sum + Math.pow(num(x) - mean, 2), 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0) return [];
  const k = 2 / (period + 1);
  const out = [];
  let prev = avg(values.slice(0, period));
  out.push(prev);

  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function calcMACD(closeSeries) {
  if (!Array.isArray(closeSeries) || closeSeries.length < 35) {
    return { macd: 0, signal: 0, histogram: 0, bullishCross: false, macdDivergence: false };
  }

  const ema12 = ema(closeSeries, 12);
  const ema26 = ema(closeSeries, 26);
  const aligned = [];
  const offset = 26 - 12;

  for (let i = 0; i < ema26.length; i++) {
    aligned.push(ema12[i + offset] - ema26[i]);
  }

  const signalArr = ema(aligned, 9);
  if (!signalArr.length) {
    return { macd: 0, signal: 0, histogram: 0, bullishCross: false, macdDivergence: false };
  }

  const lastMacd = aligned[aligned.length - 1];
  const prevMacd = aligned[aligned.length - 2] ?? lastMacd;
  const lastSignal = signalArr[signalArr.length - 1];
  const prevSignal = signalArr[signalArr.length - 2] ?? lastSignal;
  const histogram = lastMacd - lastSignal;
  const bullishCross = prevMacd <= prevSignal && lastMacd > lastSignal;

  return {
    macd: lastMacd,
    signal: lastSignal,
    histogram,
    bullishCross,
    macdDivergence: bullishCross && histogram > 0,
  };
}

function calcHigherLows(closeSeries) {
  if (!Array.isArray(closeSeries) || closeSeries.length < 7) return false;
  const a = closeSeries[closeSeries.length - 7];
  const b = closeSeries[closeSeries.length - 5];
  const c = closeSeries[closeSeries.length - 3];
  return b > a && c > b;
}

function calcSupport(closeSeries, lookback = 20) {
  if (!Array.isArray(closeSeries) || !closeSeries.length) return 0;
  const slice = closeSeries.slice(-lookback);
  return Math.min(...slice.map((v) => num(v)));
}

async function getJson(url) {
  const cached = getCache(url);
  if (cached) return cached;

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "ISSASA-Scanner-Pro/1.0",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} :: ${text || url}`);
  }

  const data = await res.json();
  setCache(url, data);
  return data;
}

async function fetchFmpBundle(symbol) {
  const baseStable = "https://financialmodelingprep.com/stable";
  const baseLegacy = "https://financialmodelingprep.com/api/v3";

  const urls = {
    quote: `${baseStable}/quote?symbol=${encodeURIComponent(symbol)}&apikey=${FMP_KEY}`,
    metrics: `${baseStable}/key-metrics-ttm?symbol=${encodeURIComponent(symbol)}&apikey=${FMP_KEY}`,
    historical: `${baseStable}/historical-price-eod/full?symbol=${encodeURIComponent(symbol)}&apikey=${FMP_KEY}`,
    rsi: `${baseLegacy}/technical_indicator/daily/${encodeURIComponent(symbol)}?type=rsi&period=14&apikey=${FMP_KEY}`,
    sma50: `${baseLegacy}/technical_indicator/daily/${encodeURIComponent(symbol)}?type=sma&period=50&apikey=${FMP_KEY}`,
    sma200: `${baseLegacy}/technical_indicator/daily/${encodeURIComponent(symbol)}?type=sma&period=200&apikey=${FMP_KEY}`,
  };

  const [quoteJson, metricsJson, historicalJson, rsiJson, sma50Json, sma200Json] = await Promise.all([
    getJson(urls.quote),
    getJson(urls.metrics),
    getJson(urls.historical),
    getJson(urls.rsi),
    getJson(urls.sma50),
    getJson(urls.sma200),
  ]);

  return { quoteJson, metricsJson, historicalJson, rsiJson, sma50Json, sma200Json };
}

function normalizeBundle(symbol, sectorPe, payload) {
  const q = Array.isArray(payload.quoteJson) ? payload.quoteJson[0] || {} : payload.quoteJson || {};
  const m = Array.isArray(payload.metricsJson) ? payload.metricsJson[0] || {} : payload.metricsJson || {};

  const historical = Array.isArray(payload.historicalJson?.historical)
    ? payload.historicalJson.historical
    : Array.isArray(payload.historicalJson)
      ? payload.historicalJson
      : [];

  const closesAsc = historical
    .slice()
    .reverse()
    .map((x) => num(x.close))
    .filter((x) => x > 0);

  const hist52w = closesAsc.slice(-40);
  const last20 = closesAsc.slice(-20);
  const close5dAgo = closesAsc.length >= 6 ? closesAsc[closesAsc.length - 6] : 0;

  const rsiSeries = Array.isArray(payload.rsiJson) ? payload.rsiJson : [];
  const sma50Series = Array.isArray(payload.sma50Json) ? payload.sma50Json : [];
  const sma200Series = Array.isArray(payload.sma200Json) ? payload.sma200Json : [];

  const rsi = num(rsiSeries[0]?.rsi);
  const rsiPrev = num(rsiSeries[1]?.rsi);
  const sma50 = num(sma50Series[0]?.sma || q.priceAvg50);
  const sma200 = num(sma200Series[0]?.sma || q.priceAvg200);

  const price = num(q.price);
  const volume = num(q.volume);
  const avgVolume20d = num(q.avgVolume);
  const high52 = num(q.yearHigh || q["52WeekHigh"]);
  const low52 = num(q.yearLow || q["52WeekLow"]);
  const marketCap = num(q.marketCap);

  const sd20 = stdevSample(last20);
  const bbLower = sma50 > 0 && sd20 > 0 ? sma50 - 2 * sd20 : 0;

  const macdPack = calcMACD(closesAsc);
  const higherLows = calcHigherLows(closesAsc);
  const support = calcSupport(closesAsc, 20);

  return {
    ticker: symbol,
    price,
    change_pct: num(q.changesPercentage ?? q.changePercentage),
    volume,
    avg_volume_20d: avgVolume20d,
    sma50,
    sma200,
    bb_lower: bbLower,
    rsi,
    rsi_prev: rsiPrev,
    macd_divergence: macdPack.macdDivergence,
    macd: macdPack.macd,
    macd_signal: macdPack.signal,
    macd_histogram: macdPack.histogram,
    higher_lows: higherLows,
    price_5d_ago: close5dAgo,
    support_level: support || (low52 > 0 ? low52 * 1.02 : 0),
    high_52w: high52,
    low_52w: low52,
    hist52w,
    sector_pe: num(sectorPe, 18),
    sector_momentum: num(q.changesPercentage ?? q.changePercentage),
    pe_ratio: num(m.peRatioTTM ?? m.peRatio),
    pb_ratio: num(m.pbRatioTTM ?? m.pbRatio),
    debt_equity: Math.abs(num(m.debtToEquityTTM ?? m.debtToEquity)),
    roe: num(m.roeTTM ?? m.roe) * 100,
    net_margin: num(m.netProfitMarginTTM ?? m.netProfitMargin) * 100,
    current_ratio: num(m.currentRatioTTM ?? m.currentRatio),
    revenue_growth: num(m.revenueGrowth) * 100,
    eps_growth: num(m.epsGrowth) * 100,
    market_cap: marketCap,
    isLive: true,
    isMock: false,
    liveError: false,
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "ISSASA Scanner API", cacheTtlMs: CACHE_TTL_MS, time: new Date().toISOString() });
});

app.get("/api/scan", async (req, res) => {
  const symbol = String(req.query.ticker || "").trim().toUpperCase();
  const sectorPe = num(req.query.sectorPe, 18);

  if (!symbol) {
    return res.status(400).json({ error: "ticker es requerido" });
  }

  try {
    const bundle = await fetchFmpBundle(symbol);
    const result = normalizeBundle(symbol, sectorPe, bundle);

    if (!result.price && !result.market_cap && !result.hist52w.length) {
      return res.status(404).json({ error: `Sin datos útiles para ${symbol}` });
    }

    return res.json(result);
  } catch (err) {
    return res.status(500).json({
      error: "No se pudo obtener dato LIVE",
      ticker: symbol,
      detail: err.message || "Error desconocido",
      isLive: false,
      isMock: false,
      liveError: true,
    });
  }
});

app.get("/api/scan/batch", async (req, res) => {
  const tickersRaw = String(req.query.tickers || "");
  const sectorPe = num(req.query.sectorPe, 18);

  const tickers = tickersRaw
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 25);

  if (!tickers.length) {
    return res.status(400).json({ error: "tickers es requerido" });
  }

  const out = await Promise.all(
    tickers.map(async (symbol) => {
      try {
        const bundle = await fetchFmpBundle(symbol);
        return normalizeBundle(symbol, sectorPe, bundle);
      } catch (err) {
        return {
          ticker: symbol,
          isLive: false,
          isMock: false,
          liveError: true,
          error: err.message || "Error desconocido",
        };
      }
    })
  );

  res.json(out);
});

app.listen(PORT, () => {
  console.log(`API LIVE corriendo en http://localhost:${PORT}`);
});
