// ======================================================
//  CANDLES PROVIDER — TRIPLE SOURCE
//  1. Twelve Data (TWELVE_DATA_API_KEY)  -> forex/crypto
//  2. Finnhub    (FINNHUB_API_KEY)       -> fallback
//  3. Yahoo Finance (gratis, tanpa key)  -> DXY, NDX, SPX,
//     silver, dll (yang tidak dicover dua provider di atas)
//  Kalau provider atas gagal, otomatis coba berikutnya.
// ======================================================
const https = require('https');
const { SimpleCache, Logger } = require('./utils');

const logger = new Logger('[candles]', 'info');

const TD_KEY = process.env.TWELVE_DATA_API_KEY;
const FH_KEY = process.env.FINNHUB_API_KEY;
const TD_BASE = 'api.twelvedata.com';
const FH_BASE = 'finnhub.io';

const tfCache = new SimpleCache(120, 50);

function fetchJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Parse gagal: ' + e.message)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
  });
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Symbol per provider
const TD_SYMBOLS = {
  xauusd: 'XAU/USD', gold: 'XAU/USD', xagusd: 'XAG/USD',
  eurusd: 'EUR/USD', gbpjpy: 'GBP/JPY',
  btcusd: 'BTC/USD', ethusd: 'ETH/USD',
  nasdaq: 'NDX', spx: 'SPX', dxy: 'DXY',
};
const FH_SYMBOLS = {
  xauusd: 'OANDA:XAU_USD', gold: 'OANDA:XAU_USD', xagusd: 'OANDA:XAG_USD',
  eurusd: 'OANDA:EUR_USD', gbpjpy: 'OANDA:GBP_JPY',
  btcusd: 'BINANCE:BTCUSDT', ethusd: 'BINANCE:ETHUSDT',
  nasdaq: 'US_NDX', spx: 'US_SPX', dxy: 'ICE_DX_Y',
};
const YH_SYMBOLS = {
  xauusd: 'GC=F', gold: 'GC=F', xagusd: 'SI=F',
  eurusd: 'EURUSD=X', gbpjpy: 'GBPJPY=X',
  btcusd: 'BTC-USD', ethusd: 'ETH-USD',
  nasdaq: '^NDX', spx: '^GSPC', dxy: 'DX-Y.NYB',
};
const SYMBOL_MAP = TD_SYMBOLS;

// Interval Twelve Data (sama dengan key TF_MAP)
const TD_INTERVALS = new Set(['1min', '2min', '3min', '5min', '15min', '30min', '45min', '1h', '2h', '4h', '1day', '1week']);
const FH_TF_MAP = {
  '1min': '1', '2min': '2', '3min': '3', '5min': '5', '15min': '15', '30min': '30', '45min': '45',
  '1h': '60', '2h': '120', '4h': '240', '1day': 'D', '1week': 'W',
};

function resolveSymbol(input) {
  if (!input) return null;
  const k = String(input).toLowerCase().replace(/[^a-z]/g, '');
  return SYMBOL_MAP[k] || input.toUpperCase();
}

// Throttle Twelve Data (free plan: 8 req/menit, pakai margin jadi 7)
let tdTimestamps = [];
async function tdThrottle() {
  const now = Date.now();
  tdTimestamps = tdTimestamps.filter(t => now - t < 60000);
  if (tdTimestamps.length >= 7) {
    const waitMs = 60000 - (now - tdTimestamps[0]) + 250;
    logger.info(`Twelve Data mendekati limit, antri ${Math.ceil(waitMs / 1000)}s...`);
    await new Promise(r => setTimeout(r, waitMs));
    return tdThrottle();
  }
  tdTimestamps.push(Date.now());
}

// ---------- Twelve Data ----------
async function fetchTD(symbol, interval, outputsize) {
  await tdThrottle();
  const sym = TD_SYMBOLS[symbol] || symbol.toUpperCase();
  const itv = TD_INTERVALS.has(interval) ? interval : '1h';
  const url = `https://${TD_BASE}/time_series?symbol=${encodeURIComponent(sym)}&interval=${itv}&outputsize=${outputsize}&apikey=${TD_KEY}`;
  const data = await fetchJson(url);
  if (data.status === 'error' || (data.code && data.code >= 400) || !data.values || !data.values.length) {
    throw new Error('Twelve Data: ' + (data.message || `Tidak ada data ${sym} ${itv}`));
  }
  // values urut terbaru -> terlama, balik jadi lama -> baru
  return data.values.reverse().map(v => ({
    openTime: new Date(v.datetime.replace(' ', 'T') + 'Z').getTime(),
    open: num(v.open), high: num(v.high), low: num(v.low),
    close: num(v.close), volume: num(v.volume) || 0,
  })).filter(c => c.close !== null);
}

// ---------- Finnhub ----------
async function fetchFH(symbol, interval, outputsize) {
  const sym = FH_SYMBOLS[symbol] || symbol.toUpperCase();
  const resolution = FH_TF_MAP[interval] || '60';
  const now = Math.floor(Date.now() / 1000);
  const secondsPerBar = parseInt(resolution) * 60 || 86400;
  const from = now - secondsPerBar * outputsize;
  const url = `https://${FH_BASE}/api/v1/stock/candle?symbol=${encodeURIComponent(sym)}&resolution=${resolution}&from=${from}&to=${now}&token=${FH_KEY}`;
  const data = await fetchJson(url);
  if (data.error) throw new Error('Finnhub: ' + data.error);
  if (data.s !== 'ok' || !data.t || !data.t.length) {
    throw new Error(`Finnhub: Tidak ada data candles untuk ${sym} ${interval}`);
  }
  const candles = [];
  for (let i = 0; i < data.t.length; i++) {
    candles.push({
      openTime: data.t[i] * 1000,
      open: num(data.o[i]), high: num(data.h[i]),
      low: num(data.l[i]), close: num(data.c[i]),
      volume: num(data.v[i]) || 0,
    });
  }
  return candles;
}

// ---------- Yahoo Finance (fallback ke-3, gratis tanpa key) ----------
const YH_TF_MAP = {
  '1min': { interval: '1m', range: '5d' },
  '5min': { interval: '5m', range: '1mo' },
  '15min': { interval: '15m', range: '1mo' },
  '30min': { interval: '30m', range: '2mo' },
  '45min': { interval: '60m', range: '3mo' },
  '1h': { interval: '1h', range: '3mo' },
  '2h': { interval: '1h', range: '6mo' },
  '4h': { interval: '1h', range: '1y' },
  '1day': { interval: '1d', range: '1y' },
  '1week': { interval: '1wk', range: '2y' },
};

async function fetchYH(symbol, interval, outputsize) {
  const sym = YH_SYMBOLS[symbol] || symbol.toUpperCase();
  const tf = YH_TF_MAP[interval] || YH_TF_MAP['1h'];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${tf.interval}&range=${tf.range}`;
  const data = await fetchJson(url);
  const result = data.chart && data.chart.result && data.chart.result[0];
  if (!result || !result.timestamp || !result.timestamp.length) {
    const err = data.chart && data.chart.error;
    throw new Error('Yahoo: ' + ((err && err.description) || `Tidak ada data ${sym} ${interval}`));
  }
  const q = result.indicators.quote[0];
  const candles = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    if (q.close[i] === null || q.close[i] === undefined) continue;
    candles.push({
      openTime: result.timestamp[i] * 1000,
      open: num(q.open[i]), high: num(q.high[i]),
      low: num(q.low[i]), close: num(q.close[i]),
      volume: num(q.volume[i]) || 0,
    });
  }
  if (!candles.length) throw new Error(`Yahoo: Tidak ada data valid ${sym} ${interval}`);
  // potong supaya tidak lebih dari yang diminta
  return candles.slice(-outputsize);
}

async function getCandles(symbol, interval = '1h', outputsize = 100) {
  if (!symbol) throw new Error('Symbol kosong');

  const cacheKey = `${symbol}_${interval}_${outputsize}`;
  const cached = tfCache.get(cacheKey);
  if (cached) return cached;

  const errors = [];
  if (TD_KEY) {
    try {
      const candles = await fetchTD(symbol, interval, outputsize);
      tfCache.set(cacheKey, candles);
      logger.info(`[twelvedata] ${candles.length} candles ${symbol} ${interval}`);
      return candles;
    } catch (e) { errors.push(e.message); }
  }
  if (FH_KEY) {
    try {
      const candles = await fetchFH(symbol, interval, outputsize);
      tfCache.set(cacheKey, candles);
      logger.info(`[finnhub] ${candles.length} candles ${symbol} ${interval}`);
      return candles;
    } catch (e) { errors.push(e.message); }
  }
  try {
    const candles = await fetchYH(symbol, interval, outputsize);
    tfCache.set(cacheKey, candles);
    logger.info(`[yahoo] ${candles.length} candles ${symbol} ${interval}`);
    return candles;
  } catch (e) { errors.push(e.message); }

  if (!TD_KEY && !FH_KEY) {
    throw new Error('TWELVE_DATA_API_KEY dan FINNHUB_API_KEY belum di-set di .env');
  }
  throw new Error(errors.join(' | ') || 'Tidak ada data candles');
}

async function getMultiTimeframe(symbol, tfs = ['1day', '4h', '1h', '15min'], outputsize = 100) {
  const results = {};
  for (const tf of tfs) {
    try {
      results[tf] = await getCandles(symbol, tf, outputsize);
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
  getMultiTimeframe,
  resolveSymbol,
  SYMBOL_MAP,
};
