// ======================================================
//  ORDER FLOW PROXY — OANDA (free with account)
//  Uses tick volume as proxy for market activity.
//  Approximates buying/selling pressure via candle direction.
// ======================================================

const https = require('https');
const { SimpleCache, Logger } = require('./utils');

const logger = new Logger('[orderflow]', 'info');

const OANDA_API_KEY = process.env.OANDA_API_KEY;
const OANDA_ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;
const OANDA_BASE = 'api-fxtrade.oanda.com';

const cache = new SimpleCache(30, 20); // 30 seconds cache

// Timeframe mapping for OANDA
const OANDA_TF_MAP = {
  '1min': 'M1',
  '5min': 'M5',
  '15min': 'M15',
  '30min': 'M30',
  '1h': 'H1',
  '4h': 'H4',
  '6h': '6H',
  '12h': '12H',
  '1day': 'D',
  '1week': 'W'
};

function fetchJson(host, path, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!OANDA_API_KEY || !OANDA_ACCOUNT_ID) {
      return reject(new Error('OANDA credentials not set'));
    }
    const req = https.request({
      host,
      path,
      method: 'GET',
      timeout: timeoutMs,
      headers: {
        'Authorization': `Bearer ${OANDA_API_KEY}`,
        'Content-Type': 'application/json'
      }
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

async function fetchOandaCandles(symbol, interval, count = 100) {
  const oandaInterval = OANDA_TF_MAP[interval];
  if (!oandaInterval) throw new Error(`OANDA no support ${interval}`);

  // OANDA instrument format: XAU_USD for gold
  const instrument = symbol.toUpperCase().replace('/', '_');
  const path = `/v3/instruments/${instrument}/candles?price=mid&granularity=${oandaInterval}&count=${count}`;

  const data = await fetchJson(OANDA_BASE, path);
  if (!data.candles || !data.candles.length) {
    throw new Error('OANDA: no candle data');
  }

  return data.candles.map(c => ({
    time: new Date(c.time).getTime(),
    open: parseFloat(c.mid.o),
    high: parseFloat(c.mid.h),
    low: parseFloat(c.mid.l),
    close: parseFloat(c.mid.c),
    volume: parseInt(c.volume, 10) // tick volume
  }));
}

// Compute order flow metrics from candles
function computeOrderFlow(candles) {
  let bullishVolume = 0;
  let bearishVolume = 0;
  let cumulativeDelta = 0;
  const deltas = [];

  for (const c of candles) {
    const delta = c.close > c.open ? c.volume : (c.close < c.open ? -c.volume : 0);
    bullishVolume += c.close > c.open ? c.volume : 0;
    bearishVolume += c.close < c.open ? c.volume : 0;
    cumulativeDelta += delta;
    deltas.push(delta);
  }

  return {
    bullishVolume,
    bearishVolume,
    delta: deltas[deltas.length - 1] || 0,
    cumulativeDelta,
    volume: bullishVolume + bearishVolume,
    candles: candles
  };
}

// Public API
async function getOrderFlow(symbol = 'XAU/USD', interval = '5min', count = 100) {
  const cacheKey = `of_${symbol}_${interval}_${count}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const candles = await fetchOandaCandles(symbol, interval, count);
    const of = computeOrderFlow(candles);
    const result = {
      ...of,
      symbol,
      interval,
      timestamp: Date.now(),
      source: 'oanda'
    };
    cache.set(cacheKey, result);
    logger.info(`[oanda] order flow ${symbol} ${interval}: ${result.volume} ticks`);
    return result;
  } catch (e) {
    logger.warn(`orderflow failed: ${e.message}`);
    // Return empty structure to avoid breaking downstream
    return {
      bullishVolume: 0,
      bearishVolume: 0,
      delta: 0,
      cumulativeDelta: 0,
      volume: 0,
      symbol,
      interval,
      timestamp: Date.now(),
      source: 'oanda',
      error: e.message
    };
  }
}

module.exports = { getOrderFlow };