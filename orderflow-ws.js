// ======================================================
//  📡 ORDERFLOW WEBSOCKET - XAUUSDT (REAL-TIME + AUTO ANALISA)
// ======================================================
//  Stream real-time dari Binance Futures WebSocket:
//   - aggTrade   : setiap trade taker buy/sell (untuk delta, CVD, whale)
//   - depth20    : order book top 20 (setiap 100ms)
//   - forceOrder : liquidations (long/short liq)
//   - markPrice  : mark price + funding rate
//
//  Auto-analisa internal yang berjalan tiap detik:
//   - Delta rolling (30s, 1m, 5m)
//   - CVD kumulatif
//   - Imbalance book (buyer/seller heavy)
//   - Whale detection (>= $50K)
//   - Sinyal otomatis: BUY / SELL / NEUTRAL + confidence
//
//  Bisa dipasang di bot.js sebagai background service
//  dan di-pakai snapshot-nya via getSnapshot() / on('signal') event.
// ======================================================

const WebSocket = require('ws');

const SYMBOL = 'xauusdt';
const SYMBOL_UPPER = 'XAUUSDT';

// ======================================================
//  WS ENDPOINTS (fallback)
// ======================================================
const WS_HOSTS = [
  'wss://fstream.binance.com',
  'wss://fstream1.binance.com',
  'wss://fstream2.binance.com',
  'wss://fstream3.binance.com',
];

// Streams yang di-subscribe (low & combined streams dalam 1 koneksi)
const STREAMS = [
  `${SYMBOL}@aggTrade`,         // setiap trade aggregated
  `${SYMBOL}@depth20@100ms`,    // order book 20 level tiap 100ms
  `${SYMBOL}@forceOrder`,       // liquidations
  `${SYMBOL}@markPrice@1s`,     // mark price + funding tiap detik
];

// ======================================================
//  RING BUFFERS (rolling window in-memory)
// ======================================================
const ROLLING_WINDOWS = {
  '30s': 30 * 1000,
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
};

// trades: array of {time, price, qty, value, isBuy, isWhale}
const trades = [];
// liquidations: array of {time, side, qty, price, value}
const liquidations = [];
// snapshots order book terakhir
let lastBook = { bids: [], asks: [], bestBid: 0, bestAsk: 0, imbalance: 0, midPrice: 0 };
// mark price + funding terakhir
let lastMark = { markPrice: 0, fundingRate: 0, nextFundingTime: 0, time: 0 };

// Thresholds
const WHALE_THRESHOLD_USD = 50000; // whale = trade >= $50K
const LIQ_THRESHOLD_USD = 25000;   // liquidation dianggap besar >= $25K

// State
let ws = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let isRunning = false;
let lastSignal = null;
let signalListeners = [];
let updateListeners = [];
let stats = { received: 0, reconnects: 0, errors: 0, startedAt: 0 };

// ======================================================
//  WS CONNECTION + AUTO RECONNECT
// ======================================================
function connect() {
  if (!isRunning) return;

  const host = WS_HOSTS[reconnectAttempt % WS_HOSTS.length];
  const url = `${host}/stream?streams=${STREAMS.join('/')}`;

  console.log(`📡 [orderflow-ws] connecting to ${host} ...`);
  ws = new WebSocket(url);

  ws.on('open', () => {
    console.log(`✓ [orderflow-ws] connected: ${url}`);
    reconnectAttempt = 0;
    stats.startedAt = stats.startedAt || Date.now();
  });

  ws.on('message', (raw) => {
    stats.received++;
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg.stream || !msg.data) return;

    try {
      handleStream(msg.stream, msg.data);
    } catch (e) {
      stats.errors++;
      console.warn(`⚠️ [orderflow-ws] handle error on ${msg.stream}: ${e.message}`);
    }
  });

  ws.on('error', (err) => {
    stats.errors++;
    console.warn(`⚠️ [orderflow-ws] WS error: ${err.message}`);
  });

  ws.on('close', (code, reason) => {
    console.warn(`⚠️ [orderflow-ws] WS closed: code=${code} reason=${reason?.toString() || ''}`);
    if (isRunning) {
      reconnectAttempt++;
      stats.reconnects++;
      const delay = Math.min(2000 * Math.pow(1.5, reconnectAttempt - 1), 30000);
      console.log(`🔄 [orderflow-ws] reconnect #${reconnectAttempt} in ${(delay / 1000).toFixed(1)}s`);
      reconnectTimer = setTimeout(connect, delay);
    }
  });
}

function handleStream(stream, data) {
  if (stream.endsWith('@aggTrade')) {
    handleAggTrade(data);
  } else if (stream.includes('@depth')) {
    handleDepth(data);
  } else if (stream.endsWith('@forceOrder')) {
    handleForceOrder(data);
  } else if (stream.endsWith('@markPrice')) {
    handleMarkPrice(data);
  }
}

// ======================================================
//  AGG TRADE HANDLER
// ======================================================
function handleAggTrade(t) {
  const price = parseFloat(t.p);
  const qty = parseFloat(t.q);
  const value = price * qty;
  const isBuy = !t.m; // m=true means buyer is maker => taker is seller
  const time = t.T;

  const trade = { time, price, qty, value, isBuy, isWhale: value >= WHALE_THRESHOLD_USD };
  trades.push(trade);

  // trim trades yang lebih lama dari 15 menit
  const cutoff = Date.now() - 15 * 60 * 1000;
  while (trades.length && trades[0].time < cutoff) trades.shift();
}

// ======================================================
//  DEPTH HANDLER
// ======================================================
function handleDepth(d) {
  const bids = (d.bids || []).map((b) => ({ price: parseFloat(b[0]), qty: parseFloat(b[1]) }));
  const asks = (d.asks || []).map((a) => ({ price: parseFloat(a[0]), qty: parseFloat(a[1]) }));
  let bidVol = 0, askVol = 0;
  bids.forEach((b) => (bidVol += b.qty));
  asks.forEach((a) => (askVol += a.qty));
  const bestBid = bids[0]?.price || 0;
  const bestAsk = asks[0]?.price || 0;
  const midPrice = (bestBid + bestAsk) / 2;
  const imbalance = (bidVol + askVol) > 0 ? ((bidVol - askVol) / (bidVol + askVol)) * 100 : 0;

  lastBook = { bids, asks, bestBid, bestAsk, bidVol, askVol, midPrice, imbalance, time: Date.now() };
}

// ======================================================
//  FORCE ORDER (LIQUIDATION) HANDLER
// ======================================================
function handleForceOrder(d) {
  const o = d.o || {};
  const price = parseFloat(o.p);
  const qty = parseFloat(o.q);
  const value = price * qty;
  const side = o.S; // 'BUY' or 'SELL' (order side, NOT taker side)
  // Per Binance docs: S='BUY' = long liquidation (taker closes long => market sell)
  //                   S='SELL' = short liquidation (taker closes short => market buy)
  // Tapi data S adalah sisi order. Mari kita pakai apinya.
  // Konvensi: kalau S='SELL' berarti order liquidasi short, BUY berarti long liquidasi
  // (Penting untuk "liquidation cascade" detection)
  const liqSide = side === 'BUY' ? 'LONG_LIQ' : 'SHORT_LIQ';
  liquidations.push({
    time: d.T || Date.now(),
    side: liqSide,
    price,
    qty,
    value,
    isLarge: value >= LIQ_THRESHOLD_USD,
  });
  // keep last 200
  const cutoff = Date.now() - 60 * 60 * 1000;
  while (liquidations.length && liquidations[0].time < cutoff) liquidations.shift();
}

// ======================================================
//  MARK PRICE + FUNDING HANDLER
// ======================================================
function handleMarkPrice(d) {
  lastMark = {
    markPrice: parseFloat(d.p || 0),
    fundingRate: parseFloat(d.r || 0),
    nextFundingTime: parseInt(d.T || 0),
    time: Date.now(),
  };
}

// ======================================================
//  GETTERS (rolling windows)
// ======================================================
function getWindowStats(windowMs) {
  const now = Date.now();
  const cutoff = now - windowMs;
  let buyVol = 0, sellVol = 0, buyValue = 0, sellValue = 0;
  let whalesBuy = 0, whalesSell = 0;
  let lastPrice = 0;

  for (const t of trades) {
    if (t.time < cutoff) continue;
    if (t.isBuy) { buyVol += t.qty; buyValue += t.value; if (t.isWhale) whalesBuy++; }
    else { sellVol += t.qty; sellValue += t.value; if (t.isWhale) whalesSell++; }
    if (t.time > (lastPrice ? 0 : 0)) lastPrice = t.price;
  }
  // last price = trade paling baru
  for (let i = trades.length - 1; i >= 0; i--) {
    if (trades[i].time >= cutoff) { lastPrice = trades[i].price; break; }
  }

  const totalVol = buyVol + sellVol;
  const delta = buyVol - sellVol;
  const buyPct = totalVol > 0 ? (buyVol / totalVol) * 100 : 50;
  // CVD dari semua trades dalam window
  let cvd = 0;
  for (const t of trades) {
    if (t.time < cutoff) continue;
    cvd += (t.isBuy ? t.qty : -t.qty);
  }

  return {
    windowMs,
    trades: trades.filter(t => t.time >= cutoff).length,
    buyVol, sellVol, delta, buyPct,
    buyValue, sellValue,
    cvd,
    whalesBuy, whalesSell,
    lastPrice,
  };
}

// Liquidations summary (last N)
function getLiqsSummary(windowMs = 5 * 60 * 1000) {
  const cutoff = Date.now() - windowMs;
  let longLiq = 0, shortLiq = 0, longLiqUSD = 0, shortLiqUSD = 0;
  for (const l of liquidations) {
    if (l.time < cutoff) continue;
    if (l.side === 'LONG_LIQ') { longLiq++; longLiqUSD += l.value; }
    else { shortLiq++; shortLiqUSD += l.value; }
  }
  return { longLiq, shortLiq, longLiqUSD, shortLiqUSD, totalUSD: longLiqUSD + shortLiqUSD };
}

// ======================================================
//  AUTO-ANALISA (SIGNAL GENERATOR)
// ======================================================
// Skor -100..+100, positif = bullish, negatif = bearish.
// Rule:
//  + delta 1m   > +20%       => +25
//  + delta 1m   < -20%       => -25
//  + delta 5m   > +15%       => +15
//  + delta 5m   < -15%       => -15
//  + imbalance  > +15%       => +20 (buyer heavy)
//  + imbalance  < -15%       => -20 (seller heavy)
//  + cvd trend  up          => +10
//  + cvd trend  down        => -10
//  + whales buy > whales sell *2 => +15
//  + whales sell > whales buy *2 => -15
//  + funding > 0.03%         => -10 (overheated long, biasanya revert)
//  + funding < -0.03%        => +10
//  + short liq > long liq (cascade) => +20 (short squeeze)
//  + long liq > short liq (cascade)  => -20 (long squeeze)
// ======================================================
function analyze() {
  const s1m = getWindowStats(60 * 1000);
  const s5m = getWindowStats(5 * 60 * 1000);
  const liq = getLiqsSummary(5 * 60 * 1000);

  let score = 0;
  const reasons = [];

  // delta 1m
  if (s1m.buyPct > 70) { score += 25; reasons.push(`Δ1m buy ${s1m.buyPct.toFixed(0)}%`); }
  else if (s1m.buyPct < 30) { score -= 25; reasons.push(`Δ1m sell ${(100 - s1m.buyPct).toFixed(0)}%`); }

  // delta 5m
  if (s5m.buyPct > 65) { score += 15; reasons.push(`Δ5m buy ${s5m.buyPct.toFixed(0)}%`); }
  else if (s5m.buyPct < 35) { score -= 15; reasons.push(`Δ5m sell ${(100 - s5m.buyPct).toFixed(0)}%`); }

  // imbalance book
  if (lastBook.imbalance > 15) { score += 20; reasons.push(`book bid+${lastBook.imbalance.toFixed(0)}%`); }
  else if (lastBook.imbalance < -15) { score -= 20; reasons.push(`book ask+${Math.abs(lastBook.imbalance).toFixed(0)}%`); }

  // CVD trend (5m slope approx: compare last vs midpoint)
  if (s5m.cvd > 5) { score += 10; reasons.push(`CVD+ ${s5m.cvd.toFixed(1)}`); }
  else if (s5m.cvd < -5) { score -= 10; reasons.push(`CVD- ${s5m.cvd.toFixed(1)}`); }

  // whales
  if (s5m.whalesBuy > 0 && s5m.whalesBuy >= s5m.whalesSell * 2) {
    score += 15; reasons.push(`whale buy ${s5m.whalesBuy}`);
  } else if (s5m.whalesSell > 0 && s5m.whalesSell >= s5m.whalesBuy * 2) {
    score -= 15; reasons.push(`whale sell ${s5m.whalesSell}`);
  }

  // funding rate
  if (lastMark.fundingRate > 0.0003) { score -= 10; reasons.push(`funding +${(lastMark.fundingRate * 100).toFixed(3)}%`); }
  else if (lastMark.fundingRate < -0.0003) { score += 10; reasons.push(`funding ${(lastMark.fundingRate * 100).toFixed(3)}%`); }

  // liquidation cascade
  if (liq.shortLiqUSD > liq.longLiqUSD * 2 && liq.shortLiqUSD > 100000) {
    score += 20; reasons.push(`short squeeze $${(liq.shortLiqUSD / 1000).toFixed(0)}K`);
  } else if (liq.longLiqUSD > liq.shortLiqUSD * 2 && liq.longLiqUSD > 100000) {
    score -= 20; reasons.push(`long squeeze $${(liq.longLiqUSD / 1000).toFixed(0)}K`);
  }

  // clip
  score = Math.max(-100, Math.min(100, score));

  let signal = 'NEUTRAL';
  let confidence = 0;
  if (score >= 40) { signal = 'STRONG BUY 🟢🟢'; confidence = Math.min(100, score); }
  else if (score >= 15) { signal = 'BUY 🟢'; confidence = Math.min(100, score); }
  else if (score <= -40) { signal = 'STRONG SELL 🔴🔴'; confidence = Math.min(100, Math.abs(score)); }
  else if (score <= -15) { signal = 'SELL 🔴'; confidence = Math.min(100, Math.abs(score)); }
  else confidence = Math.max(0, 100 - Math.abs(score - 50) * 2);

  return {
    timestamp: Date.now(),
    score,
    signal,
    confidence,
    reasons,
    delta1m: s1m,
    delta5m: s5m,
    book: lastBook,
    funding: lastMark,
    liquidations: liq,
  };
}

// ======================================================
//  SNAPSHOT (untuk pesan telegram)
// ======================================================
function getSnapshot() {
  const sig = analyze();
  return {
    symbol: SYMBOL_UPPER,
    timestamp: sig.timestamp,
    signal: sig.signal,
    score: sig.score,
    confidence: sig.confidence,
    reasons: sig.reasons,
    book: {
      bestBid: lastBook.bestBid,
      bestAsk: lastBook.bestAsk,
      spread: lastBook.bestAsk - lastBook.bestBid,
      spreadPct: lastBook.midPrice > 0 ? ((lastBook.bestAsk - lastBook.bestBid) / lastBook.midPrice) * 100 : 0,
      bidVol: lastBook.bidVol,
      askVol: lastBook.askVol,
      imbalance: lastBook.imbalance,
    },
    delta1m: { buyPct: sig.delta1m.buyPct, delta: sig.delta1m.delta, trades: sig.delta1m.trades },
    delta5m: { buyPct: sig.delta5m.buyPct, delta: sig.delta5m.delta, cvd: sig.delta5m.cvd, trades: sig.delta5m.trades, whales: sig.delta5m.whalesBuy + sig.delta5m.whalesSell },
    funding: { rate: sig.funding.fundingRate, nextIn: sig.funding.nextFundingTime - Date.now() },
    liquidations: sig.liquidations,
    lastPrice: lastBook.midPrice || (trades.length ? trades[trades.length - 1].price : 0),
    tradesCount: trades.length,
    stats,
  };
}

// ======================================================
//  FORMATTERS (Telegram)
// ======================================================
function fmt(n, d = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtBig(n) {
  if (!n) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(2);
}

// Pesan utama orderflow (realtime)
function formatRealtimeMessage(snap) {
  const sigEmoji = snap.signal.includes('BUY') ? '🟢' : snap.signal.includes('SELL') ? '🔴' : '⚪';
  let msg = `📡 *ORDERFLOW REALTIME — ${snap.symbol}*\n`;
  msg += `━━━━━━━━━━━━━━━━━━\n`;
  msg += `${sigEmoji} *SIGNAL: ${snap.signal}*\n`;
  msg += `📊 Score: *${snap.score >= 0 ? '+' : ''}${snap.score}* | Confidence: *${snap.confidence}%*\n`;
  if (snap.reasons.length) {
    msg += `💡 Reasons: ${snap.reasons.slice(0, 4).join(' | ')}\n`;
  }
  msg += `\n`;

  msg += `💰 *Price:* $${fmt(snap.lastPrice)}\n`;
  msg += `📚 *Book:* bid $${fmt(snap.book.bestBid)} | ask $${fmt(snap.book.bestAsk)}\n`;
  msg += `   Spread: *${fmt(snap.book.spreadPct, 4)}%* | Imbalance: *${fmt(snap.book.imbalance, 1)}%* ${snap.book.imbalance > 0 ? '(buyer)' : '(seller)'}\n`;
  msg += `\n`;

  msg += `📈 *Delta 1m:* buy ${fmt(snap.delta1m.buyPct, 1)}% (${snap.delta1m.delta >= 0 ? '+' : ''}${fmt(snap.delta1m.delta, 2)} XAU, ${snap.delta1m.trades} trades)\n`;
  msg += `📊 *Delta 5m:* buy ${fmt(snap.delta5m.buyPct, 1)}% | CVD: *${snap.delta5m.cvd >= 0 ? '+' : ''}${fmt(snap.delta5m.cvd, 2)}* | whales: ${snap.delta5m.whales}\n`;
  msg += `\n`;

  msg += `💸 *Funding:* ${(snap.funding.rate * 100).toFixed(4)}% (next in ${Math.max(0, Math.round(snap.funding.nextIn / 60000))}m)\n`;
  if (snap.liquidations.totalUSD > 0) {
    msg += `⚡ *Liquidations 5m:* $${fmtBig(snap.liquidations.totalUSD)} (L:${fmtBig(snap.liquidations.longLiqUSD)} S:${fmtBig(snap.liquidations.shortLiqUSD)})\n`;
  }
  msg += `\n`;

  msg += `🛰 Buffers: ${snap.tradesCount} trades | ${stats.received} msgs\n`;
  msg += `⏰ ${new Date(snap.timestamp).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`;
  return msg;
}

// ======================================================
//  SIGNAL CHECK LOOP (emit events saat signal berubah)
// ======================================================
let signalCheckInterval = null;
function startSignalLoop(intervalMs = 5000) {
  if (signalCheckInterval) return;
  signalCheckInterval = setInterval(() => {
    if (!isRunning) return;
    const snap = getSnapshot();
    const prevSig = lastSignal?.signal;
    const curSig = snap.signal;
    const prevScore = lastSignal?.score || 0;
    const scoreChanged = Math.abs(snap.score - prevScore) >= 25;

    // emit update setiap loop
    for (const fn of updateListeners) {
      try { fn(snap); } catch (e) { console.warn('update listener error:', e.message); }
    }
    // emit signal change hanya saat signal berubah / score lompat besar
    if (prevSig !== curSig || scoreChanged) {
      lastSignal = snap;
      for (const fn of signalListeners) {
        try { fn(snap, prevSig); } catch (e) { console.warn('signal listener error:', e.message); }
      }
    } else {
      lastSignal = snap;
    }
  }, intervalMs);
}
function stopSignalLoop() {
  if (signalCheckInterval) { clearInterval(signalCheckInterval); signalCheckInterval = null; }
}

// ======================================================
//  PUBLIC API
// ======================================================
function start() {
  if (isRunning) { console.log('⚠️ [orderflow-ws] already running'); return; }
  isRunning = true;
  stats.startedAt = Date.now();
  connect();
  startSignalLoop(5000);
  console.log('🚀 [orderflow-ws] started');
}

function stop() {
  isRunning = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.close(); } catch (e) {} ws = null; }
  stopSignalLoop();
  console.log('🛑 [orderflow-ws] stopped');
}

function onSignal(fn) { signalListeners.push(fn); }
function onUpdate(fn) { updateListeners.push(fn); }

function isConnected() {
  return ws && ws.readyState === WebSocket.OPEN;
}

module.exports = {
  SYMBOL,
  SYMBOL_UPPER,
  start,
  stop,
  isConnected,
  getSnapshot,
  analyze,
  formatRealtimeMessage,
  onSignal,
  onUpdate,
  fmt,
  fmtBig,
};