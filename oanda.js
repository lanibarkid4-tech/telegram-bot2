// ======================================================
//  📡 OANDA API — Real-time XAU/USD spot data
//  Docs: https://developer.oanda.com/rest-live-v20/introduction
//
//  Env vars:
//    OANDA_TOKEN      — API token (bisa practice atau live)
//    OANDA_ACCOUNT_ID — Account ID
//    OANDA_ENV        — "practice" (default) atau "live"
//
//  Free tier practice: 25 req/sec, real-time streaming
//  Endpoints:
//    GET /v3/instruments/{instrument}/candles  — OHLC history
//    GET /v3/accounts/{accountId}/pricing      — real-time bid/ask
// ======================================================
const axios = require('axios');

const TOKEN = process.env.OANDA_TOKEN;
const ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;
const ENV = process.env.OANDA_ENV || 'practice';

const BASE_URL = ENV === 'live'
  ? 'https://api-fxtrade.oanda.com/v3'
  : 'https://api-fxpractice.oanda.com/v3';

const TIMEFRAME_MAP = {
  M1: 'M1', M2: 'M2', M3: 'M3', M4: 'M4', M5: 'M5',
  M10: 'M10', M15: 'M15', M30: 'M30',
  H1: 'H1', H2: 'H2', H3: 'H3', H4: 'H4', H6: 'H6', H8: 'H8', H12: 'H12',
  D: 'D', W: 'W', M: 'M'
};

// Internal TF (bot pakai "1min", "5min", dll) → OANDA format
const TF_TO_OANDA = {
  '1min': 'M1', '2min': 'M2', '3min': 'M3', '4min': 'M4', '5min': 'M5',
  '10min': 'M10', '15min': 'M15', '30min': 'M30', '45min': 'M30',
  '1h': 'H1', '2h': 'H2', '3h': 'H3', '4h': 'H4', '6h': 'H6', '8h': 'H8', '12h': 'H12',
  '1day': 'D', '1week': 'W', '1month': 'M'
};

const client = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
  headers: {
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    'User-Agent': 'telegram-bot-xauusd/1.0'
  }
});

function checkCreds() {
  if (!TOKEN) throw new Error('OANDA_TOKEN belum di-set di Railway Variables. Daftar di https://developer.oanda.com');
  if (!ACCOUNT_ID) throw new Error('OANDA_ACCOUNT_ID belum di-set di Railway Variables');
}

// ======================================================
//  Ambil data candle (OHLC)
//  symbol: "XAU_USD" (OANDA format)
//  tf: "M5" / "H1" / "D" dll
//  count: jumlah candle (max 5000)
// ======================================================
async function getCandles(symbol = 'XAU_USD', tf = 'M5', count = 200) {
  checkCreds();
  const url = `/instruments/${symbol}/candles`;
  const res = await client.get(url, {
    params: { granularity: TIMEFRAME_MAP[tf] || tf, count }
  });

  if (!res.data || !res.data.candles) {
    throw new Error('Oanda: no data ' + symbol);
  }

  return res.data.candles.map(c => ({
    time: c.time,                          // ISO string
    openTime: new Date(c.time).getTime(),  // ms timestamp
    open: parseFloat(c.mid.o),
    high: parseFloat(c.mid.h),
    low: parseFloat(c.mid.l),
    close: parseFloat(c.mid.c),
    volume: parseInt(c.volume) || 0,
    complete: c.complete
  }));
}

// ======================================================
//  Ambil harga real-time (bid/ask streaming-like via polling)
//  symbol: "XAU_USD"
// ======================================================
async function getRealtimePrice(symbol = 'XAU_USD') {
  checkCreds();
  const url = `/accounts/${ACCOUNT_ID}/pricing`;
  const res = await client.get(url, {
    params: { instruments: symbol }
  });

  if (!res.data || !res.data.prices || !res.data.prices.length) {
    throw new Error('Oanda: no price for ' + symbol);
  }

  const p = res.data.prices[0];
  return {
    symbol: p.instrument,
    bid: parseFloat(p.bids[0].price),
    ask: parseFloat(p.asks[0].price),
    mid: (parseFloat(p.bids[0].price) + parseFloat(p.asks[0].price)) / 2,
    spread: parseFloat(p.asks[0].price) - parseFloat(p.bids[0].price),
    time: p.time
  };
}

// ======================================================
//  Helper: convert internal TF (1min, 5min, dll) → OANDA
// ======================================================
function tfToOanda(tf) {
  return TF_TO_OANDA[tf] || tf;
}

// ======================================================
//  Account info
// ======================================================
async function getAccountInfo() {
  checkCreds();
  const res = await client.get(`/accounts/${ACCOUNT_ID}`);
  return res.data.account;
}

module.exports = {
  getCandles,
  getRealtimePrice,
  getAccountInfo,
  tfToOanda,
  BASE_URL,
  ENV
};
