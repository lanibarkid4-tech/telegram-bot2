// ======================================================
//  🎯 SIGNAL AGGREGATOR - Combine All Signals
// ======================================================
//  Gabungin semua sinyal:
//    - Tape delta (momentum)
//    - Forex technical (trend + levels)
//    - Order book imbalance (struktur pasar)
//    - Whale activity (akumulasi/distribusi)
//    - Economic calendar (event risk)
//
//  Output: composite SIGNAL (BUY/SELL/NEUTRAL) + confidence
//
//  USAGE:
//    const signals = require('./signal-aggregator');
//    const signal = signals.getCompositeSignal('1m');
//    // { direction: 'BUY', confidence: 85, reasons: [...], severity: 'MEDIUM' }
// ======================================================

const { SimpleCache } = require('./utils');

const tapeDelta = require('./tape-delta');
const orderflow = require('./orderflow');
const whaleAlert = require('./whale-alert');

const signalCache = new SimpleCache(30, 10); // cache 30 detik, max 10 signals

// ======================================================
//  SIGNAL COMPONENTS
// ======================================================

function getTapeDeltaSignal(tf = '1m') {
  const snap = tapeDelta.getSnapshot(tf, 30);
  if (!snap.bars.length) return { component: 'TAPE', score: 0, reason: 'no data', weight: 0 };

  const last = snap.bars[snap.bars.length - 1];
  const cvd = tapeDelta.getCVD(tf, snap.bars.length);

  // Score berdasarkan delta positivity + CVD trend
  let score = 0;
  let reason = '';

  if (cvd.last > 0 && last.delta > 0) {
    score = Math.min(100, (Math.abs(last.delta) / (last.buyVol + last.sellVol)) * 200);
    reason = 'Strong buy pressure (Δ+ CVD+)';
  } else if (cvd.last < 0 && last.delta < 0) {
    score = Math.min(-100, -(Math.abs(last.delta) / (last.buyVol + last.sellVol)) * 200);
    reason = 'Strong sell pressure (Δ- CVD-)';
  } else if (cvd.last > 0 && last.delta < 0) {
    score = 50;
    reason = 'Weakening buy (CVD+ Δ-)';
  } else if (cvd.last < 0 && last.delta > 0) {
    score = -50;
    reason = 'Weakening sell (CVD- Δ+)';
  } else {
    score = 0;
    reason = 'Balanced';
  }

  return {
    component: 'TAPE_DELTA',
    score,
    reason,
    weight: 0.35, // 35% weight
    detail: { delta: last.delta, cvd: cvd.last, bars: snap.bars.length },
  };
}

function getOrderbookSignal() {
  try {
    const book = orderflow.getSnapshot ? orderflow.getSnapshot() : null;
    if (!book) return { component: 'ORDERBOOK', score: 0, reason: 'no data', weight: 0 };

    // Imbalance: >60% buyer heavy = bullish, <40% = bearish
    const imb = book.imbalance || 50;
    let score = 0;
    let reason = '';

    if (imb > 60) {
      score = Math.min(100, (imb - 50) * 4);
      reason = `Orderbook buyer heavy (${imb.toFixed(1)}%)`;
    } else if (imb < 40) {
      score = Math.max(-100, (imb - 50) * 4);
      reason = `Orderbook seller heavy (${(100 - imb).toFixed(1)}%)`;
    } else {
      score = (imb - 50) * 2;
      reason = 'Orderbook balanced';
    }

    return {
      component: 'ORDERBOOK',
      score,
      reason,
      weight: 0.25,
      detail: { imbalance: imb, spread: book.spread },
    };
  } catch (e) {
    return { component: 'ORDERBOOK', score: 0, reason: 'error: ' + e.message, weight: 0 };
  }
}

function getWhaleSignal() {
  try {
    const alerts = whaleAlert.getLatestAlerts ? whaleAlert.getLatestAlerts(3) : [];
    if (!alerts.length) return { component: 'WHALE', score: 0, reason: 'no activity', weight: 0 };

    let score = 0;
    let reason = '';
    let highestSeverity = 'UNKNOWN';

    for (const alert of alerts) {
      if (alert.type === 'WHALE_TRADE') {
        if (alert.side === 'BUY') {
          score += Math.min(50, (alert.value / 50000) * 25);
        } else {
          score -= Math.min(50, (alert.value / 50000) * 25);
        }
        highestSeverity = alert.severity;
      } else if (alert.type === 'BULLISH_DIVERGENCE') {
        score += 30;
      } else if (alert.type === 'BEARISH_DIVERGENCE') {
        score -= 30;
      } else if (alert.type === 'BUY_CONCENTRATION') {
        score += 20;
      } else if (alert.type === 'SELL_CONCENTRATION') {
        score -= 20;
      }
    }

    reason = `Whale activity detected (${highestSeverity})`;
    score = Math.max(-100, Math.min(100, score));

    return {
      component: 'WHALE',
      score,
      reason,
      weight: 0.20,
      detail: { alertCount: alerts.length },
    };
  } catch (e) {
    return { component: 'WHALE', score: 0, reason: 'error: ' + e.message, weight: 0 };
  }
}

function getCalendarSignal() {
  // TODO: integrate economic calendar impact
  // High impact event soon = reduce confidence (volatility expected)
  return {
    component: 'CALENDAR',
    score: 0,
    reason: 'no pending event',
    weight: 0.20,
    detail: {},
  };
}

// ======================================================
//  COMPOSITE SIGNAL CALCULATION
// ======================================================
function getCompositeSignal(tf = '1m') {
  const cacheKey = `signal_${tf}_${Math.floor(Date.now() / 30000)}`;
  const cached = signalCache.get(cacheKey);
  if (cached) return cached;

  const components = [
    getTapeDeltaSignal(tf),
    getOrderbookSignal(),
    getWhaleSignal(),
    getCalendarSignal(),
  ];

  // Weighted score
  let totalWeight = 0;
  let weightedScore = 0;

  for (const comp of components) {
    if (comp.weight > 0) {
      weightedScore += comp.score * comp.weight;
      totalWeight += comp.weight;
    }
  }

  const score = totalWeight > 0 ? weightedScore / totalWeight : 0;

  // Direction + confidence
  let direction = score > 10 ? 'BUY' : score < -10 ? 'SELL' : 'NEUTRAL';
  let confidence = Math.min(100, Math.abs(score));

  // Severity based on convergence (all signals agree)
  const agreementCount = components.filter(c => 
    (c.score > 10 && direction === 'BUY') ||
    (c.score < -10 && direction === 'SELL') ||
    (Math.abs(c.score) <= 10 && direction === 'NEUTRAL')
  ).length;
  const agreement = agreementCount / components.length;
  let severity = 'LOW';
  if (agreement >= 0.75) {
    severity = confidence > 80 ? 'CRITICAL' : confidence > 60 ? 'HIGH' : 'MEDIUM';
  } else if (agreement < 0.5) {
    severity = 'WEAK';
  }

  const signal = {
    timeframe: tf,
    direction,
    confidence: Math.round(confidence),
    score: score.toFixed(2),
    severity,
    agreement: (agreement * 100).toFixed(1),
    timestamp: Date.now(),
    components: components.map(c => ({
      name: c.component,
      score: c.score.toFixed(1),
      reason: c.reason,
      weight: (c.weight * 100).toFixed(0),
    })),
  };

  signalCache.set(cacheKey, signal);
  return signal;
}

// ======================================================
//  FORMATTING
// ======================================================
function formatSignalMessage(signal) {
  const dirIcon = signal.direction === 'BUY' ? '🟢' : signal.direction === 'SELL' ? '🔴' : '⚫';
  const sevIcon = {
    'CRITICAL': '🔴',
    'HIGH': '🟠',
    'MEDIUM': '🟡',
    'LOW': '⚪',
    'WEAK': '❌',
  }[signal.severity] || '❓';

  let text = `${dirIcon} *COMPOSITE SIGNAL* ${signal.timeframe}\n\n`;
  text += `Direction: *${signal.direction}*\n`;
  text += `Confidence: ${signal.confidence}%\n`;
  text += `Severity: ${sevIcon} ${signal.severity}\n`;
  text += `Agreement: ${signal.agreement}%\n\n`;

  text += `📊 *Component Breakdown:*\n`;
  for (const c of signal.components) {
    const cdir = c.score > 10 ? '🟢' : c.score < -10 ? '🔴' : '⚫';
    text += `  ${cdir} ${c.name} (${c.weight}%): ${c.score} - ${c.reason}\n`;
  }

  return text;
}

module.exports = {
  getCompositeSignal,
  getTapeDeltaSignal,
  getOrderbookSignal,
  getWhaleSignal,
  getCalendarSignal,
  formatSignalMessage,
};
