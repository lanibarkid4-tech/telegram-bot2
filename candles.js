// ======================================================
//  CANDLES PROVIDER — MetaAPI.cloud ONLY
//  Endpoint: https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai
//  Auth: Bearer {METAAPI_TOKEN}
//  Account: {METAAPI_ACCOUNT_ID}
//
//  Catatan: MetaAPI butuh MT4/MT5 account yang sudah di-deploy.
//  Setup:
//    1. Daftar di https://app.metaapi.cloud (free tier: 100k CU/bulan)
//    2. Tambah MT5 broker account (paper trading atau real)
//    3. Deploy account (tunggu status DEPLOYED)
//    4. Copy METAAPI_TOKEN dan METAAPI_ACCOUNT_ID ke .env Railway
// ======================================================
const https = require('https');
const { SimpleCache, Logger } = require('./utils');

const logger = new Logger('[metaapi]', 'info');

const METAAPI_TOKEN = process.env.METAAPI_TOKEN;
const METAAPI_ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID;
const METAAPI_BASE = 'mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai';
const METAAPI_DATA_BASE = 'mt-market-data-client-v1.agiliumtrade.agiliumtrade.ai';

const tfCache = new SimpleCache(60, 50);

// ======================================================
//  HTTP helpers
// ======================================================
function httpsRequest(host, path, method = 'GET', timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host,
      path,
      method,
      timeout: timeoutMs,
      headers: {
        'Authorization': 'Bearer ' + METAAPI_TOKEN,
        'Content-Type': 'application/json',
        'User-Agent': 'telegram-bot-xauusd/1.0'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 204) return resolve(null);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { resolve(data); }
        } else {
          reject(new Error(`MetaAPI ${res.statusCode}: ${data.slice(0, 300)}`));
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
//  TF mapping
//  MetaAPI format: "1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"
//  Bot internal: "1min", "5min", "15min", "30min", "1h", "4h", "1day", "1week"
// ======================================================
const TF_MAP = {
  '1min': '1m', '2min': '2m', '3min': '3m', '5min': '5m',
  '10min': '10m', '15min': '15m', '30min': '30m', '45min': '45m',
  '1h': '1h', '2h': '2h', '3h': '3h', '4h': '4h', '6h': '6h', '8h': '8h', '12h': '12h',
  '1day': '1d', '1week': '1w', '1month': '1mn'
};

// Symbol mapping — MetaAPI pake format broker
// XAUUSD default adalah spot gold (mayoritas broker MT5)
const SYMBOL_MAP = {
  xauusd: 'XAUUSD',
  gold: 'XAUUSD',
  xau: 'XAUUSD',
  xagusd: 'XAGUSD',
  silver: 'XAGUSD',
  eurusd: 'EURUSD',
  gbpjpy: 'GBPJPY',
  gbpusd: 'GBPUSD',
  usdjpy: 'USDJPY',
  audusd: 'AUDUSD',
  nzdusd: 'NZDUSD',
  usdcad: 'USDCAD',
  usdchf: 'USDCHF',
  btcusd: 'BTCUSD',
  btcusdt: 'BTCUSDT',
  ethusd: 'ETHUSD',
  ethusdt: 'ETHUSDT',
  dxy: 'DXY',
  nasdaq: 'NAS100',
  spx: 'SPX500',
  us30: 'US30'
};

function resolveSymbol(input) {
  if (!input) return null;
  const k = String(input).toLowerCase().replace(/[^a-z]/g, '');
  return SYMBOL_MAP[k] || input.toUpperCase();
}

// ======================================================
//  Check account status (harus DEPLOYED)
// ======================================================
let accountCheckPromise = null;
async function ensureAccountReady() {
  if (!METAAPI_TOKEN || !METAAPI_ACCOUNT_ID) {
    throw new Error('METAAPI_TOKEN atau METAAPI_ACCOUNT_ID belum di-set di Railway Variables. Daftar di https://app.metaapi.cloud');
  }
  if (accountCheckPromise) return accountCheckPromise;

  accountCheckPromise = (async () => {
    const acc = await httpsRequest(
      METAAPI_BASE,
      `/users/current/accounts/${METAAPI_ACCOUNT_ID}`
    );
    if (!acc) throw new Error('MetaAPI: account tidak ditemukan');
    if (acc.state !== 'DEPLOYED') {
      throw new Error(`MetaAPI account belum DEPLOYED (state: ${acc.state}). Tunggu deploy selesai.`);
    }
    logger.info(`Account ${acc.login} @ ${acc.server} ready (${acc.type}, ${acc.region})`);
    return acc;
  })().catch(e => {
    accountCheckPromise = null; // reset untuk retry
    throw e;
  });

  return accountCheckPromise;
}

// ======================================================
//  Fetch historical candles
//  Endpoint: /users/current/accounts/{accountId}/historical-market-data/symbols/{symbol}/timeframes/{tf}/candles
// ======================================================
async function fetchMetaAPI(symbol, interval, outputsize) {
  await ensureAccountReady();

  const sym = resolveSymbol(symbol);
  const tf = TF_MAP[interval] || '1h';

  const startTime = new Date(Date.now() - outputsize * 60 * 60 * 1000 * 1.5); // 1.5x buffer
  const params = `?startTime=${startTime.toISOString()}&limit=${Math.min(outputsize, 5000)}`;

  const path = `/users/current/accounts/${METAAPI_ACCOUNT_ID}/historical-market-data/symbols/${sym}/timeframes/${tf}/candles${params}`;

  const data = await httpsRequest(METAAPI_DATA_BASE, path);

  if (!data || !Array.isArray(data) || data.length === 0) {
    throw new Error(`MetaAPI: tidak ada data ${sym} ${tf}. Pastikan symbol ada di broker lo.`);
  }

  return data.map(c => {
    // MetaAPI returns: { time, open, high, low, close, tickVolume, volume, spread }
    const ts = typeof c.time === 'string' ? new Date(c.time).getTime() : c.time;
    return {
      openTime: ts,
      open: num(c.open),
      high: num(c.high),
      low: num(c.low),
      close: num(c.close),
      volume: num(c.volume) || num(c.tickVolume) || 0
    };
  }).filter(c => c.open !== null && c.close !== null);
}

// ======================================================
//  Public API
// ======================================================
async function getCandles(symbol, interval = '1h', outputsize = 100) {
  if (!symbol) throw new Error('Symbol kosong');

  const cacheKey = `${symbol}_${interval}_${outputsize}`;
  const cached = tfCache.get(cacheKey);
  if (cached) return cached;

  const candles = await fetchMetaAPI(symbol, interval, outputsize);
  tfCache.set(cacheKey, candles);
  logger.info(`[metaapi] ${candles.length} candles ${symbol} ${interval}`);
  return candles;
}

async function getMultiTimeframe(symbol, tfs = ['1day', '4h', '1h', '15m'], outputsize = 100) {
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

// ======================================================
//  Account info (untuk /status)
// ======================================================
async function getAccountInfo() {
  try {
    return await ensureAccountReady();
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = {
  getCandles,
  getMultiTimeframe,
  resolveSymbol,
  getAccountInfo,
  // back-compat
  TD_SYMBOLS: SYMBOL_MAP,
  FH_SYMBOLS: SYMBOL_MAP,
  YH_SYMBOLS: SYMBOL_MAP
};
