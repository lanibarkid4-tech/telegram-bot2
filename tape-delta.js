// ======================================================
//  📊 TAPE DELTA - Real-time Buyer vs Seller Aggression
// ======================================================
//  Sumber data: Binance WebSocket aggTrade stream
//  Konsep: "tape" = time & sales. "Delta" = buy volume - sell volume.
//  Setiap trade aggTrade memiliki flag `m` (isBuyerMaker):
//    - m = true  -> seller initiated (aggressive SELL, makan bid)
//    - m = false -> buyer initiated  (aggressive BUY,  makan ask)
//
//  Output:
//    - Buy vol / Sell vol per bar (1m, 5m, 15m)
//    - Delta, Cumulative Delta (CVD)
//    - Max delta spike (absorption / exhaustion)
//    - Mini-chart ASCII untuk Telegram
//
//  Bisa di-subscribe event `bar` untuk realtime push ke bot.
// ======================================================

const WebSocket = require('ws');

const SYMBOL = 'xauusdt';
const SYMBOL_UPPER = 'XAUUSDT';

const WS_HOSTS = [
  'wss://fstream.binance.com',
  'wss://fstream1.binance.com',
  'wss://fstream2.binance.com',
  'wss://fstream3.binance.com',
];

// Bars: 1m, 5m, 15m
const BAR_SIZES_MS = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
};
const HISTORY_BARS = 60; // simpan 60 bar terakhir per timeframe

// Internal state
let ws = null;
let reconnectAttempt = 0;
let isRunning = false;

// bars[timeframe] = array of bar objects (oldest -> newest)
const bars = {
  '1m': [],
  '5m': [],
  '15m': [],
};

// Trade log (last N trades) - untuk debug & "tape view"
const recentTrades = [];
const MAX_RECENT = 50;

let lastPrice = 0;
let lastUpdateTs = 0;
let stats = { trades: 0, reconnects: 0, startedAt: 0 };

// Event listeners
const barListeners = [];
const tradeListeners = [];

function emitBar(tf, bar) {
  for (const fn of barListeners) {
    try { fn(tf, bar); } catch (e) { /* ignore */ }
  }
}
function emitTrade(t) {
  for (const fn of tradeListeners) {
    try { fn(t); } catch (e) { /* ignore */ }
  }
}

// ======================================================
//  BAR MANAGEMENT
// ======================================================
function getCurrentBarStart(ts, sizeMs) {
  return Math.floor(ts / sizeMs) * sizeMs;
}

function pushBarToHistory(tf, bar) {
  const arr = bars[tf];
  const last = arr[arr.length - 1];

  if (last && last.start === bar.start) {
    // Update bar yang sedang berjalan
    arr[arr.length - 1] = bar;
  } else {
    // Bar baru - close bar sebelumnya (jika ada gap)
    if (last && bar.start - last.start > BAR_SIZES_MS[tf]) {
      // ada gap, isi bar kosong di antara
      let fillStart = last.start + BAR_SIZES_MS[tf];
      while (fillStart < bar.start) {
        arr.push({
          start: fillStart,
          open: last.close, high: last.close, low: last.close, close: last.close,
          buyVol: 0, sellVol: 0, delta: 0, trades: 0, buyCount: 0, sellCount: 0,
        });
        if (arr.length > HISTORY_BARS) arr.shift();
        fillStart += BAR_SIZES_MS[tf];
      }
    }
    arr.push(bar);
    if (arr.length > HISTORY_BARS) arr.shift();
  }
}

function onTrade(price, qty, isBuyerMaker, ts) {
  stats.trades++;
  lastPrice = price;
  lastUpdateTs = ts;

  const isAggressiveBuy = !isBuyerMaker;  // buyer take ask = aggressive buy
  const isAggressiveSell = isBuyerMaker;  // seller hit bid = aggressive sell

  // Recent trade log
  recentTrades.push({
    ts, price, qty, value: price * qty,
    side: isAggressiveBuy ? 'BUY' : 'SELL',
  });
  if (recentTrades.length > MAX_RECENT) recentTrades.shift();

  emitTrade(recentTrades[recentTrades.length - 1]);

  // Update setiap timeframe
  for (const tf of Object.keys(BAR_SIZES_MS)) {
    const sizeMs = BAR_SIZES_MS[tf];
    const start = getCurrentBarStart(ts, sizeMs);
    const arr = bars[tf];
    const prev = arr[arr.length - 1];

    let bar;
    if (prev && prev.start === start) {
      bar = { ...prev };
    } else {
      // Buka bar baru
      const openPrice = prev ? prev.close : price;
      bar = {
        start,
        open: openPrice, high: price, low: price, close: price,
        buyVol: 0, sellVol: 0, delta: 0, trades: 0, buyCount: 0, sellCount: 0,
      };
    }

    if (price > bar.high) bar.high = price;
    if (price < bar.low) bar.low = price;
    bar.close = price;
    bar.trades++;
    if (isAggressiveBuy) {
      bar.buyVol += qty;
      bar.buyCount++;
    } else {
      bar.sellVol += qty;
      bar.sellCount++;
    }
    bar.delta = bar.buyVol - bar.sellVol;

    pushBarToHistory(tf, bar);
    emitBar(tf, bar);
  }
}

// ======================================================
//  WS CONNECTION
// ======================================================
function connect() {
  if (!isRunning) return;
  const host = WS_HOSTS[reconnectAttempt % WS_HOSTS.length];
  const url = `${host}/ws/${SYMBOL}@aggTrade`;

  console.log(`📊 [tape-delta] connecting to ${host} ...`);
  ws = new WebSocket(url);

  ws.on('open', () => {
    console.log(`✓ [tape-delta] connected: aggTrade stream`);
    reconnectAttempt = 0;
    stats.startedAt = stats.startedAt || Date.now();
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    // aggTrade format: { e, E, s, p, q, T, m, ... }
    if (msg.e !== 'aggTrade') return;
    const price = parseFloat(msg.p);
    const qty = parseFloat(msg.q);
    const ts = msg.T;
    onTrade(price, qty, msg.m, ts);
  });

  ws.on('error', (err) => {
    console.error(`❌ [tape-delta] ws error: ${err.message}`);
  });

  ws.on('close', () => {
    if (!isRunning) return;
    stats.reconnects++;
    reconnectAttempt++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempt - 1), 30000);
    console.log(`⚠️  [tape-delta] disconnected, retry in ${Math.round(delay/1000)}s ...`);
    setTimeout(connect, delay);
  });
}

// ======================================================
//  PUBLIC API
// ======================================================
function start() {
  if (isRunning) return;
  isRunning = true;
  connect();
}

function stop() {
  isRunning = false;
  if (ws) { try { ws.close(); } catch (e) {} ws = null; }
}

function getSnapshot(tf = '1m', lastN = 30) {
  const arr = bars[tf] || [];
  return {
    symbol: SYMBOL_UPPER,
    timeframe: tf,
    lastPrice,
    lastUpdateTs,
    stats: { ...stats },
    bars: arr.slice(-lastN),
    recentTrades: recentTrades.slice(-20),
  };
}

function getLatestBar(tf = '1m') {
  const arr = bars[tf] || [];
  return arr[arr.length - 1] || null;
}

function getCVD(tf = '1m', lastN = 60) {
  const arr = bars[tf] || [];
  let cum = 0;
  const series = [];
  for (const b of arr.slice(-lastN)) {
    cum += b.delta;
    series.push({ ts: b.start, delta: b.delta, cvd: cum });
  }
  return { tf, last: cum, series };
}

// ======================================================
//  FORMATTING (untuk Telegram)
// ======================================================
function formatNumber(n, decimals = 2) {
  if (!isFinite(n)) return '0';
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatBarASCII(snap, width = 20) {
  // Bikin mini-chart delta: pos ke kanan, neg ke kiri
  const bars = snap.bars;
  if (!bars.length) return '_(no data)_';

  const maxAbs = Math.max(...bars.map(b => Math.abs(b.delta))) || 1;
  const halfW = Math.floor(width / 2);

  const lines = [];
  lines.push('```');
  lines.push(`${snap.symbol} • ${snap.timeframe} • Δ per bar (last ${bars.length})`);
  lines.push(`Last: ${formatNumber(snap.lastPrice, 2)}`);
  lines.push('');
  for (const b of bars) {
    const ratio = b.delta / maxAbs; // -1 .. 1
    const pos = Math.round(Math.abs(ratio) * halfW);
    const bar = ratio >= 0
      ? ' '.repeat(halfW) + '│' + '█'.repeat(pos)
      : ' '.repeat(halfW - pos) + '█'.repeat(pos) + '│';
    const sign = b.delta >= 0 ? '+' : '';
    const t = new Date(b.start).toISOString().substr(11, 5);
    lines.push(`${t} ${bar} ${sign}${formatNumber(b.delta, 1)}`);
  }
  lines.push('```');
  return lines.join('\n');
}

function formatTapeMessage(tf = '1m') {
  const snap = getSnapshot(tf, 20);
  if (!snap.bars.length) {
    return `📊 *TAPE DELTA ${snap.symbol}*\n\n⏳ Menunggu data tape...`;
  }

  const last = snap.bars[snap.bars.length - 1];
  const cvd = getCVD(tf, snap.bars.length);
  const sign = last.delta >= 0 ? '+' : '';

  // 20-bar summary
  let buyVol20 = 0, sellVol20 = 0;
  for (const b of snap.bars) { buyVol20 += b.buyVol; sellVol20 += b.sellVol; }
  const delta20 = buyVol20 - sellVol20;
  const ratio = buyVol20 / (buyVol20 + sellVol20) * 100;

  // Deteksi divergence sederhana: harga naik tapi delta turun
  let divergence = '';
  if (snap.bars.length >= 10) {
    const recent5 = snap.bars.slice(-5);
    const prev5 = snap.bars.slice(-10, -5);
    const priceUp = recent5[recent5.length - 1].close > prev5[0].close;
    const deltaDown = recent5.reduce((s, b) => s + b.delta, 0) <
                      prev5.reduce((s, b) => s + b.delta, 0);
    if (priceUp && deltaDown) divergence = '\n⚠️ *BEARISH DIVERGENCE* (harga ↑, delta ↓)';
    else if (!priceUp && !deltaDown) divergence = '\n⚠️ *BULLISH DIVERGENCE* (harga ↓, delta ↑)';
  }

  // Top trades (whale)
  const whales = snap.recentTrades
    .filter(t => t.value >= 50000)
    .slice(-5)
    .reverse();

  let text = `📊 *TAPE DELTA ${snap.symbol}* (${tf})\n\n`;
  text += `💰 Last: \`${formatNumber(snap.lastPrice, 2)}\`\n`;
  text += `📈 Bar aktif: Δ \`${sign}${formatNumber(last.delta, 2)}\` `;
  text += `(B: ${formatNumber(last.buyVol, 1)} | S: ${formatNumber(last.sellVol, 1)})\n`;
  text += `🔢 Trades: ${last.trades} (${last.buyCount} buy / ${last.sellCount} sell)\n\n`;

  text += `📦 *Last ${snap.bars.length} bars:*\n`;
  text += `  Buy:  \`${formatNumber(buyVol20, 1)}\`\n`;
  text += `  Sell: \`${formatNumber(sellVol20, 1)}\`\n`;
  text += `  Δ:    \`${delta20 >= 0 ? '+' : ''}${formatNumber(delta20, 2)}\`\n`;
  text += `  Buy%: \`${formatNumber(ratio, 1)}%\`\n`;
  text += `  CVD:  \`${cvd.last >= 0 ? '+' : ''}${formatNumber(cvd.last, 1)}\`${divergence}\n\n`;

  text += formatBarASCII(snap, 24) + '\n';

  if (whales.length) {
    text += `\n🐋 *Recent Whales (≥$50K):*\n`;
    for (const w of whales) {
      const icon = w.side === 'BUY' ? '🟢' : '🔴';
      text += `  ${icon} ${w.side} \`${formatNumber(w.qty, 2)}\` @ \`${formatNumber(w.price, 2)}\` = $${formatNumber(w.value, 0)}\n`;
    }
  }

  return text;
}

// ======================================================
//  EVENT SUBSCRIPTION
// ======================================================
function onBar(fn) { barListeners.push(fn); }
function onTrade_(fn) { tradeListeners.push(fn); }

module.exports = {
  SYMBOL: SYMBOL_UPPER,
  start, stop,
  getSnapshot, getLatestBar, getCVD,
  formatTapeMessage,
  onBar, onTrade: onTrade_,
};
