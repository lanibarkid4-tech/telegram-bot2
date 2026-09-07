// ======================================================
//  CANDLES PROVIDER — Twelve Data (primary) + OANDA (backup)
//  Primary:  Twelve Data  — XAU/USD spot, ~15min delay, gratis
//  Backup:   OANDA API   — real-time spot (kalau credentials ada)
//
//  Twelve Data free tier: 800 req/day, 15min delay
//  Coverage: forex, metals (XAU/USD, XAG/USD), crypto, indices
// ======================================================
const https = require('https');
const { SimpleCache, Logger } = require('./utils');

const logger = new Logger('[candles]', 'info');

const TD_KEY = process.env.TWELVE_DATA_API_KEY;
const TD_BASE = 'api.twelvedata.com';

const tfCache = new SimpleCache(60, 50);

// ======================================================
//  HTTP helper
// ======================================================
function fetchJson(host, path, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host, path, method: 'GET', timeout: timeoutMs,
      headers: { 'User-Agent': 'Mozilla/5.0' }
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
//  Symbol mapping (Twelve Data)
// ======================================================
const TD_SYMBOLS = {
  xauusd: 'XAU/USD', gold: 'XAU/USD', xau: 'XAU/USD',
  xagusd: 'XAG/USD', silver: 'XAG/USD', xag: 'XAG/USD',
  eurusd: 'EUR/USD', gbpusd: 'GBP/USD', gbpjpy: 'GBP/JPY',
  usdjpy: 'USD/JPY', audusd: 'AUD/USD', nzdusd: 'NZD/USD',
  usdcad: 'USD/CAD', usdchf: 'USD/CHF',
  btcusd: 'BTC/USD', ethusd: 'ETH/USD',
  dxy: 'DXY', nasdaq: 'NDX', spx: 'SPX'
};

function resolveTD(input) {
  if (!input) return null;
  const k = String(input).toLowerCase().replace(/[^a-z]/g, '');
  return TD_SYMBOLS[k] || input.toUpperCase();
}

// ======================================================
//  Timeframe mapping (Twelve Data)
// ======================================================
const TD_INTERVALS = new Set(['1min', '2min', '3min', '5min', '10min', '15min', '30min', '45min', '1h', '2h', '4h', '1day', '1week']);

const TD_TF_MAP = {
  '1min': '1min', '5min': '5min', '10min': '10min',
  '15min': '15min', '30min': '30min', '45min': '45min',
  '1h': '1h', '2h': '2h', '4h': '4h',
  '1day': '1day', '1week': '1week'
};

// ======================================================
//  FETCHERS
// ======================================================

// Twelve Data (primary)
let tdTimestamps = [];
async function tdThrottle() {
  const now = Date.now();
  tdTimestamps = tdTimestamps.filter(t => now - t < 60000);
  if (tdTimestamps.length >= 7) {
    const waitMs = 60000 - (now - tdTimestamps[0]) + 100;
    await new Promise(r => setTimeout(r, waitMs));
    return tdThrottle();
  }
  tdTimestamps.push(now);
}

async function fetchTD(symbol, interval, outputsize) {
  if (!TD_INTERVALS.has(interval)) throw new Error(`TD no support ${interval}`);
  await tdThrottle();
  const sym = resolveTD(symbol);
  const path = `/time_series?symbol=${encodeURIComponent(sym)}&interval=${interval}&outputsize=${outputsize}&apikey=${TD_KEY}`;
  const data = await fetchJson(TD_BASE, path);
  if (data.status === 'error') throw new Error('TD: ' + (data.message || 'unknown'));
  const values = data.values || [];
  if (!values.length) throw new Error('TD: no data ' + sym);
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
//  Return: { candles, source, symbol, delay }
// ======================================================
async function getCandles(symbol, interval = '1h', outputsize = 100) {
  const r = await getCandlesWithMeta(symbol, interval, outputsize);
  return r.candles;
}

async function getCandlesWithMeta(symbol, interval = '1h', outputsize = 100) {
  if (!symbol) throw new Error('Symbol kosong');

  const cacheKey = `meta_${symbol}_${interval}_${outputsize}`;
  const cached = tfCache.get(cacheKey);
  if (cached) return cached;

  // Primary: Twelve Data (XAU/USD spot)
  if (TD_KEY) {
    try {
      const candles = await fetchTD(symbol, interval, outputsize);
      const result = {
        candles,
        source: 'twelvedata',
        symbol: resolveTD(symbol),
        delay: '~15min',
        timestamp: Date.now()
      };
      tfCache.set(cacheKey, result);
      logger.info(`[twelvedata] ${candles.length} candles ${resolveTD(symbol)} ${interval}`);
      return result;
    } catch (e) {
      logger.warn(`twelvedata failed: ${e.message}`);
    }
  }

  throw new Error('Twelve Data API key belum di-set atau request gagal');
}

async function getMultiTimeframe(symbol, tfs = ['1day', '4h', '1h', '15min'], outputsize = 100) {
  const results = {};
  for (const tf of tfs) {
    try {
      const r = await getCandlesWithMeta(symbol, tf, outputsize);
      results[tf] = r.candles;
    } catch (e) {
      logger.warn(`${symbol} ${tf}: ${e.message}`);
      results[tf] = [];
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return results;
}

// ======================================================
//  Real-time price (dari Twelve Data latest)
// ======================================================
async function getRealtimePrice(symbol = 'XAUUSD') {
  if (!TD_KEY) throw new Error('TWELVE_DATA_API_KEY belum di-set');
  const sym = resolveTD(symbol);
  const path = `/price?symbol=${encodeURIComponent(sym)}&apikey=${TD_KEY}`;
  const data = await fetchJson(TD_BASE, path);
  if (data.status === 'error') throw new Error(data.message || 'TD price error');
  return {
    price: num(data.price),
    timestamp: Date.now()
  };
}

module.exports = {
  getCandles,
  getCandlesWithMeta,
  getMultiTimeframe,
  getRealtimePrice,
  TD_SYMBOLS
};
