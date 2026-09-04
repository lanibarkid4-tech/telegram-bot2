const { SimpleCache, Logger } = require('./utils');
const candlesMod = require('./candles');

const logger = new Logger('[xauusd-ta]', 'info');

const SYMBOL = 'xauusd';
const CACHE_TTL = 60;

const cache = new SimpleCache(CACHE_TTL, 10);

// Ambil candle 1H XAU/USD lewat candles.js (Twelve Data -> fallback Finnhub)
async function fetchCandles() {
  const raw = await candlesMod.getCandles(SYMBOL, '1h', 100);
  if (!raw || !raw.length) {
    throw new Error('Tidak ada data candle XAU/USD');
  }
  return raw.map(c => ({
    datetime: new Date(c.openTime).toISOString().replace('T', ' ').substr(0, 19),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume || 0,
  }));
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function calcEma(values, period) {
  const closes = values.map(v => v.close).filter(n => n !== null);
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRsi(values, period = 14) {
  const closes = values.map(v => v.close);
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) - diff) / period;
    }
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcMacd(values) {
  const closes = values.map(v => v.close);
  if (closes.length < 26) return { macd: null, signal: null, hist: null };
  const ema12 = calcEmaArr(closes, 12);
  const ema26 = calcEmaArr(closes, 26);
  if (ema12 === null || ema26 === null) return { macd: null, signal: null, hist: null };
  const macdLine = [];
  const k12 = 2 / 13;
  const k26 = 2 / 27;
  let e12 = closes[0], e26 = closes[0];
  for (let i = 1; i < closes.length; i++) {
    e12 = closes[i] * k12 + e12 * (1 - k12);
    e26 = closes[i] * k26 + e26 * (1 - k26);
    if (i >= 25) macdLine.push(e12 - e26);
  }
  if (macdLine.length < 9) return { macd: null, signal: null, hist: null };
  const k9 = 2 / 10;
  let signal = macdLine[0];
  for (let i = 1; i < macdLine.length; i++) {
    signal = macdLine[i] * k9 + signal * (1 - k9);
  }
  const macdVal = macdLine[macdLine.length - 1];
  return { macd: macdVal, signal, hist: macdVal - signal };
}

function calcEmaArr(arr, period) {
  if (arr.length < period) return null;
  const k = 2 / (period + 1);
  let ema = arr[0];
  for (let i = 1; i < arr.length; i++) {
    ema = arr[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcBbands(values, period = 20) {
  const closes = values.map(v => v.close);
  if (closes.length < period) return { upper: null, middle: null, lower: null };
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  const sd = Math.sqrt(variance);
  return { upper: mean + 2 * sd, middle: mean, lower: mean - 2 * sd };
}

function trendFromEma(ema9, ema21, ema50) {
  if (ema9 === null || ema21 === null || ema50 === null) return 'NEUTRAL';
  if (ema9 > ema21 && ema21 > ema50) return 'STRONG_UP';
  if (ema9 > ema21 && ema21 < ema50) return 'WEAK_UP';
  if (ema9 < ema21 && ema21 < ema50) return 'STRONG_DOWN';
  if (ema9 < ema21 && ema21 > ema50) return 'WEAK_DOWN';
  return 'NEUTRAL';
}

function computeScore(ind) {
  let score = 0;
  const reasons = [];

  if (ind.rsi !== null) {
    if (ind.rsi < 30) { score += 2; reasons.push(`RSI oversold (${ind.rsi.toFixed(1)})`); }
    else if (ind.rsi > 70) { score -= 2; reasons.push(`RSI overbought (${ind.rsi.toFixed(1)})`); }
    else if (ind.rsi > 50) { score += 0.5; }
    else if (ind.rsi < 50) { score -= 0.5; }
  }

  if (ind.macd_hist !== null) {
    if (ind.macd_hist > 0) { score += 1.5; reasons.push(`MACD bullish (${ind.macd_hist.toFixed(2)})`); }
    else if (ind.macd_hist < 0) { score -= 1.5; reasons.push(`MACD bearish (${ind.macd_hist.toFixed(2)})`); }
  }

  if (ind.ema_trend === 'STRONG_UP') { score += 2; reasons.push('EMA 9>21>50 (uptrend kuat)'); }
  else if (ind.ema_trend === 'WEAK_UP') { score += 0.5; reasons.push('EMA pullback'); }
  else if (ind.ema_trend === 'STRONG_DOWN') { score -= 2; reasons.push('EMA 9<21<50 (downtrend kuat)'); }
  else if (ind.ema_trend === 'WEAK_DOWN') { score -= 0.5; reasons.push('EMA weak down'); }

  if (ind.bb_pct !== null) {
    if (ind.bb_pct < 0.2) { score += 1; reasons.push('Harga di lower band'); }
    else if (ind.bb_pct > 0.8) { score -= 1; reasons.push('Harga di upper band'); }
  }

  return { score, reasons };
}

function findSupportResistance(values, count = 5) {
  const highs = [];
  const lows = [];
  for (let i = 1; i < values.length - 1; i++) {
    const h = values[i].high;
    const l = values[i].low;
    if (h === null || l === null) continue;
    if (h > values[i - 1].high && h > values[i + 1].high) highs.push(h);
    if (l < values[i - 1].low && l < values[i + 1].low) lows.push(l);
  }
  highs.sort((a, b) => b - a);
  lows.sort((a, b) => b - a);
  return { resistance: highs.slice(0, count), support: lows.slice(0, count) };
}

async function analyze(forceRefresh = false) {
  if (!forceRefresh) {
    const cached = cache.get('analysis');
    if (cached) return cached;
  }

  const candles = await fetchCandles();
  const latest = candles[candles.length - 1];
  const close = latest.close;

  const rsi = calcRsi(candles, 14);
  const macdData = calcMacd(candles);
  const ema9 = calcEma(candles, 9);
  const ema21 = calcEma(candles, 21);
  const ema50 = calcEma(candles, 50);
  const bb = calcBbands(candles, 20);

  const ind = {
    rsi,
    macd: macdData.macd,
    macd_signal: macdData.signal,
    macd_hist: macdData.hist,
    ema9,
    ema21,
    ema50,
    bb_upper: bb.upper,
    bb_middle: bb.middle,
    bb_lower: bb.lower,
    high: latest.high,
    low: latest.low,
    open: latest.open,
  };

  ind.ema_trend = trendFromEma(ind.ema9, ind.ema21, ind.ema50);

  if (ind.bb_upper !== null && ind.bb_lower !== null && ind.bb_upper !== ind.bb_lower) {
    ind.bb_pct = (close - ind.bb_lower) / (ind.bb_upper - ind.bb_lower);
  } else {
    ind.bb_pct = null;
  }

  const { support, resistance } = findSupportResistance(candles);
  const { score, reasons } = computeScore(ind);

  let signal = 'NEUTRAL';
  let confidence = Math.min(Math.abs(score) * 15, 95);
  if (score >= 2.5) signal = 'STRONG_BUY';
  else if (score >= 1) signal = 'BUY';
  else if (score <= -2.5) signal = 'STRONG_SELL';
  else if (score <= -1) signal = 'SELL';
  else { signal = 'NEUTRAL'; confidence = Math.max(20, confidence); }

  const atr = ind.high - ind.low;
  let entry = close;
  let tp, sl;
  if (signal.includes('BUY')) {
    tp = entry + atr * 1.5;
    sl = entry - atr * 1.0;
  } else if (signal.includes('SELL')) {
    tp = entry - atr * 1.5;
    sl = entry + atr * 1.0;
  } else {
    tp = entry + atr;
    sl = entry - atr;
  }

  const result = {
    ok: true,
    symbol: 'XAU/USD',
    datetime: latest.datetime,
    price: close,
    open: ind.open,
    high: ind.high,
    low: ind.low,
    indicators: ind,
    signal,
    confidence: Math.round(confidence),
    score,
    reasons,
    support,
    resistance,
    entry: Number(entry.toFixed(2)),
    tp: Number(tp.toFixed(2)),
    sl: Number(sl.toFixed(2)),
    atr: Number(atr.toFixed(2)),
    supportNearest: support[0] ? Number(support[0].toFixed(2)) : null,
    resistanceNearest: resistance[0] ? Number(resistance[0].toFixed(2)) : null,
  };

  cache.set('analysis', result);
  return result;
}

function formatMessage(r) {
  if (!r.ok) return `Error: ${r.error || 'Gagal menganalisa XAU/USD'}`;

  const emoji =
    r.signal === 'STRONG_BUY' ? '🟢🟢🟢' :
    r.signal === 'BUY'         ? '🟢' :
    r.signal === 'STRONG_SELL' ? '🔴🔴🔴' :
    r.signal === 'SELL'        ? '🔴' :
                                 '⚪';

  const directionLabel =
    r.signal === 'STRONG_BUY' ? 'STRONG BUY' :
    r.signal === 'BUY'        ? 'BUY' :
    r.signal === 'STRONG_SELL'? 'STRONG SELL' :
    r.signal === 'SELL'       ? 'SELL' :
                                'NETRAL';

  const i = r.indicators;
  const fmt = (n, d = 2) => n === null ? '—' : n.toFixed(d);

  const supList = (r.support || []).slice(0, 3).map(s => `$${s.toFixed(2)}`).join(' / ') || '—';
  const resList = (r.resistance || []).slice(0, 3).map(s => `$${s.toFixed(2)}`).join(' / ') || '—';

  let rsiLabel = '';
  if (i.rsi !== null) {
    if (i.rsi < 30) rsiLabel = ' (oversold)';
    else if (i.rsi > 70) rsiLabel = ' (overbought)';
  }

  let msg = `${emoji} *XAU/USD — ${directionLabel}*
━━━━━━━━━━━━━━━━━━
💰 Price: *$${r.price.toFixed(2)}*
🕐 Time:  ${r.datetime} (1h)
🎯 Confidence: *${r.confidence}%*

📈 *TEKNIKAL:*
• RSI(14):  \`${fmt(i.rsi, 1)}\`${rsiLabel}
• MACD:    \`${fmt(i.macd)}\` / signal \`${fmt(i.macd_signal)}\` / hist \`${fmt(i.macd_hist)}\`
• EMA(9):  \`$${fmt(i.ema9)}\`
• EMA(21): \`$${fmt(i.ema21)}\`
• EMA(50): \`$${fmt(i.ema50)}\`
• Trend:   *${i.ema_trend}*
• BB(20):  upper \`$${fmt(i.bb_upper)}\` / lower \`$${fmt(i.bb_lower)}\`

🎯 *LEVEL PLAN:*
• Entry: *$${r.entry}*
• TP:    *$${r.tp}*  (1.5× ATR)
• SL:    *$${r.sl}*  (1.0× ATR)
• ATR:   \`$${r.atr}\`

🔰 *SUPPORT:* ${supList}
🔺 *RESIST:* ${resList}

📋 *ALASAN:*
${r.reasons.length > 0 ? r.reasons.map(x => `  • ${x}`).join('\n') : '  (tidak ada sinyal dominan)'}

⚠️ _Bukan saran finansial. Gunakan manajemen risiko._
🕒 _Cache ${CACHE_TTL}s — data terakhir diperbarui ${r.datetime}_`;

  return msg;
}

module.exports = {
  analyze,
  formatMessage,
  SYMBOL,
  CACHE_TTL,
};
