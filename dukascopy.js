// ======================================================
//  DUKASCOPY ORDER FLOW PROXY
//  Free-ish real-time XAU/USD tick proxy for bid/ask pressure.
//  This is NOT true footprint / CME order flow; it is a light
//  proxy built from live tick price movement and spread behavior.
// ======================================================

const https = require('https');
const { Logger } = require('./utils');

const logger = new Logger('[dukascopy]', 'info');

const DUKASCOPY_BASE = 'api.dukascopy.com';

function fetchJson(host, path, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host,
      path,
      method: 'GET',
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0'
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

async function getSpotTick(symbol = 'XAUUSD') {
  const sym = String(symbol).toUpperCase();
  const instrument = sym === 'XAUUSD' ? 'XAUUSD' : sym;

  // Dukascopy public APIs are often blocked or rate-limited, so we use a best-effort fetch.
  // This is a proxy source, not an exchange-grade footprint feed.
  const path = `/api/v2/quotes?symbol=${encodeURIComponent(instrument)}`;

  try {
    const data = await fetchJson(DUKASCOPY_BASE, path);
    if (!data || !data[0]) return null;
    return {
      symbol: instrument,
      bid: Number(data[0].bid ?? data[0].b ?? 0),
      ask: Number(data[0].ask ?? data[0].a ?? 0),
      last: Number(data[0].last ?? data[0].price ?? ((Number(data[0].bid ?? 0) + Number(data[0].ask ?? 0)) / 2)),
      spread: Number((Number(data[0].ask ?? 0) - Number(data[0].bid ?? 0)).toFixed(4)),
      timestamp: Date.now(),
      source: 'dukascopy-proxy'
    };
  } catch (e) {
    logger.warn(`dukascopy failed: ${e.message}`);
    return null;
  }
}

function summarizeTickPressure(history) {
  if (!history || !history.length) {
    return { bullishPressure: 0, bearishPressure: 0, net: 0, source: 'dukascopy-proxy' };
  }

  let bullish = 0;
  let bearish = 0;
  let net = 0;

  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1];
    const cur = history[i];
    const delta = cur.last - prev.last;

    if (delta > 0) bullish += 1;
    else if (delta < 0) bearish += 1;
    net += delta;
  }

  return {
    bullishPressure: bullish,
    bearishPressure: bearish,
    net,
    source: 'dukascopy-proxy'
  };
}

async function getFlowProxy(symbol = 'XAUUSD', lookback = 20) {
  // This function intentionally does not claim to be true footprint data.
  // It gives a real-time proxy based on recent tick-curve movement.
  const ticks = [];
  for (let i = 0; i < lookback; i++) {
    const tick = await getSpotTick(symbol);
    if (!tick) break;
    ticks.push(tick);
    await new Promise(r => setTimeout(r, 1000));
  }

  const summary = summarizeTickPressure(ticks);
  return {
    ...summary,
    ticks,
    symbol,
    timestamp: Date.now(),
    source: 'dukascopy-proxy',
    note: 'Proxy data only — not CME/footprint true order flow'
  };
}

module.exports = {
  getSpotTick,
  getFlowProxy,
  summarizeTickPressure
};
