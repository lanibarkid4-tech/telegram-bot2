// ======================================================
//  📊 MODULE MULTI-TIMEFRAME ANALYSIS (Finnhub only)
// ======================================================
//  Ambil data dari Finnhub untuk berbagai timeframe:
//    - 1day (D1)    - Daily
//    - 4h           - 4 Hour
//    - 1h           - 1 Hour
//    - 30min        - 30 Min
//    - 15min        - 15 Min
//
//  Analisa trend di setiap TF, lalu gabungkan untuk
//  confidence score yang lebih tinggi (MTF confluence).
// ======================================================

const candles = require('./candles');
const { Logger } = require('./utils');

const logger = new Logger('[timeframe]', 'info');

// Mapping timeframe → Finnhub resolution
const TIMEFRAMES = {
  D1:  { interval: '1day',  label: 'Daily' },
  H4:  { interval: '4h',    label: '4H' },
  H1:  { interval: '1h',    label: '1H' },
  M30: { interval: '30min', label: '30M' },
  M15: { interval: '15min', label: '15M' },
  M5:  { interval: '5min',  label: '5M' },
  M1:  { interval: '1min',  label: '1M' },
};

// ======================================================
//  HITUNG SMA
// ======================================================
function calcSMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// ======================================================
//  HITUNG RSI(14)
// ======================================================
function calcRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

// ======================================================
//  ANALISA TREND SATU TIMEFRAME
// ======================================================
function analyzeTrend(prices) {
  if (!prices || prices.length < 20) {
    return { trend: 'UNKNOWN', strength: 0 };
  }
  const closes = prices.map(p => p.close);
  const sma7 = calcSMA(closes, 7);
  const sma21 = calcSMA(closes, 21);
  const rsi = calcRSI(closes) || 50;
  const last = closes[closes.length - 1];

  let trend = 'SIDEWAYS';
  let strength = 0;

  if (sma7 && sma21) {
    if (sma7 > sma21) {
      trend = 'BULLISH';
      strength = ((sma7 - sma21) / sma21) * 100;
    } else if (sma7 < sma21) {
      trend = 'BEARISH';
      strength = ((sma21 - sma7) / sma21) * 100;
    }
  }

  if (trend === 'BULLISH' && rsi > 70) strength *= 1.2;
  if (trend === 'BEARISH' && rsi < 30) strength *= 1.2;

  return {
    trend,
    strength: Math.min(Math.abs(strength), 5),
    sma7,
    sma21,
    rsi,
    last,
  };
}

// ======================================================
//  ANALISA MULTI-TIMEFRAME (MTF)
// ======================================================
async function analyzeMTF(symbol) {
  const analysisTfs = ['D1', 'H4', 'H1', 'M30', 'M15'];
  const result = { analysis: {} };

  for (const tf of analysisTfs) {
    const cfg = TIMEFRAMES[tf];
    try {
      const data = await candles.getCandles(symbol, cfg.interval, 100);
      if (!data || data.length === 0) {
        result.analysis[tf] = { error: 'No data', trend: 'UNKNOWN', label: cfg.label };
      } else {
        const trend = analyzeTrend(data);
        result.analysis[tf] = { ...trend, label: cfg.label, bars: data.length };
      }
    } catch (e) {
      logger.warn(`${symbol} ${tf}: ${e.message}`);
      result.analysis[tf] = { error: e.message, trend: 'UNKNOWN', label: cfg.label };
    }
    // jeda 250ms antar request (hemat rate limit free plan)
    await new Promise(r => setTimeout(r, 250));
  }

  result.confluence = calculateConfluence(result.analysis);
  return result;
}

// ======================================================
//  HITUNG CONFLUENCE SCORE
// ======================================================
function calculateConfluence(analysis) {
  const tfs = Object.keys(analysis).filter(tf =>
    analysis[tf].trend && analysis[tf].trend !== 'UNKNOWN' && !analysis[tf].error
  );
  if (tfs.length === 0) {
    return { bias: 'UNKNOWN', score: 0, aligned: 0, total: 0 };
  }

  const bullish = tfs.filter(tf => analysis[tf].trend === 'BULLISH').length;
  const bearish = tfs.filter(tf => analysis[tf].trend === 'BEARISH').length;
  const total = tfs.length;

  let bias = 'NEUTRAL';
  let score = 50;

  if (bullish > bearish) {
    bias = 'BULLISH';
    score = Math.round((bullish / total) * 100);
  } else if (bearish > bullish) {
    bias = 'BEARISH';
    score = Math.round((bearish / total) * 100);
  }

  return { bias, score, aligned: Math.max(bullish, bearish), total };
}

// ======================================================
//  FORMAT PESAN TELEGRAM (Markdown)
// ======================================================
function formatMTFMessage(symbol, r) {
  const conf = r.confluence;
  const emoji = conf.bias === 'BULLISH' ? '🟢' : conf.bias === 'BEARISH' ? '🔴' : '⚪';

  let msg = `${emoji} *MTF ANALYSIS — ${symbol.toUpperCase()}*\n`;
  msg += `━━━━━━━━━━━━━━━\n`;
  msg += `🎯 *BIAS:* ${conf.bias} (${conf.score}% • ${conf.aligned}/${conf.total} TF)\n\n`;

  msg += `📊 *TIMEFRAMES:*\n`;
  for (const tf of ['D1', 'H4', 'H1', 'M30', 'M15']) {
    const a = r.analysis[tf];
    if (!a) continue;
    const e = a.trend === 'BULLISH' ? '🟢' : a.trend === 'BEARISH' ? '🔴' : a.trend === 'SIDEWAYS' ? '⚪' : '❔';
    const strength = a.strength ? a.strength.toFixed(2) + '%' : '—';
    const rsi = a.rsi ? a.rsi.toFixed(1) : '—';
    const err = a.error ? ` ⚠️${a.error}` : '';
    msg += `  ${e} *${tf}* (${a.label}): ${a.trend} • str ${strength} • RSI ${rsi}${err}\n`;
  }

  msg += `\n⚠️ _Bukan saran finansial. Selalu pakai manajemen risiko._`;
  return msg;
}

module.exports = {
  TIMEFRAMES,
  analyzeTrend,
  analyzeMTF,
  calculateConfluence,
  formatMTFMessage,
};