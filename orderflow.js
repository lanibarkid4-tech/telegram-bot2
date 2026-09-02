// ======================================================
//  📊 ORDERFLOW XAUUSDT - BINANCE
// ======================================================
//  Modul ini mengambil data orderflow real-time XAUUSDT
//  dari Binance Spot + Futures (USDT-M):
//
//  - Order Book Depth (top 20 bids/asks)
//  - Agg Trades (last N executed trades -> Delta, Volume Buy/Sell)
//  - CVD (Cumulative Volume Delta)
//  - Taker Buy/Sell ratio
//  - Open Interest (Futures)
//  - Large trade detection (whale trades)
//
//  Semua endpoint publik (tanpa API key).
// ======================================================

const https = require('https');

// Base URL Binance (punya fallback kalau region-restricted)
// Catatan: XAUUSDT hanya ada di Binance Spot & Futures, tapi beberapa region
// (US, UK) membatasi akses ke api.binance.com. fallback data-api.binance.vision
// untuk futures (tidak ada untuk spot XAUUSDT di beberapa region).
const HOSTS = {
  spot: [
    'api.binance.com',
    'api1.binance.com',
    'api2.binance.com',
    'api3.binance.com',
    'api-gcp.binance.com',
    'data-api.binance.vision'
  ],
  fapi: [
    'fapi.binance.com',
    'fapi1.binance.com',
    'fapi2.binance.com',
    'fapi3.binance.com',
    'fapi-gcp.binance.com',
    'data-api.binance.vision'
  ]
};

// Bybit public REST endpoints (backup kalau Binance region-restricted)
const BYBIT_HOST = 'api.bybit.com';
// Bybit V5 unified trading symbols: XAUUSDT di linear (USDT perp)
const BYBIT_SYMBOL = 'XAUUSDT';

// Symbol default
const SYMBOL = 'XAUUSDT';

// Log untuk verifikasi deploy
console.log('📦 [orderflow] Module loaded - VERSION futures-fix-v2');
console.log('📦 [orderflow] HOSTS.spot[0]:', HOSTS.spot[0]);
console.log('📦 [orderflow] HOSTS.fapi[0]:', HOSTS.fapi[0]);

// ======================================================
//  HTTP HELPER (dengan fallback host + retry)
// ======================================================
function httpsGet(host, path, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host, path, method: 'GET', timeout, headers: { 'User-Agent': 'Mozilla/5.0' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode} on ${host}${path}: ${data.slice(0, 120)}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`JSON parse error: ${data.slice(0, 120)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`Timeout ${host}${path}`));
    });
    req.end();
  });
}

async function fetchWithFallback(type, path, timeoutMs = 6000) {
  const hosts = HOSTS[type];
  let lastErr;
  for (const h of hosts) {
    try {
      const result = await httpsGet(h, path, timeoutMs);
      console.log(`✓ [orderflow] ${type} ${h}${path.split('?')[0]}: OK`);
      return result;
    } catch (e) {
      console.warn(`⚠️ [orderflow] ${type} ${h}${path.split('?')[0]}: ${e.message}`);
      lastErr = e;
    }
  }
  // fallback ke Bybit kalau Binance gagal semua (hanya untuk linear/futures)
  if (type === 'fapi') {
    try {
      console.log(`↪️ [orderflow] Binance fapi semua gagal, mencoba Bybit fallback...`);
      const bybitPath = mapBinancePathToBybit(path);
      if (bybitPath) {
        const result = await httpsGet(BYBIT_HOST, bybitPath, timeoutMs);
        const norm = normalizeBybit(result, path);
        console.log(`✓ [orderflow] Bybit ${BYBIT_HOST}${bybitPath.split('?')[0]}: OK`);
        return norm;
      }
    } catch (e) {
      console.warn(`⚠️ [orderflow] Bybit fallback juga gagal: ${e.message}`);
      lastErr = e;
    }
  }
  throw lastErr || new Error(`All ${type} hosts failed for ${path}`);
}

// Mapping path Binance -> Bybit V5 (linear=XAUUSDT futures)
function mapBinancePathToBybit(path) {
  // /fapi/v1/depth?symbol=XAUUSDT&limit=20 -> /v5/market/orderbook?category=linear&symbol=XAUUSDT&limit=20
  if (path.startsWith('/fapi/v1/depth')) {
    const sp = new URLSearchParams(path.split('?')[1] || '');
    sp.set('category', 'linear');
    return `/v5/market/orderbook?${sp.toString()}`;
  }
  // /fapi/v1/aggTrades?symbol=XAUUSDT&limit=500 -> /v5/market/recent-trade?category=linear&symbol=XAUUSDT&limit=500
  if (path.startsWith('/fapi/v1/aggTrades')) {
    const sp = new URLSearchParams(path.split('?')[1] || '');
    sp.set('category', 'linear');
    // Bybit limit max 1000, default 500
    if (!sp.get('limit')) sp.set('limit', '500');
    return `/v5/market/recent-trade?${sp.toString()}`;
  }
  // /fapi/v1/ticker/24hr -> /v5/market/tickers?category=linear&symbol=XAUUSDT
  if (path.startsWith('/fapi/v1/ticker/24hr')) {
    const sp = new URLSearchParams(path.split('?')[1] || '');
    sp.set('category', 'linear');
    return `/v5/market/tickers?${sp.toString()}`;
  }
  // /fapi/v1/openInterest -> /v5/market/open-interest?category=linear&symbol=XAUUSDT&intervalTime=5min
  if (path.startsWith('/fapi/v1/openInterest')) {
    const sp = new URLSearchParams(path.split('?')[1] || '');
    sp.set('category', 'linear');
    sp.set('intervalTime', '5min');
    return `/v5/market/open-interest?${sp.toString()}`;
  }
  return null; // tidak didukung
}

// Normalisasi response Bybit -> mirip format Binance
function normalizeBybit(bybit, originalPath) {
  if (!bybit || bybit.retCode !== 0) {
    throw new Error(`Bybit error: ${bybit?.retMsg || 'unknown'}`);
  }
  const r = bybit.result;
  // /depth
  if (originalPath.startsWith('/fapi/v1/depth')) {
    return { bids: r.b, asks: r.a };
  }
  // /aggTrades
  if (originalPath.startsWith('/fapi/v1/aggTrades')) {
    // Bybit recent-trade: {list: [{execId, symbol, price, qty, side, time}]}
    // Binance aggTrades: [{a, p, q, T, m, ...}]  m=true = buyer is maker, false = taker is buyer
    return (r.list || []).map((t) => ({
      a: t.execId,
      p: t.price,
      q: t.qty,
      T: parseInt(t.time),
      // Bybit side 'Buy' = taker buy. Untuk Binance m: false berarti taker is buyer.
      m: t.side !== 'Buy',
    }));
  }
  // /ticker/24hr
  if (originalPath.startsWith('/fapi/v1/ticker/24hr')) {
    const x = (r.list && r.list[0]) || {};
    return {
      lastPrice: x.lastPrice,
      priceChangePercent: x.price24hPcnt ? (parseFloat(x.price24hPcnt) * 100).toString() : '0',
      highPrice: x.highPrice24h,
      lowPrice: x.lowPrice24h,
      volume: x.volume24h,
      quoteVolume: x.turnover24h,
      count: x.trades24h ? String(parseInt(x.trades24h)) : '0',
    };
  }
  // /openInterest -> Bybit return object with list[{openInterest, ...}]
  if (originalPath.startsWith('/fapi/v1/openInterest')) {
    const x = (r.list && r.list[0]) || {};
    return { openInterest: x.openInterest, time: x.timestamp };
  }
  return r;
}

// ======================================================
//  1. ORDER BOOK DEPTH (top 20)
// ======================================================
// Catatan: XAUUSDT hanya ada di Binance FUTURES (USDT-M), tidak di Spot.
// Jadi pakai futures endpoint /fapi/v1/depth (format sama: bids/asks).
async function getOrderBook(symbol = SYMBOL, limit = 20) {
  const data = await fetchWithFallback('fapi', `/fapi/v1/depth?symbol=${symbol}&limit=${limit}`);
  const bids = data.bids.map((b) => ({ price: parseFloat(b[0]), qty: parseFloat(b[1]) }));
  const asks = data.asks.map((a) => ({ price: parseFloat(a[0]), qty: parseFloat(a[1]) }));

  // Hitung total bid/ask dalam 20 level (volume & value approx)
  let bidVol = 0, askVol = 0;
  bids.forEach((b) => (bidVol += b.qty));
  asks.forEach((a) => (askVol += a.qty));

  const bestBid = bids[0]?.price || 0;
  const bestAsk = asks[0]?.price || 0;
  const spread = bestAsk - bestBid;
  const midPrice = (bestBid + bestAsk) / 2;
  const imbalance = bidVol + askVol > 0 ? ((bidVol - askVol) / (bidVol + askVol)) * 100 : 0;

  return {
    symbol,
    bids,
    asks,
    bestBid,
    bestAsk,
    spread,
    spreadPct: midPrice > 0 ? (spread / midPrice) * 100 : 0,
    midPrice,
    bidVol,
    askVol,
    imbalance, // positif = lebih banyak bid (buyer dominan)
  };
}

// ======================================================
//  2. AGG TRADES (executed trades aggregated)
// ======================================================
async function getAggTrades(symbol = SYMBOL, limit = 500) {
  // Gunakan futures aggTrades karena XAUUSDT hanya di futures
  const data = await fetchWithFallback('fapi', `/fapi/v1/aggTrades?symbol=${symbol}&limit=${limit}`);

  let buyVol = 0, sellVol = 0;
  let buyCount = 0, sellCount = 0;
  let buyValue = 0, sellValue = 0;
  const trades = [];

  for (const t of data) {
    const price = parseFloat(t.p);
    const qty = parseFloat(t.q);
    const value = price * qty;
    // Taker buy = buyer is taker (m significa buyer initiated). false = seller is taker.
    const isBuy = !t.m;
    trades.push({
      time: t.T,
      price,
      qty,
      value,
      isBuy,
    });
    if (isBuy) {
      buyVol += qty;
      buyValue += value;
      buyCount++;
    } else {
      sellVol += qty;
      sellValue += value;
      sellCount++;
    }
  }

  const totalVol = buyVol + sellVol;
  const delta = buyVol - sellVol;
  const buyPct = totalVol > 0 ? (buyVol / totalVol) * 100 : 50;
  const sellPct = 100 - buyPct;

  return {
    symbol,
    totalTrades: data.length,
    buyCount,
    sellCount,
    buyVol,
    sellVol,
    buyValue,
    sellValue,
    delta,
    buyPct,
    sellPct,
    trades, // raw trades (untuk deteksi whale)
  };
}

// ======================================================
//  3. CVD (Cumulative Volume Delta) - snapshot rolling
// ======================================================
async function getCVD(symbol = SYMBOL, windowMinutes = 60) {
  // Ambil 1000 trades terakhir lalu filter berdasarkan window (futures)
  const data = await fetchWithFallback('fapi', `/fapi/v1/aggTrades?symbol=${symbol}&limit=1000`);
  const now = Date.now();
  const cutoff = now - windowMinutes * 60 * 1000;

  let cvd = 0;
  const series = []; // [{time, cvd, delta}]
  let prevBucket = 0;

  // Bucket per 1 menit
  const buckets = new Map();

  for (const t of data) {
    const time = t.T;
    if (time < cutoff) continue;
    const qty = parseFloat(t.q);
    const delta = t.m ? -qty : qty;
    cvd += delta;
    const bucket = Math.floor(time / 60000) * 60000;
    if (!buckets.has(bucket)) buckets.set(bucket, 0);
    buckets.set(bucket, buckets.get(bucket) + delta);
  }

  // Convert ke sorted array, hitung CVD kumulatif
  const sortedBuckets = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  let runningCVD = 0;
  for (const [bucket, deltaBucket] of sortedBuckets) {
    runningCVD += deltaBucket;
    series.push({
      time: bucket,
      delta: deltaBucket,
      cvd: runningCVD,
    });
  }

  // Trend CVD: slope sederhana (last - first) / count
  let trend = 'FLAT';
  if (series.length >= 4) {
    const first = series[Math.floor(series.length / 4)].cvd;
    const last = series[series.length - 1].cvd;
    const diff = last - first;
    if (diff > 0.5) trend = 'BULLISH ▲';
    else if (diff < -0.5) trend = 'BEARISH ▼';
  }

  return {
    symbol,
    windowMinutes,
    finalCVD: cvd,
    trend,
    buckets: series.length,
    series: series.slice(-30), // 30 menit terakhir
  };
}

// ======================================================
//  4. WHALE TRADES (large executed trades)
// ======================================================
function detectWhales(trades, minValueUSD = 50000) {
  const whales = [];
  for (const t of trades) {
    if (t.value >= minValueUSD) {
      whales.push({
        time: new Date(t.time).toISOString(),
        price: t.price,
        qty: t.qty,
        value: t.value,
        side: t.isBuy ? 'BUY 🟢' : 'SELL 🔴',
      });
    }
  }
  return whales.sort((a, b) => b.value - a.value).slice(0, 10); // top 10
}

// ======================================================
//  5. OPEN INTEREST (Futures USDT-M)
// ======================================================
async function getOpenInterest(symbol = SYMBOL) {
  try {
    const data = await fetchWithFallback('fapi', `/fapi/v1/openInterest?symbol=${symbol}`);
    return {
      symbol,
      openInterest: parseFloat(data.openInterest),
      time: data.time,
    };
  } catch (e) {
    return { symbol, openInterest: null, error: e.message };
  }
}

// ======================================================
//  6. 24h TICKER (vol, change%, high, low)
// ======================================================
async function get24hTicker(symbol = SYMBOL) {
  // Pakai futures 24hr ticker karena XAUUSDT hanya di futures
  const data = await fetchWithFallback('fapi', `/fapi/v1/ticker/24hr?symbol=${symbol}`);
  return {
    symbol,
    last: parseFloat(data.lastPrice),
    changePct: parseFloat(data.priceChangePercent),
    high: parseFloat(data.highPrice),
    low: parseFloat(data.lowPrice),
    volume: parseFloat(data.volume),
    quoteVolume: parseFloat(data.quoteVolume),
    trades: data.count,
  };
}

// ======================================================
//  7. FULL ORDERFLOW SNAPSHOT (kombinasi semua)
// ======================================================
async function getFullOrderflow(symbol = SYMBOL) {
  console.log(`📊 [orderflow] getFullOrderflow(${symbol}) - module VERSION: futures-fix-v2`);
  const [book, agg, cvd, ticker, oi] = await Promise.all([
    getOrderBook(symbol, 20),
    getAggTrades(symbol, 500),
    getCVD(symbol, 60),
    get24hTicker(symbol),
    getOpenInterest(symbol),
  ]);

  const whales = detectWhales(agg.trades, 50000);

  // Delta divergence check: delta positif tapi harga turun (atau sebaliknya)
  let divergence = null;
  if (agg.delta > 0 && ticker.changePct < -0.1) divergence = 'BULLISH DIVERGENCE ⚠️ (delta+ harga-)';
  else if (agg.delta < 0 && ticker.changePct > 0.1) divergence = 'BEARISH DIVERGENCE ⚠️ (delta- harga+)';

  return {
    symbol,
    timestamp: Date.now(),
    ticker,
    orderbook: {
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      spread: book.spread,
      spreadPct: book.spreadPct,
      bidVol: book.bidVol,
      askVol: book.askVol,
      imbalance: book.imbalance,
    },
    flow: {
      buyVol: agg.buyVol,
      sellVol: agg.sellVol,
      delta: agg.delta,
      buyPct: agg.buyPct,
      sellPct: agg.sellPct,
      buyValue: agg.buyValue,
      sellValue: agg.sellValue,
      totalTrades: agg.totalTrades,
    },
    cvd,
    divergence,
    openInterest: oi.openInterest,
    whales,
  };
}

// ======================================================
//  FORMATTERS (untuk tampilan Telegram)
// ======================================================
function fmt(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtBig(n) {
  if (!n) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(2);
}

function formatOrderflowMessage(snap) {
  const t = snap.ticker;
  const o = snap.orderbook;
  const f = snap.flow;
  const c = snap.cvd;
  const oi = snap.openInterest;

  const flowEmoji = f.delta > 0 ? '🟢' : f.delta < 0 ? '🔴' : '⚪';
  const trendEmoji = c.trend.includes('BULLISH') ? '📈' : c.trend.includes('BEARISH') ? '📉' : '➡️';

  let msg = `📊 *ORDERFLOW XAUUSDT — BINANCE*\n`;
  msg += `━━━━━━━━━━━━━━━━━━\n`;
  msg += `💰 *Last:* $${fmt(t.last)}  |  24h: *${t.changePct >= 0 ? '+' : ''}${fmt(t.changePct, 2)}%* ${t.changePct >= 0 ? '🟢' : '🔴'}\n`;
  msg += `📈 High: $${fmt(t.high)}   📉 Low: $${fmt(t.low)}\n`;
  msg += `🔄 Trades 24h: ${fmtBig(t.trades)}  |  Vol: ${fmtBig(t.volume)} XAU ($${fmtBig(t.quoteVolume)})\n`;
  msg += `\n`;

  msg += `📚 *ORDER BOOK (Top 20)*\n`;
  msg += `   Bid: $${fmt(o.bestBid)}  |  Ask: $${fmt(o.bestAsk)}\n`;
  msg += `   Spread: $${fmt(o.spread, 4)} (${fmt(o.spreadPct, 4)}%)\n`;
  msg += `   Bid Vol: ${fmt(o.bidVol, 1)} XAU  |  Ask Vol: ${fmt(o.askVol, 1)} XAU\n`;
  msg += `   Imbalance: *${fmt(o.imbalance, 1)}%* ${o.imbalance > 0 ? '(buyer heavy)' : '(seller heavy)'}\n`;
  msg += `\n`;

  msg += `${flowEmoji} *TAKER FLOW (last ${f.totalTrades} trades)*\n`;
  msg += `   Buy Vol:  *${fmt(f.buyVol, 1)}* XAU ($${fmtBig(f.buyValue)})\n`;
  msg += `   Sell Vol: *${fmt(f.sellVol, 1)}* XAU ($${fmtBig(f.sellValue)})\n`;
  msg += `   Delta:    *${f.delta >= 0 ? '+' : ''}${fmt(f.delta, 1)}* XAU\n`;
  msg += `   Buy %: *${fmt(f.buyPct, 1)}%* | Sell %: *${fmt(f.sellPct, 1)}%*\n`;
  msg += `\n`;

  msg += `${trendEmoji} *CVD (${c.windowMinutes}min)*\n`;
  msg += `   Final: *${fmt(c.finalCVD, 1)}* | Trend: *${c.trend}*\n`;
  msg += `   Buckets: ${c.buckets}\n`;
  msg += `\n`;

  if (snap.divergence) {
    msg += `⚠️ *DIVERGENCE:* ${snap.divergence}\n\n`;
  }

  if (oi) {
    msg += `📊 *Open Interest:* ${fmtBig(oi)} XAU\n\n`;
  }

  if (snap.whales.length > 0) {
    msg += `🐋 *WHALE TRADES (≥$50K)*\n`;
    for (const w of snap.whales.slice(0, 5)) {
      msg += `   ${w.side}  $${fmtBig(w.value)} @ $${fmt(w.price)} (${fmt(w.qty, 2)} XAU)\n`;
    }
    msg += `\n`;
  }

  msg += `⏰ ${new Date(snap.timestamp).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`;
  return msg;
}

module.exports = {
  SYMBOL,
  getOrderBook,
  getAggTrades,
  getCVD,
  get24hTicker,
  getOpenInterest,
  detectWhales,
  getFullOrderflow,
  formatOrderflowMessage,
  fmt,
  fmtBig,
};