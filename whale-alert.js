// ======================================================
//  🐋 WHALE ALERT - Subscribe ke Large Trades
// ======================================================
//  Real-time alert untuk:
//    - Trade >= threshold ($50K default, configurable)
//    - Concentration: >70% buy atau >70% sell dalam bar
//    - Absorption: big buy after big sell (potential reversal)
//    - Exhaustion: chain buy dengan delta menurun (bearish)
//
//  USAGE:
//    const whale = require('./whale-alert');
//    whale.start();
//    whale.subscribe((alert) => {
//      console.log(alert);
//    });
// ======================================================

const { SimpleCache, Logger } = require('./utils');

const logger = new Logger('[whale-alert]', 'info');
const tapeDelta = require('./tape-delta');

const THRESHOLDS = {
  WHALE_USD: 50000,       // Trade >= ini adalah "whale"
  CONCENTRATION: 0.70,    // 70% buy/sell = concentrated
  MAJOR_MOVE_PCT: 2.0,    // 2% harga change = major move
  EXHAUSTION_DELTA_DECLINE: 0.85, // delta turun 15% = exhaustion signal
};

let subscribers = [];
let lastAlertTs = 0;
const ALERT_DEDUP_MS = 2000; // jangan spam alert sama dalam 2 detik

// ======================================================
//  WHALE DETECTION LOGIC
// ======================================================
function analyzeWhaleActivity(tf = '1m') {
  const snap = tapeDelta.getSnapshot(tf, 30);
  if (!snap.bars.length) return null;

  const last = snap.bars[snap.bars.length - 1];
  const prev = snap.bars.length > 1 ? snap.bars[snap.bars.length - 2] : null;

  const alerts = [];

  // 1. Direct whale detection (single trade >= threshold)
  const whales = snap.recentTrades.filter(t => t.value >= THRESHOLDS.WHALE_USD);
  for (const whale of whales) {
    alerts.push({
      type: 'WHALE_TRADE',
      severity: whale.value >= 100000 ? 'CRITICAL' : 'HIGH',
      side: whale.side,
      value: whale.value,
      qty: whale.qty,
      price: whale.price,
      ts: whale.ts,
      message: `🐋 ${whale.side === 'BUY' ? '🟢' : '🔴'} WHALE ${whale.side} $${formatNum(whale.value, 0)}`,
    });
  }

  // 2. Bar concentration (>70% one side)
  const total = last.buyVol + last.sellVol;
  if (total > 0) {
    const buyRatio = last.buyVol / total;
    const sellRatio = last.sellVol / total;

    if (buyRatio >= THRESHOLDS.CONCENTRATION) {
      alerts.push({
        type: 'BUY_CONCENTRATION',
        severity: 'MEDIUM',
        ratio: buyRatio,
        message: `📈 ${(buyRatio * 100).toFixed(1)}% BUY PRESSURE (concentration)`,
      });
    } else if (sellRatio >= THRESHOLDS.CONCENTRATION) {
      alerts.push({
        type: 'SELL_CONCENTRATION',
        severity: 'MEDIUM',
        ratio: sellRatio,
        message: `📉 ${(sellRatio * 100).toFixed(1)}% SELL PRESSURE (concentration)`,
      });
    }
  }

  // 3. Divergence: harga naik tapi buyer exhausted (delta declining)
  if (snap.bars.length >= 10) {
    const recent5 = snap.bars.slice(-5);
    const prev5 = snap.bars.slice(-10, -5);

    const recentAvgDelta = recent5.reduce((s, b) => s + b.delta, 0) / 5;
    const prevAvgDelta = prev5.reduce((s, b) => s + b.delta, 0) / 5;
    const recentAvgClose = recent5.reduce((s, b) => s + b.close, 0) / 5;
    const prevAvgClose = prev5.reduce((s, b) => s + b.close, 0) / 5;

    if (recentAvgClose > prevAvgClose && recentAvgDelta < prevAvgDelta * THRESHOLDS.EXHAUSTION_DELTA_DECLINE) {
      alerts.push({
        type: 'BEARISH_DIVERGENCE',
        severity: 'HIGH',
        priceChange: ((recentAvgClose - prevAvgClose) / prevAvgClose * 100).toFixed(2),
        deltaDecline: ((recentAvgDelta / prevAvgDelta - 1) * 100).toFixed(1),
        message: `⚠️ *BEARISH DIVERGENCE*: harga +${((recentAvgClose - prevAvgClose) / prevAvgClose * 100).toFixed(1)}% tapi delta ${Math.abs((recentAvgDelta / prevAvgDelta - 1) * 100).toFixed(1)}% turun`,
      });
    } else if (recentAvgClose < prevAvgClose && recentAvgDelta > prevAvgDelta * (2 - THRESHOLDS.EXHAUSTION_DELTA_DECLINE)) {
      alerts.push({
        type: 'BULLISH_DIVERGENCE',
        severity: 'HIGH',
        priceChange: ((recentAvgClose - prevAvgClose) / prevAvgClose * 100).toFixed(2),
        deltaIncrease: ((recentAvgDelta / prevAvgDelta - 1) * 100).toFixed(1),
        message: `⚠️ *BULLISH DIVERGENCE*: harga ${((recentAvgClose - prevAvgClose) / prevAvgClose * 100).toFixed(1)}% tapi delta +${Math.abs((recentAvgDelta / prevAvgDelta - 1) * 100).toFixed(1)}% naik`,
      });
    }
  }

  // 4. Absorption (big buy setelah big sell = akumulasi)
  if (snap.recentTrades.length >= 10) {
    const recent = snap.recentTrades.slice(-10);
    const totalBuy = recent.filter(t => t.side === 'BUY').reduce((s, t) => s + t.value, 0);
    const totalSell = recent.filter(t => t.side === 'SELL').reduce((s, t) => s + t.value, 0);

    // Jika ada swing: sell besar diikuti buy besar (absorption)
    let hasAbsorption = false;
    for (let i = 5; i < recent.length; i++) {
      const prev5 = recent.slice(Math.max(0, i - 5), i);
      const sellVol = prev5.filter(t => t.side === 'SELL').reduce((s, t) => s + t.value, 0);
      if (sellVol >= THRESHOLDS.WHALE_USD) {
        const next = recent[i];
        if (next && next.side === 'BUY' && next.value >= THRESHOLDS.WHALE_USD * 0.5) {
          hasAbsorption = true;
          break;
        }
      }
    }

    if (hasAbsorption) {
      alerts.push({
        type: 'ABSORPTION',
        severity: 'MEDIUM',
        message: `💪 *ABSORPTION DETECTED*: Sellers exhausted, buyers stepping in`,
      });
    }
  }

  return alerts;
}

function formatNum(n, decimals = 2) {
  if (n >= 1000000) return (n / 1000000).toFixed(decimals) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(decimals) + 'K';
  return n.toFixed(decimals);
}

// ======================================================
//  PUBLIC API
// ======================================================
function start() {
  logger.info('starting whale monitor (1m bars)');

  // Monitor setiap bar baru
  tapeDelta.onBar((tf, bar) => {
    if (tf !== '1m') return; // monitor 1m saja

    const alerts = analyzeWhaleActivity('1m');
    if (alerts && alerts.length > 0) {
      const now = Date.now();
      for (const alert of alerts) {
        // Deduplicate: jangan emit alert duplikat dalam 2 detik
        if (now - lastAlertTs > ALERT_DEDUP_MS) {
          emit(alert);
          lastAlertTs = now;
        }
      }
    }
  });

  // Subscribe ke recent trades juga (untuk instant whale)
  tapeDelta.onTrade((trade) => {
    if (trade.value >= THRESHOLDS.WHALE_USD) {
      const now = Date.now();
      if (now - lastAlertTs > ALERT_DEDUP_MS) {
        emit({
          type: 'WHALE_TRADE',
          severity: trade.value >= 100000 ? 'CRITICAL' : 'HIGH',
          side: trade.side,
          value: trade.value,
          qty: trade.qty,
          price: trade.price,
          ts: trade.ts,
          message: `🐋 ${trade.side === 'BUY' ? '🟢' : '🔴'} WHALE ${trade.side} $${formatNum(trade.value, 0)} @ ${trade.price}`,
        });
        lastAlertTs = now;
      }
    }
  });
}

function stop() {
  subscribers = [];
}

function subscribe(callback) {
  subscribers.push(callback);
  return () => { subscribers = subscribers.filter(cb => cb !== callback); };
}

function emit(alert) {
  logger.info(alert.message);
  for (const cb of subscribers) {
    try { cb(alert); } catch (e) { logger.error('subscriber error', e.message); }
  }
}

function getLatestAlerts(limit = 10) {
  return analyzeWhaleActivity('1m') || [];
}

function formatAlertMessage(alert) {
  let text = '';
  switch (alert.type) {
    case 'WHALE_TRADE':
      text = `🐋 *WHALE TRADE* [${alert.severity}]\n` +
        `Side: ${alert.side}\n` +
        `Price: $${alert.price}\n` +
        `Qty: ${formatNum(alert.qty)}\n` +
        `Value: $${formatNum(alert.value, 0)}`;
      break;
    case 'BUY_CONCENTRATION':
    case 'SELL_CONCENTRATION':
      text = `📊 *${alert.type}*\n${(alert.ratio * 100).toFixed(1)}% of volume`;
      break;
    case 'BEARISH_DIVERGENCE':
    case 'BULLISH_DIVERGENCE':
      text = alert.message;
      break;
    case 'ABSORPTION':
      text = alert.message;
      break;
    default:
      text = alert.message;
  }
  return text;
}

module.exports = {
  start, stop, subscribe, emit, getLatestAlerts,
  formatAlertMessage,
  THRESHOLDS,
};
