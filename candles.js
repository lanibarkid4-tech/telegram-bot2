// ======================================================
//  CANDLES PROVIDER — Yahoo (primary) + Twelve Data (backup)
//  Primary:  Yahoo Finance   -> tanpa API key, OHLC lengkap, multi-TF
//  Backup:   Twelve Data     -> kalau Yahoo rate-limited / error
//
//  Gratis 100%, hanya butuh TWELVE_DATA_API_KEY (opsional).
//  Yahoo endpoint: https://query1.finance.yahoo.com/v8/finance/chart/
// ======================================================
const https = require('https');
const { SimpleCache, Logger } = require('./utils');

const logger = new Logger('[candles]', 'info');

const TD_KEY = process.env.TWELVE_DATA_API_KEY;
const TD_BASE = 'api.twelvedata.com';
const YH_BASE = 'query1.finance.yahoo.com';

const tfCache = new SimpleCache(60, 50);

function fetchJson(host, path, timeoutMs = 15000, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host, path, method: 'GET', timeout: timeoutMs,
      headers: { 'User-Agent': 'Mozilla/5.0', ...extraHeaders }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Parse gagal: ' + e.message)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout ' + timeoutMs + 'ms')));
    req.on('error', reject);
    req.end();
  });
}

function num(v) {
  if (v === null || v === undefined) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// ======================================================
//  Symbol mapping per provider
// ======================================================
// Primary: SPOT (lebih akurat untuk trading, match dengan broker)
// Fallback: FUTURES (GC=F) — gap biasanya $0.50-2 dari spot
const TD_SYMBOLS = {
  xauusd: 'XAU/USD', gold: 'XAU/USD', xau: 'XAU/USD',
  xagusd: 'XAG/USD', silver: 'XAG/USD', xag: 'XAG/USD',
  eurusd: 'EUR/USD', gbpusd: 'GBP/USD', gbpjpy: 'GBP/JPY',
  usdjpy: 'USD/JPY', audusd: 'AUD/USD', nzdusd: 'NZD/USD',
  usdcad: 'USD/CAD', usdchf: 'USD/CHF',
  btcusd: 'BTC/USD', ethusd: 'ETH/USD',
  dxy: 'DXY', nasdaq: 'NDX', spx: 'SPX'
};

// Yahoo: SPOT primary (`XAU=X`), futures (`GC=F`) sebagai fallback
const YH_SYMBOLS_PRIMARY = {
  xauusd: 'XAU=X', gold: 'XAU=X', xau: 'XAU=X',
  xagusd: 'XAG=X', silver: 'XAG=X', xag: 'XAG=X',
  eurusd: 'EURUSD=X', gbpusd: 'GBPUSD=X', gbpjpy: 'GBPJPY=X',
  usdjpy: 'USDJPY=X', audusd: 'AUDUSD=X', nzdusd: 'NZDUSD=X',
  usdcad: 'USDCAD=X', usdchf: 'USDCHF=X',
  btcusd: 'BTC-USD', ethusd: 'ETH-USD',
  dxy: 'DX-Y.NYB', nasdaq: '^NDX', spx: '^GSPC'
};

// Fallback kalau primary ga ada (misal XAU=X rate-limited)
const YH_SYMBOLS_FALLBACK = {
  xauusd: 'GC=F', gold: 'GC=F', xau: 'GC=F',
  xagusd: 'SI=F', silver: 'SI=F', xag: 'SI=F',
  eurusd: 'EURUSD=X', gbpusd: 'GBPUSD=X', gbpjpy: 'GBPJPY=X',
  usdjpy: 'USDJPY=X', audusd: 'AUDUSD=X', nzdusd: 'NZDUSD=X',
  usdcad: 'USDCAD=X', usdchf: 'USDCHF=X',
  btcusd: 'BTC-USD', ethusd: 'ETH-USD',
  dxy: 'DX-Y.NYB', nasdaq: '^NDX', spx: '^GSPC'
};

function resolveSymbol(input, provider) {
  if (!input) return null;
  const k = String(input).toLowerCase().replace(/[^a-z]/g, '');
  if (provider === 'td') return TD_SYMBOLS[k] || input.toUpperCase();
  return YH_SYMBOLS_PRIMARY[k] || input.toUpperCase();
}

// ======================================================
//  Timeframe mapping
// ======================================================
const TD_INTERVALS = new Set(['1min', '2min', '3min', '5min', '10min', '15min', '30min', '45min', '1h', '2h', '4h', '1day', '1week']);

const YH_TF_MAP = {
  '1min': { interval: '1m', range: '5d' },
  '2min': { interval: '2m', range: '5d' },
  '3min': { interval: '5m', range: '5d' },   // Yahoo ga ada 3m, fallback 5m
  '5min': { interval: '5m', range: '1mo' },
  '10min': { interval: '15m', range: '1mo' },
  '15min': { interval: '15m', range: '1mo' },
  '30min': { interval: '30m', range: '2mo' },
  '45min': { interval: '60m', range: '3mo' },
  '1h': { interval: '60m', range: '3mo' },
  '2h': { interval: '60m', range: '6mo' },
  '4h': { interval: '60m', range: '1y' },
  '1day': { interval: '1d', range: '2y' },
  '1week': { interval: '1wk', range: '5y' }
};

// ======================================================
//  YAHOO FINANCE (primary, tanpa key)
//  Strategy: coba SPOT (XAU=X) dulu, fallback ke FUTURES (GC=F)
//  Return: { candles, source } — source = 'spot' | 'futures'
// ======================================================
async function fetchYahoo(symbol, interval, outputsize) {
  const tf = YH_TF_MAP[interval] || YH_TF_MAP['1h'];
  const k = String(symbol).toLowerCase().replace(/[^a-z]/g, '');

  // List symbol candidates: primary spot, fallback futures
  const candidates = [
    { sym: YH_SYMBOLS_PRIMARY[k], type: 'spot' },
    { sym: YH_SYMBOLS_FALLBACK[k], type: 'futures' }
  ].filter(c => c.sym);

  let lastErr = null;
  for (const cand of candidates) {
    try {
      const path = `/v8/finance/chart/${encodeURIComponent(cand.sym)}?interval=${tf.interval}&range=${tf.range}`;
      const data = await fetchJson(YH_BASE, path);
      const result = data.chart && data.chart.result && data.chart.result[0];
      if (!result || !result.timestamp || !result.timestamp.length) {
        const err = data.chart && data.chart.error;
        lastErr = new Error(`${cand.type}: ${(err && err.description) || 'no data'}`);
        continue;
      }
      const q = result.indicators.quote[0];
      const out = [];
      for (let i = 0; i < result.timestamp.length; i++) {
        if (q.close[i] === null || q.close[i] === undefined) continue;
        out.push({
          openTime: result.timestamp[i] * 1000,
          open: num(q.open[i]),
          high: num(q.high[i]),
          low: num(q.low[i]),
          close: num(q.close[i]),
          volume: num(q.volume[i]) || 0
        });
      }
      if (!out.length) {
        lastErr = new Error(`${cand.type}: no valid data ${cand.sym}`);
        continue;
      }
      return { candles: out.slice(-outputsize), source: cand.type, symbol: cand.sym };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Yahoo: no data');
}

// ======================================================
//  TWELVE DATA (backup, perlu key)
// ======================================================
let tdTimestamps = [];
async function tdThrottle() {
  const now = Date.now();
  tdTimestamps = tdTimestamps.filter(t => now - t < 60000);
  if (tdTimestamps.length >= 7) {
    const waitMs = 60000 - (now - tdTimestamps[0]) + 100;
    logger.info(`Twelve Data mendekati limit, antri ${Math.ceil(waitMs / 1000)}s...`);
    await new Promise(r => setTimeout(r, waitMs));
    return tdThrottle();
  }
  tdTimestamps.push(now);
}

async function fetchTD(symbol, interval, outputsize) {
  if (!TD_INTERVALS.has(interval)) {
    throw new Error(`Twelve Data tidak support TF ${interval}`);
  }
  await tdThrottle();
  const sym = resolveSymbol(symbol, 'td');
  const path = `/v1/time_series?symbol=${encodeURIComponent(sym)}&interval=${interval}&outputsize=${outputsize}&apikey=${TD_KEY}`;
  const data = await fetchJson(TD_BASE, path);
  if (data.status === 'error') throw new Error('Twelve Data: ' + (data.message || 'unknown'));
  const values = data.values || [];
  if (!values.length) throw new Error('Twelve Data: no data ' + sym);
  // TD returns newest first, reverse to oldest first
  return values.reverse().map(c => ({
    openTime: new Date(c.datetime).getTime(),
    open: num(c.open),
    high: num(c.high),
    low: num(c.low),
    close: num(c.close),
    volume: num(c.volume) || 0
  }));
}

// ======================================================
//  PUBLIC API
//  Return: { candles: [...], source: 'spot'|'futures'|'twelvedata', symbol, delay: '15min' }
// ======================================================
async function getCandles(symbol, interval = '1h', outputsize = 100) {
  const result = await getCandlesWithMeta(symbol, interval, outputsize);
  return result.candles;
}

async function getCandlesWithMeta(symbol, interval = '1h', outputsize = 100) {
  if (!symbol) throw new Error('Symbol kosong');

  const cacheKey = `meta_${symbol}_${interval}_${outputsize}`;
  const cached = tfCache.get(cacheKey);
  if (cached) return cached;

  const errors = [];

  // Primary: Yahoo Finance (spot, fallback futures)
  try {
    const r = await fetchYahoo(symbol, interval, outputsize);
    const result = {
      candles: r.candles,
      source: 'yahoo-' + r.source,
      symbol: r.symbol,
      delay: r.source === 'spot' ? '~15min' : '~15min',
      timestamp: Date.now()
    };
    tfCache.set(cacheKey, result);
    logger.info(`[yahoo ${r.source}] ${r.candles.length} candles ${r.symbol} ${interval}`);
    return result;
  } catch (e) {
    errors.push('yahoo: ' + e.message);
  }

  // Backup: Twelve Data
  if (TD_KEY) {
    try {
      const candles = await fetchTD(symbol, interval, outputsize);
      const result = {
        candles,
        source: 'twelvedata',
        symbol: resolveSymbol(symbol, 'td'),
        delay: '~1min',
        timestamp: Date.now()
      };
      tfCache.set(cacheKey, result);
      logger.info(`[twelvedata] ${candles.length} candles ${symbol} ${interval}`);
      return result;
    } catch (e) {
      errors.push('twelvedata: ' + e.message);
    }
  }

  throw new Error(errors.join(' | ') || 'Tidak ada data candles');
}

async function getMultiTimeframe(symbol, tfs = ['1day', '4h', '1h', '15min'], outputsize = 100) {
  const results = {};
  for (const tf of tfs) {
    try {
      const r = await getCandlesWithMeta(symbol, tf, outputsize);
      results[tf] = r.candles;
      // Simpan source info di hasil pertama aja (untuk reporting)
      if (!results.__meta) results.__meta = { source: r.source, symbol: r.symbol, delay: r.delay };
    } catch (e) {
      logger.warn(`${symbol} ${tf}: ${e.message}`);
      results[tf] = [];
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return results;
}

module.exports = {
  getCandles,
  getCandlesWithMeta,
  getMultiTimeframe,
  resolveSymbol,
  TD_SYMBOLS,
  FH_SYMBOLS: TD_SYMBOLS,  // back-compat
  YH_SYMBOLS: YH_SYMBOLS_PRIMARY
};
