// ======================================================
//  🤖 XAUUSD ICT/SMC ANALYST — Interactive Bot
// ======================================================
//  Flow:
//    /xauusd  → pilih TF (M1/M5/M15/M30/H1/H4/D1)
//             → pilih Mode (Scalping / Intraday / Swing)
//             → analisa sesuai template ICT/SMC
//
//  Methodology: Top-down MTF (HTF bias → mid TF zone → LTF entry)
//               + 5-point confluence scoring
// ======================================================

require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const candles = require('./candles');
const xauusdTA = require('./xauusd-ta');
const ict = require('./ict-structures');
const orderflow = require('./orderflow');
const dukascopy = require('./dukascopy');
const confluenceAnalysis = require('./confluence');
const { RateLimiter, Logger, GracefulShutdown } = require('./utils');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.log('❌ TELEGRAM_BOT_TOKEN kosong!');
  process.exit(1);
}

const TD_KEY = process.env.TWELVE_DATA_API_KEY;
console.log('========================================');
console.log('🏆 XAUUSD ICT/SMC ANALYST');
console.log('📡 Data: Twelve Data (XAU/USD spot)');
console.log('⏰ ' + new Date().toLocaleString());
console.log('========================================');

const bot = new TelegramBot(TOKEN, { polling: false });
const logger = new Logger('[bot]', 'info');
const limiter = new RateLimiter({ '/xauusd': 5, '/start': 5, '/help': 5, '/status': 5, '/cancel': 5 }, 60);
const shutdown = new GracefulShutdown();
shutdown.init();

const fmt = (n, d = 2) => (n === null || n === undefined || !Number.isFinite(n)) ? '—' : Number(n).toFixed(d);

// ======================================================
//  CACHE
// ======================================================
const cache = {
  _s: {},
  get(k) { const e = this._s[k]; if (!e) return null; if (Date.now() > e.exp) { delete this._s[k]; return null; } return e.v; },
  set(k, v, ttl = 60) { this._s[k] = { v, exp: Date.now() + ttl * 1000 }; }
};

async function getCandles(tf, count = 200) {
  const k = 'c-' + tf + '-' + count;
  let v = cache.get(k);
  if (v) return v;
  try {
    const meta = await candles.getCandlesWithMeta('xauusd', tf, count);
    if (meta && meta.candles && meta.candles.length) {
      cache.set(k, meta.candles);
      // simpan source info di cache terpisah
      cache.set(k + ':meta', { source: meta.source, symbol: meta.symbol, delay: meta.delay }, 60);
      return meta.candles;
    }
  } catch (e) {
    // fallback ke function lama (return array plain)
  }
  const arr = await candles.getCandles('xauusd', tf, count);
  if (arr && arr.length) cache.set(k, arr, 60);
  return arr || [];
}

function getLastDataSource() {
  // ambil source dari cache entry terakhir yang masih ada
  for (const key of Object.keys(cache._s || {})) {
    if (key.endsWith(':meta')) {
      const meta = cache._s[key].v;
      if (typeof meta === 'string') return meta;
      if (meta && typeof meta === 'object') return meta.source || null;
    }
  }
  return null;
}

function candlePressureFallback(candleList) {
  const recent = (candleList || []).slice(-8);
  let bullishPressure = 0;
  let bearishPressure = 0;
  let net = 0;

  for (const candle of recent) {
    if (candle.close > candle.open) bullishPressure++;
    else if (candle.close < candle.open) bearishPressure++;
    net += candle.close - candle.open;
  }

  return {
    bullishPressure,
    bearishPressure,
    net,
    source: 'm5-candle-fallback',
    note: 'Fallback dari arah candle M5; bukan true footprint'
  };
}

function getIndicatorZoneCandidates(ta, bias, price) {
  const indicators = ta && ta.indicators ? ta.indicators : {};
  const levels = [];
  const supportNearest = Number(ta && ta.supportNearest);
  const resistanceNearest = Number(ta && ta.resistanceNearest);
  const zoneWidth = Math.max(Number(ta && ta.atr || 0) * 0.25, 0.15);

  if (bias === 'BULLISH') {
    if (Number.isFinite(supportNearest) && supportNearest < price) {
      levels.push({ type: 'SUPPORT_ZONE', level: supportNearest, label: 'support' });
    }
    if (Number.isFinite(indicators.bb_lower) && indicators.bb_lower < price) {
      levels.push({ type: 'BB_LOWER_ZONE', level: indicators.bb_lower, label: 'Bollinger lower band' });
    }
  } else if (bias === 'BEARISH') {
    if (Number.isFinite(resistanceNearest) && resistanceNearest > price) {
      levels.push({ type: 'RESISTANCE_ZONE', level: resistanceNearest, label: 'resistance' });
    }
    if (Number.isFinite(indicators.bb_upper) && indicators.bb_upper > price) {
      levels.push({ type: 'BB_UPPER_ZONE', level: indicators.bb_upper, label: 'Bollinger upper band' });
    }
  }

  return levels.map(item => ({
    type: item.type,
    label: item.label,
    direction: bias === 'BULLISH' ? 'BUY' : 'SELL',
    low: bias === 'BULLISH' ? item.level - zoneWidth : item.level,
    high: bias === 'BULLISH' ? item.level : item.level + zoneWidth,
    midpoint: item.level,
    source: 'technical-indicator'
  }));
}

function scoreZone(zone, bias, ta, pressure, methodAgreement) {
  const indicators = ta && ta.indicators ? ta.indicators : {};
  const bullish = bias === 'BULLISH';
  const score = {
    htfDirection: 2,
    technicalZone: zone.source === 'technical-indicator' ? 1 : 0,
    rsi: bullish ? indicators.rsi > 50 : indicators.rsi < 50,
    macd: bullish ? indicators.macd_hist > 0 : indicators.macd_hist < 0,
    ema: bullish ? ['STRONG_UP', 'WEAK_UP'].includes(indicators.ema_trend) : ['STRONG_DOWN', 'WEAK_DOWN'].includes(indicators.ema_trend),
    pressure: bullish ? pressure.net > 0 : pressure.net < 0,
    methodAgreement: methodAgreement && ((bullish && methodAgreement.direction === 'BUY') || (!bullish && methodAgreement.direction === 'SELL'))
  };

  return {
    ...zone,
    confluence: Object.entries(score).filter(([, ok]) => ok === true).map(([name]) => name),
    confluenceScore: Object.values(score).filter(Boolean).length
  };
}

async function getPressureWithFallback(candleList) {
  try {
    const flow = await dukascopy.getFlowProxy('XAUUSD', 8);
    if (flow && Array.isArray(flow.ticks) && flow.ticks.length >= 2) {
      return { ...flow, source: 'dukascopy-proxy', note: 'Tick pressure proxy' };
    }
  } catch (e) {
    logger.warn('Dukascopy fallback: ' + e.message);
  }

  try {
    const flow = await orderflow.getOrderFlow('XAU/USD', '5min', 8);
    if (flow && (flow.bullishVolume || flow.bearishVolume || flow.cumulativeDelta)) {
      return {
        bullishPressure: Number(flow.bullishVolume || 0),
        bearishPressure: Number(flow.bearishVolume || 0),
        net: Number(flow.cumulativeDelta || 0),
        source: 'oanda-orderflow-fallback',
        note: 'Fallback OANDA tick-volume proxy'
      };
    }
  } catch (e) {
    logger.warn('OANDA orderflow fallback: ' + e.message);
  }

  return candlePressureFallback(candleList);
}

// ======================================================
//  STATE MANAGEMENT (per user step)
// ======================================================
const userState = {}; // { chatId: { step, tf, mode } }

function setState(chatId, state) { userState[chatId] = { ...userState[chatId], ...state }; }
function getState(chatId) { return userState[chatId] || {}; }
function clearState(chatId) { delete userState[chatId]; }

// ======================================================
//  KEYBOARDS
// ======================================================
const TF_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: 'M1 ⚡', callback_data: 'tf_1m' },
        { text: 'M5', callback_data: 'tf_5m' },
        { text: 'M15', callback_data: 'tf_15m' },
        { text: 'M30', callback_data: 'tf_30m' }
      ],
      [
        { text: 'H1', callback_data: 'tf_1h' },
        { text: 'H4', callback_data: 'tf_4h' },
        { text: 'D1', callback_data: 'tf_1day' }
      ],
      [
        { text: '❌ Cancel', callback_data: 'cancel' }
      ]
    ]
  }
};

const MODE_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '⚡ Scalping', callback_data: 'mode_scalping' },
        { text: '📊 Intraday', callback_data: 'mode_intraday' }
      ],
      [
        { text: '📈 Swing', callback_data: 'mode_swing' }
      ],
      [
        { text: '⬅️ Kembali pilih TF', callback_data: 'back_tf' },
        { text: '❌ Cancel', callback_data: 'cancel' }
      ]
    ]
  }
};

// ======================================================
//  ICT ANALYSIS ENGINE
// ======================================================

// Deteksi struktur (BOS/CHoCH)
function detectStructure(candles) {
  if (!candles || candles.length < 10) return { trend: 'UNKNOWN', structure: 'NONE', lastSwing: null };
  const last = candles[candles.length - 1];
  const recent = candles.slice(-20);

  // Swing high/low detection
  const swingHighs = [];
  const swingLows = [];
  for (let i = 2; i < recent.length - 2; i++) {
    if (recent[i].high > recent[i-1].high && recent[i].high > recent[i+1].high &&
        recent[i].high > recent[i-2].high && recent[i].high > recent[i+2].high) {
      swingHighs.push({ i, price: recent[i].high });
    }
    if (recent[i].low < recent[i-1].low && recent[i].low < recent[i+1].low &&
        recent[i].low < recent[i-2].low && recent[i].low < recent[i+2].low) {
      swingLows.push({ i, price: recent[i].low });
    }
  }

  // Higher highs/lows detection
  let higherHighs = 0, lowerHighs = 0, higherLows = 0, lowerLows = 0;
  for (let i = 1; i < swingHighs.length; i++) {
    if (swingHighs[i].price > swingHighs[i-1].price) higherHighs++;
    else lowerHighs++;
  }
  for (let i = 1; i < swingLows.length; i++) {
    if (swingLows[i].price > swingLows[i-1].price) higherLows++;
    else lowerLows++;
  }

  const bullScore = higherHighs + higherLows;
  const bearScore = lowerHighs + lowerLows;

  let trend = 'RANGING';
  let structure = 'NONE';
  let lastSwing = null;

  if (bullScore > bearScore + 1) {
    trend = 'BULLISH';
    structure = last.close > (swingHighs[swingHighs.length-1]?.price || Infinity) ? 'BOS' : 'HIGHER_HIGHS_LOWS';
    lastSwing = swingHighs[swingHighs.length-1] || null;
  } else if (bearScore > bullScore + 1) {
    trend = 'BEARISH';
    structure = last.close < (swingLows[swingLows.length-1]?.price || 0) ? 'BOS' : 'LOWER_HIGHS_LOWS';
    lastSwing = swingLows[swingLows.length-1] || null;
  }

  return { trend, structure, lastSwing, swingHighs, swingLows };
}

// Premium/Discount + Fibonacci
function calcPremiumDiscount(candles) {
  if (!candles || candles.length < 5) return null;
  const last = candles[candles.length - 1];
  const lookback = candles.slice(-50);
  const swingHigh = Math.max(...lookback.map(c => c.high));
  const swingLow = Math.min(...lookback.map(c => c.low));
  const range = swingHigh - swingLow;
  const eq = (swingHigh + swingLow) / 2;

  // Fibonacci golden zone: 61.8% - 79% (untuk entry di discount buy / premium sell)
  const fib618 = swingLow + range * 0.618;
  const fib705 = swingLow + range * 0.705;
  const fib79 = swingLow + range * 0.79;

  const isPremium = last.close > eq;
  const inGoldenZone = isPremium
    ? (last.close >= fib705 && last.close <= fib79)  // premium golden zone (sell area)
    : (last.close >= fib618 && last.close <= fib705); // discount golden zone (buy area)

  return {
    swingHigh, swingLow, eq, range,
    fib618, fib705, fib79,
    isPremium, inGoldenZone,
    zone: isPremium ? 'PREMIUM' : 'DISCOUNT'
  };
}

// Deteksi sweep
function detectSweeps(candles) {
  if (!candles || candles.length < 20) return [];
  const recent = candles.slice(-30);
  const last = recent[recent.length - 1];
  const lookback = recent.slice(0, -1);

  const swingHighs = [];
  const swingLows = [];
  for (let i = 2; i < lookback.length - 2; i++) {
    if (lookback[i].high > lookback[i-1].high && lookback[i].high > lookback[i+1].high) {
      swingHighs.push(lookback[i].high);
    }
    if (lookback[i].low < lookback[i-1].low && lookback[i].low < lookback[i+1].low) {
      swingLows.push(lookback[i].low);
    }
  }

  const sweeps = [];
  // Bearish sweep: high tembus swing high, close di bawah (rejection → buy signal)
  for (const sh of swingHighs) {
    if (last.high > sh && last.close < sh) {
      sweeps.push({ type: 'BEARISH_SWEEP', level: sh, dir: 'BULL', rejection: true });
      break;
    }
  }
  // Bullish sweep: low tembus swing low, close di atas (rejection → sell signal)
  for (const sl of swingLows) {
    if (last.low < sl && last.close > sl) {
      sweeps.push({ type: 'BULLISH_SWEEP', level: sl, dir: 'BEAR', rejection: true });
      break;
    }
  }
  return sweeps;
}

// Session check (WIB = UTC+7)
function getSession() {
  const h = new Date().getUTCHours() + 7; // WIB
  const hMod = ((h % 24) + 24) % 24;
  if (hMod >= 14 && hMod < 17) return { name: 'London Open', emoji: '🇬🇧', inKillzone: true, wib: `${hMod}:00` };
  if (hMod >= 19.5 && hMod < 22) return { name: 'New York Open', emoji: '🇺🇸', inKillzone: true, wib: `${Math.floor(hMod)}:${hMod % 1 ? '30' : '00'}` };
  if (hMod >= 6 && hMod < 14) return { name: 'Asia', emoji: '🌏', inKillzone: false, wib: `${hMod}:00` };
  return { name: 'Off-hours', emoji: '⏸', inKillzone: false, wib: `${hMod}:00` };
}

// ======================================================
//  ANALISIS UTAMA
// ======================================================
async function fullAnalysis(execTF, mode) {
  // Mapping TF
  const tfMap = { '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '1h', '4h': '4h', '1day': '1day' };
  const tfInternal = mode === 'scalping' ? '5min' : (tfMap[execTF] || '15min');

  // Pilih HTF bias & mid TF berdasarkan mode
  let htfTF, midTF;
  if (mode === 'scalping') { htfTF = '1h'; midTF = '5min'; }
  else if (mode === 'intraday') { htfTF = '4h'; midTF = '1h'; }
  else { htfTF = '1day'; midTF = '4h'; }

  // Fetch parallel (termasuk data real-time 1m untuk 24h high/low)
  const [htf, mid, ltf, ta, realtime1m] = await Promise.all([
    getCandles(htfTF, 200),
    getCandles(midTF, 200),
    getCandles(tfInternal, 200),
    xauusdTA.analyze(true),
    getCandles('1min', 60).catch(() => []) // 60 menit terakhir untuk context
  ]);

  if (!htf.length || !mid.length || !ltf.length) {
    throw new Error('Data tidak cukup');
  }

  // 1. HTF BIAS
  const htfStruct = detectStructure(htf);
  const htfPD = calcPremiumDiscount(htf);
  const htfBias = htfStruct.trend; // BULLISH / BEARISH / RANGING
  const htfZone = htfPD ? htfPD.zone : 'UNKNOWN';

  // 2. MID TF: cari zone (OB / FVG)
  const ictA = ict.analyze(mid, { lookback: 80 });
  const lastLtf = ltf[ltf.length - 1].close;

  // Kandidat zona searah HTF bias, lalu dipilih berdasarkan konfluensi indikator.
  let zoneInfo = null;
  let zoneType = 'NONE';

  // 24h stats (real-time) — pakai 1day candle + 1m terakhir
  const dayCandle = htfTF === '1day' ? htf[htf.length - 1] : null;
  const day24Candles = ltf.slice(-96); // 96 × 15m = 24 jam, atau 288 × 5m = 24 jam
  const high24h = day24Candles.length ? Math.max(...day24Candles.map(c => c.high)) : (dayCandle ? dayCandle.high : lastLtf);
  const low24h = day24Candles.length ? Math.min(...day24Candles.map(c => c.low)) : (dayCandle ? dayCandle.low : lastLtf);
  // 24h ago price: ambil candle ke-(N-96) atau dari day candle open
  const open24h = dayCandle ? dayCandle.open : (day24Candles.length > 0 ? day24Candles[0].open : lastLtf);
  const change24h = lastLtf - open24h;
  const changePct = open24h ? (change24h / open24h) * 100 : 0;
  const realtimePrice = realtime1m.length ? realtime1m[realtime1m.length - 1].close : lastLtf;
  const pressure = await getPressureWithFallback(mid);
  const normalizedPressure = pressure && typeof pressure === 'object' ? {
    bullishPressure: Number(pressure.bullishPressure || 0),
    bearishPressure: Number(pressure.bearishPressure || 0),
    net: Number(pressure.net || 0),
    source: pressure.source || 'm5-candle-fallback',
    note: pressure.note || 'Proxy data only'
  } : {
    bullishPressure: 0,
    bearishPressure: 0,
    net: 0,
    source: 'unavailable',
    note: 'Pressure data unavailable'
  };
  const confluenceAnalysisResult = confluenceAnalysis.analyzeConfluence({
    candles: mid,
    timeframes: { H1: htf, M5: mid, LTF: ltf },
    ta,
    pressure: normalizedPressure
  });

  const taSignal = ta && typeof ta.signal === 'string' ? ta.signal : '';
  const indicatorBias = htfBias === 'RANGING'
    ? (taSignal.includes('BUY') ? 'BULLISH' : taSignal.includes('SELL') ? 'BEARISH' : 'RANGING')
    : htfBias;
  const ictCandidates = indicatorBias === 'BULLISH'
    ? [
        ...(ictA.orderBlocks || []).filter(o => o.type === 'BULLISH_OB' && o.high < lastLtf),
        ...(ictA.fvgs || []).filter(f => f.type === 'BULLISH_FVG' && f.high < lastLtf)
      ]
    : indicatorBias === 'BEARISH'
      ? [
          ...(ictA.orderBlocks || []).filter(o => o.type === 'BEARISH_OB' && o.low > lastLtf),
          ...(ictA.fvgs || []).filter(f => f.type === 'BEARISH_FVG' && f.low > lastLtf)
        ]
      : [];
  const indicatorCandidates = getIndicatorZoneCandidates(ta, indicatorBias, lastLtf);
  const zoneCandidates = [...ictCandidates, ...indicatorCandidates]
    .map(zone => scoreZone(zone, indicatorBias, ta, normalizedPressure, confluenceAnalysisResult.methodAgreement))
    .sort((a, b) => b.confluenceScore - a.confluenceScore);

  if (zoneCandidates.length) {
    zoneInfo = zoneCandidates[0];
    zoneType = zoneInfo.type;
  }

  // 3. LTF: deteksi sweep
  const ltfSweeps = detectSweeps(ltf);
  const ltfStruct = detectStructure(ltf);

  // 4. Entry direction
  const direction = zoneInfo
    ? (zoneInfo.direction || (zoneType.startsWith('BULLISH') ? 'BUY' : 'SELL'))
    : (htfBias === 'BULLISH' ? 'BUY' : htfBias === 'BEARISH' ? 'SELL' : 'NONE');
  // 5. Entry, SL, TP
  let entry, sl, tp1, tp2, slPips, tp1Pips, tp2Pips;
  const scalpDistance = 0.50;
  const newsBlocked = mode === 'scalping' && process.env.HIGH_IMPACT_NEWS === 'true';
  const scalpNoTrade = mode === 'scalping' && (htfBias === 'RANGING' || !zoneInfo || newsBlocked);
  if (zoneInfo) {
    entry = zoneInfo.midpoint || zoneInfo.price;
    if (mode === 'scalping') {
      sl = direction === 'BUY' ? entry - scalpDistance : entry + scalpDistance;
      tp1 = direction === 'BUY' ? entry + scalpDistance : entry - scalpDistance;
      tp2 = direction === 'BUY' ? entry + scalpDistance * 1.5 : entry - scalpDistance * 1.5;
    } else if (direction === 'BUY') {
      sl = zoneInfo.low - 0.50;
      const slDist = entry - sl;
      tp1 = entry + slDist * 1.5;
      tp2 = entry + slDist * 2.5;
    } else {
      sl = zoneInfo.high + 0.50;
      const slDist = sl - entry;
      tp1 = entry - slDist * 1.5;
      tp2 = entry - slDist * 2.5;
    }
  } else {
    // Fallback: pakai current price
    entry = lastLtf;
    if (mode === 'scalping') {
      sl = direction === 'BUY' ? entry - scalpDistance : entry + scalpDistance;
      tp1 = direction === 'BUY' ? entry + scalpDistance : entry - scalpDistance;
      tp2 = direction === 'BUY' ? entry + scalpDistance * 1.5 : entry - scalpDistance * 1.5;
    } else if (direction === 'BUY') {
      sl = entry - 0.50;
      tp1 = entry + 0.75;
      tp2 = entry + 1.25;
    } else {
      sl = entry + 0.50;
      tp1 = entry - 0.75;
      tp2 = entry - 1.25;
    }
  }

  slPips = Math.round(Math.abs(entry - sl) / 0.01);
  tp1Pips = Math.round(Math.abs(tp1 - entry) / 0.01);
  tp2Pips = Math.round(Math.abs(tp2 - entry) / 0.01);

  // 6. CONFLUENCE SCORING
  const confluence = {
    ictStructure: htfStruct.structure !== 'NONE' && htfStruct.structure !== 'HIGHER_HIGHS_LOWS' && htfStruct.structure !== 'LOWER_HIGHS_LOWS' ? true : (htfStruct.structure === 'HIGHER_HIGHS_LOWS' || htfStruct.structure === 'LOWER_HIGHS_LOWS'),
    supplyDemand: htfPD && htfPD.inGoldenZone,
    killzone: getSession().inKillzone,
    fibonacci: htfPD && htfPD.inGoldenZone,
    momentum: ta.ok && ta.indicators && (
      (direction === 'BUY' && ta.indicators.rsi > 30 && ta.indicators.rsi < 70) ||
      (direction === 'SELL' && ta.indicators.rsi > 30 && ta.indicators.rsi < 70)
    )
  };

  const score = Object.values(confluence).filter(Boolean).length;
  let probability;
  if (score >= 5) probability = 'High Probability';
  else if (score >= 3) probability = 'Medium Probability';
  else probability = 'Low Probability';

  // 7. Invalidation level
  let invalidation;
  if (zoneInfo) {
    invalidation = direction === 'BUY' ? zoneInfo.low - 0.30 : zoneInfo.high + 0.30;
  } else {
    invalidation = direction === 'BUY' ? lastLtf - 0.80 : lastLtf + 0.80;
  }

  // 8. Waktu WIB
  const now = new Date();
  const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const wibStr = wib.toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  return {
    execTF, mode, direction,
    entry, sl, tp1, tp2, slPips, tp1Pips, tp2Pips,
    zoneInfo, zoneType,
    htfBias, htfStruct, htfPD, htfZone,
    midTF, htfTF,
    ltfSweeps, ltfStruct,
    confluence, score, probability,
    scalpNoTrade, newsBlocked,
    invalidation, wibStr,
    lastLtf,
    realtimePrice, high24h, low24h, open24h, change24h, changePct,
    dataSource: getLastDataSource(),
    pressure: normalizedPressure,
    confluenceAnalysis: confluenceAnalysisResult,
    ta
  };
}

// ======================================================
//  FORMAT OUTPUT
// ======================================================
function formatScalpingAnalysis(a) {
  const methods = a.confluenceAnalysis || {};
  const wyckoff = methods.wyckoff || {};
  const vp = methods.volumeProfile || {};
  const vwap = methods.vwap || {};
  const mp = methods.marketProfile || {};
  const ema = methods.emaConfluence || {};
  const biasReason = a.htfBias === 'BULLISH'
    ? `struktur H1 bullish (${a.htfStruct.structure}), harga berada di zona ${a.htfZone}`
    : a.htfBias === 'BEARISH'
      ? `struktur H1 bearish (${a.htfStruct.structure}), harga berada di zona ${a.htfZone}`
      : 'struktur H1 sideways/choppy';
  if (a.scalpNoTrade) {
    const reason = a.newsBlocked
      ? 'ada indikasi news high-impact; hindari 15 menit sebelum/sesudah rilis'
      : a.htfBias === 'RANGING'
        ? 'bias H1 tidak jelas atau choppy'
        : 'belum ditemukan zona entry M5 yang valid searah bias H1';
    return `🚫 NO TRADE — XAUUSD, ${reason}.\n\n` +
      `1. HTF BIAS H1\n   ${a.htfBias} — ${biasReason}.\n\n` +
      `2. ENTRY ZONE M5\n   Belum valid; tunggu ${a.htfBias === 'BEARISH' ? 'supply' : 'demand'} searah bias.\n\n` +
      `3. FLOW CONFIRMATION\n   ${formatPressure(a.pressure)}\n` +
      `4. MARKET CONTEXT\n   Wyckoff: ${wyckoff.phase || 'N/A'} / ${wyckoff.event || 'NONE'}\n` +
      `   VWAP: ${fmt(vwap.vwap)} | VPOC: ${fmt(vp.vpoc)}\n` +
      `   20-METHOD AGREEMENT: ${formatMethodAgreement(methods.methodAgreement)}\n` +
      `⏳ Validasi ulang dalam 5 menit.\n` +
      `📝 CATATAN: scalping tidak boleh dipaksakan; cek kalender news high-impact dan spread secara manual.`;
  }

  const directionSign = a.direction === 'BUY' ? '+' : '-';
  const zone = a.zoneInfo ? `${fmt(a.zoneInfo.low)} - ${fmt(a.zoneInfo.high)} (${a.zoneType})` : 'current price, tanpa OB/FVG valid';
  return `⚡ SCALPING SIGNAL\n` +
    `📊 PAIR: XAUUSD\n` +
    `1. HTF BIAS H1\n` +
    `   ${a.direction} — ${biasReason}; filter arah saja.\n\n` +
    `2. ENTRY ZONE M5\n` +
    `   ${zone}\n` +
    `   Entry: ${fmt(a.zoneInfo?.low)} - ${fmt(a.zoneInfo?.high)}\n` +
    `   Konfluensi: ${(a.zoneInfo?.confluence || []).join(', ') || 'belum ada'} (${a.zoneInfo?.confluenceScore || 0} faktor)\n` +
    `   Narasi: H1 memberi arah ${a.direction}; M5 menyediakan ${a.zoneType} sebagai area retracement.\n\n` +
    `3. FLOW CONFIRMATION\n` +
    `   ${formatPressure(a.pressure)}\n\n` +
    `4. MULTI-INDICATOR CHECK\n` +
    `   20-method agreement: ${formatMethodAgreement(methods.methodAgreement)}\n` +
    `   Wyckoff: ${wyckoff.phase || 'N/A'}${wyckoff.event && wyckoff.event !== 'NONE' ? ` / ${wyckoff.event}` : ''}\n` +
    `   VPOC: ${fmt(vp.vpoc)} | Value Area: ${fmt(vp.valueAreaLow)} - ${fmt(vp.valueAreaHigh)}\n` +
    `   VWAP: ${fmt(vwap.vwap)} | Bands: ${fmt(vwap.lower)} - ${fmt(vwap.upper)}\n` +
    `   TPO/Market Profile: IB ${fmt(mp.initialBalanceLow)} - ${fmt(mp.initialBalanceHigh)} | POC ${fmt(mp.poc)}\n` +
    `   Supply/Demand: ${methods.supplyDemand?.type || 'NONE'} | Harmonic: ${methods.harmonic?.pattern || 'NONE'}\n` +
    `   Elliott: ${methods.elliott?.phase || 'N/A'} | EMA MTF: ${ema.H1?.direction || 'N/A'} / ${ema.M5?.direction || 'N/A'}\n\n` +
    `🛑 STOP LOSS: ${fmt(a.sl)} (–50 pips)\n` +
    `✅ TAKE PROFIT 1: ${fmt(a.tp1)} (${directionSign}50 pips, RR 1:1)\n` +
    `✅ TAKE PROFIT 2: ${fmt(a.tp2)} (${directionSign}75 pips, RR 1:1.5)\n` +
    `⏳ VALID SELAMA: 15-20 menit sejak sinyal dikirim\n` +
    `📝 CATATAN: time stop bila harga belum bergerak sesuai arah setelah 15-20 menit. Hindari 15 menit sebelum/sesudah news high-impact; kalender news belum terhubung otomatis.`;
}

function formatPressure(pressure) {
  const p = pressure || {};
  const bullish = Number(p.bullishPressure || 0);
  const bearish = Number(p.bearishPressure || 0);
  const net = Number(p.net || 0);
  const netLabel = `${net >= 0 ? '+' : ''}${fmt(net, 2)}`;
  const source = p.source || 'unavailable';
  const note = p.note ? ` — ${p.note}` : '';
  return `Bullish: ${bullish} | Bearish: ${bearish} | Net: ${netLabel}\n   Source: ${source}${note}`;
}

function formatMethodAgreement(agreement) {
  const result = agreement || {};
  return `${result.direction || 'MIXED'} (${result.buy || 0} BUY / ${result.sell || 0} SELL dari ${result.total || 0}, confidence ${result.confidence || 0}%)`;
}

function formatAnalysis(a) {
  if (a.mode === 'scalping') return formatScalpingAnalysis(a);
  const tfLabel = { '1m': 'M1', '5m': 'M5', '15m': 'M15', '30m': 'M30', '1h': 'H1', '4h': 'H4', '1day': 'D1' }[a.execTF];
  const em = a.direction === 'BUY' ? '🟢' : a.direction === 'SELL' ? '🔴' : '⚪';

  const lines = [];
  lines.push(`📊 XAUUSD ANALYSIS — Mode: ${a.mode.toUpperCase()}`);
  lines.push(`🕒 Timeframe Acuan: ${tfLabel}`);
  lines.push(`📅 Waktu Analisa: ${a.wibStr} WIB`);
  lines.push('');

  const changeSign = a.change24h >= 0 ? '+' : '';
  const changeEmoji = a.change24h >= 0 ? '📈' : '📉';
  const distToHigh = ((a.high24h - a.realtimePrice) / a.realtimePrice * 100).toFixed(2);
  const distToLow = ((a.realtimePrice - a.low24h) / a.realtimePrice * 100).toFixed(2);
  const rtLine = `   XAUUSD: $${fmt(a.realtimePrice)}`;

  const sourceName = typeof a.dataSource === 'string' ? a.dataSource : (a.dataSource && a.dataSource.source) || '';
  const sourceLabel = sourceName || (a.pressure && a.pressure.source) || 'twelvedata';
  let delayInfo = '~15min delay';
  if (sourceLabel.startsWith('oanda')) delayInfo = 'real-time';
  else if (sourceLabel.startsWith('twelvedata')) delayInfo = '~15min delay';
  else if (sourceLabel.startsWith('dukascopy')) delayInfo = 'real-time proxy';

  lines.push('💰 HARGA REAL-TIME');
  lines.push(rtLine);
  lines.push(`   ${changeEmoji} 24h: ${changeSign}${fmt(a.change24h)} (${changeSign}${fmt(a.changePct, 2)}%)`);
  lines.push(`   📊 24h High: $${fmt(a.high24h)} | Low: $${fmt(a.low24h)}`);
  lines.push(`   📏 Jarak ke High: ${distToHigh}% | ke Low: ${distToLow}%`);
  lines.push(`   📡 Source: ${sourceLabel} (${delayInfo})`);
  const pressure = a.pressure || { bullishPressure: 0, bearishPressure: 0, net: 0, source: 'dukascopy-proxy' };
  lines.push('   💧 PRESSURE CONFIRMATION');
  lines.push(`      ${formatPressure(pressure)}`);
  lines.push('');

  const biasEmoji = a.htfBias === 'BULLISH' ? '🟢' : a.htfBias === 'BEARISH' ? '🔴' : '🟡';
  lines.push(`🔎 HTF BIAS (${a.htfTF}): ${biasEmoji} ${a.htfBias}`);
  lines.push(`   Struktur: ${a.htfStruct.structure}${a.htfStruct.lastSwing ? ' di level ' + fmt(a.htfStruct.lastSwing.price) : ''}`);
  lines.push(`   Zona: ${a.htfZone}`);
  lines.push('');

  const indicators = a.ta && a.ta.indicators ? a.ta.indicators : {};
  lines.push('📐 KONFIRMASI INDIKATOR');
  lines.push(`   Signal: ${a.ta?.signal || 'N/A'} (${a.ta?.confidence || 0}%)`);
  lines.push(`   RSI: ${fmt(indicators.rsi, 1)} | MACD histogram: ${fmt(indicators.macd_hist, 2)}`);
  lines.push(`   EMA trend: ${indicators.ema_trend || 'N/A'} | BB position: ${fmt(indicators.bb_pct, 2)}`);
  lines.push(`   Support: ${fmt(a.ta?.supportNearest)} | Resistance: ${fmt(a.ta?.resistanceNearest)}`);
  lines.push('');

  const methods = a.confluenceAnalysis || {};
  const vp = methods.volumeProfile || {};
  const vwap = methods.vwap || {};
  const mp = methods.marketProfile || {};
  const wyckoff = methods.wyckoff || {};
  lines.push('🧭 KONFLUENSI TAMBAHAN');
  lines.push(`   Wyckoff: ${wyckoff.phase || 'N/A'} / ${wyckoff.event || 'NONE'}${wyckoff.volumeConfirmed ? ' / volume confirmed' : ''}`);
  lines.push(`   Volume Profile: VPOC ${fmt(vp.vpoc)} | VA ${fmt(vp.valueAreaLow)} - ${fmt(vp.valueAreaHigh)}`);
  lines.push(`   VWAP: ${fmt(vwap.vwap)} | dev bands ${fmt(vwap.lower)} - ${fmt(vwap.upper)}`);
  lines.push(`   Market Profile: IB ${fmt(mp.initialBalanceLow)} - ${fmt(mp.initialBalanceHigh)} | POC ${fmt(mp.poc)}`);
  lines.push(`   Supply/Demand: ${methods.supplyDemand?.type || 'NONE'} | Harmonic: ${methods.harmonic?.pattern || 'NONE'}`);
  lines.push(`   Elliott: ${methods.elliott?.phase || 'N/A'} | EMA MTF H1/M5: ${methods.emaConfluence?.H1?.direction || 'N/A'}/${methods.emaConfluence?.M5?.direction || 'N/A'}`);
  lines.push('   Macro: DXY/US10Y/real yield belum terhubung');
  lines.push('');

  if (a.zoneInfo) {
    const zLow = fmt(a.zoneInfo.low);
    const zHigh = fmt(a.zoneInfo.high);
    lines.push('📍 ZONA ENTRY');
    lines.push(`   Tipe: ${a.zoneType}`);
    lines.push(`   Range: ${zLow} – ${zHigh}`);
    lines.push(`   Timeframe konfirmasi: ${a.midTF}`);
  } else {
    lines.push('📍 ZONA ENTRY');
    lines.push('   ⚠️ Tidak ada OB/FVG searah bias, fallback ke current price');
  }
  lines.push('');

  if (a.direction !== 'NONE') {
    lines.push('🎯 SKENARIO TRADE');
    lines.push(`   Arah: ${em} ${a.direction}`);
    lines.push(`   Entry: ${fmt(a.entry)}`);
    lines.push(`   Stop Loss: ${fmt(a.sl)} (≈ ${a.slPips} pips)`);
    lines.push(`   Take Profit 1: ${fmt(a.tp1)} (RR 1:1.5)`);
    lines.push(`   Take Profit 2: ${fmt(a.tp2)} (RR 1:2.5)`);
    const rr = a.tp2Pips / Math.max(1, a.slPips);
    lines.push(`   Risk : Reward: 1:${fmt(rr, 2)}`);
  } else {
    lines.push('🎯 SKENARIO TRADE');
    lines.push('   ⚠️ Tidak ada arah jelas, bias ranging. Tunggu konfirmasi.');
  }
  lines.push('');

  const c = a.confluence;
  lines.push('✅ KONFLUENSI TERPENUHI:');
  lines.push(`   ${c.ictStructure ? '✅' : '❌'} ICT/SMC Structure (OB/FVG/Liquidity Sweep)`);
  lines.push(`   ${c.supplyDemand ? '✅' : '❌'} Supply/Demand Zone`);
  lines.push(`   ${c.killzone ? '✅' : '❌'} Killzone Session Timing`);
  lines.push(`   ${c.fibonacci ? '✅' : '❌'} Fibonacci Golden Zone`);
  lines.push(`   ${c.momentum ? '✅' : '❌'} Momentum/Volume Confirmation`);
  lines.push(`   Skor: ${a.score}/5 = ${a.probability}`);
  lines.push('');

  lines.push('⚠️ CATATAN RISIKO:');
  lines.push('   • Perhatikan jadwal rilis berita high impact hari ini.');
  lines.push('   • Ini analisa probabilistik, bukan sinyal pasti profit.');
  lines.push('   • Gunakan money management, risk per trade 1–2% modal.');
  lines.push('');

  lines.push('🔁 INVALIDASI SETUP:');
  lines.push(`   Jika harga menembus ${fmt(a.invalidation)} sebelum entry aktif, setup dianggap batal.`);
  lines.push('');

  lines.push('⚠️ Disclaimer: Analisa ini bersifat edukasi dan bukan nasihat keuangan atau ajakan trading. Trading forex/gold mengandung risiko tinggi, termasuk risiko kehilangan modal. Gunakan manajemen risiko yang tepat.');

  return lines.join('\n');
}

// ======================================================
//  COMMANDS
// ======================================================
const WELCOME = (n) => `Halo ${n}! 👋

🏆 XAUUSD ICT/SMC Analyst

Bot analisa teknikal XAUUSD berbasis ICT/SMC + 5 konfluensi.

📊 CARA PAKAI:
/xauusd — Mulai analisa (pilih TF & mode)
/help — Bantuan
/status — Status bot & session
/cancel — Batalkan analisa

⚠️ Bukan saran finansial. Gunakan MM.`;

bot.onText(/^\/start$/, (m) => {
  bot.sendMessage(m.chat.id, WELCOME(m.from.first_name || 'Trader'));
  logger.info('User: ' + m.from.first_name);
});

bot.onText(/^\/help$/, (m) => {
  bot.sendMessage(m.chat.id, WELCOME(m.from.first_name || 'Trader'));
});

bot.onText(/^\/cancel$/, (m) => {
  clearState(m.chat.id);
  bot.sendMessage(m.chat.id, '❌ Analisa dibatalkan.');
});

const bootTime = Date.now();
bot.onText(/^\/status$/, (m) => {
  const up = Math.floor((Date.now() - bootTime) / 1000);
  const h = Math.floor(up / 3600);
  const min = Math.floor((up % 3600) / 60);
  const s = up % 60;
  const sess = getSession();
  bot.sendMessage(m.chat.id,
    `🟢 STATUS\n` +
    `⏱ ${h}h ${min}m ${s}s\n` +
    `📡 Data: ${TD_KEY ? '✅' : '🟡'}\n` +
    `🌐 Session: ${sess.emoji} ${sess.name} (${sess.wib} WIB)\n` +
    `⚡ Killzone: ${sess.inKillzone ? 'YA ✅' : 'TIDAK ❌'}`
  );
});

// /xauusd — mulai flow interaktif
bot.onText(/^\/xauusd$/, (m) => {
  const cid = m.chat.id;
  if (!limiter.checkLimit('/xauusd')) return bot.sendMessage(cid, '⏳ Tunggu sebentar...');
  setState(cid, { step: 'tf' });
  bot.sendMessage(cid,
    `📊 XAUUSD ANALYSIS\n\nPilih Timeframe eksekusi:`,
    { ...TF_KEYBOARD }
  );
});

// ======================================================
//  CALLBACK HANDLER (tombol inline)
// ======================================================
bot.on('callback_query', async (q) => {
  const cid = q.message.chat.id;
  const data = q.data;
  const st = getState(cid);

  if (data === 'cancel') {
    clearState(cid);
    await bot.answerCallbackQuery(q.id, { text: 'Cancelled' });
    return bot.editMessageText('❌ Analisa dibatalkan.', { chat_id: cid, message_id: q.message.message_id });
  }

  if (data === 'back_tf') {
    setState(cid, { step: 'tf' });
    await bot.answerCallbackQuery(q.id);
    return bot.editMessageText(
      `📊 XAUUSD ANALYSIS\n\nPilih Timeframe eksekusi:`,
      { chat_id: cid, message_id: q.message.message_id, ...TF_KEYBOARD }
    );
  }

  // Step 1: Pilih TF
  if (data.startsWith('tf_') && st.step === 'tf') {
    const tf = data.replace('tf_', '');
    setState(cid, { step: 'mode', tf });
    const tfLabel = { '1m': 'M1', '5m': 'M5', '15m': 'M15', '30m': 'M30', '1h': 'H1', '4h': 'H4', '1day': 'D1' }[tf];
    await bot.answerCallbackQuery(q.id, { text: `TF: ${tfLabel}` });
    return bot.editMessageText(
      `📊 XAUUSD ANALYSIS\n\nTF: ${tfLabel}\n\nPilih Mode trading:`,
      { chat_id: cid, message_id: q.message.message_id, ...MODE_KEYBOARD }
    );
  }

  // Step 2: Pilih Mode → generate analisa
  if (data.startsWith('mode_') && st.step === 'mode') {
    const mode = data.replace('mode_', '');
    const tf = st.tf;
    const tfLabel = { '1m': 'M1', '5m': 'M5', '15m': 'M15', '30m': 'M30', '1h': 'H1', '4h': 'H4', '1day': 'D1' }[tf];

    await bot.answerCallbackQuery(q.id, { text: `Mode: ${mode}` });

    // Tampilkan loading
    await bot.editMessageText(
      `⏳ Generating analisa ${tfLabel} ${mode}...`,
      { chat_id: cid, message_id: q.message.message_id }
    );

    try {
      const a = await fullAnalysis(tf, mode);
      const text = formatAnalysis(a);
      clearState(cid);

      // Telegram max 4096 chars
      if (text.length <= 4000) {
        await bot.editMessageText(text, {
          chat_id: cid, message_id: q.message.message_id
        });
      } else {
        // Split jadi 2 pesan
        const half = Math.floor(text.length / 2);
        const splitAt = text.lastIndexOf('\n', half);
        await bot.editMessageText(text.substring(0, splitAt), {
          chat_id: cid, message_id: q.message.message_id
        });
        await bot.sendMessage(cid, text.substring(splitAt));
      }
    } catch (e) {
      logger.error('analysis err: ' + e.message);
      clearState(cid);
      await bot.editMessageText('❌ Error: ' + e.message, { chat_id: cid, message_id: q.message.message_id });
    }
  }
});

// ======================================================
//  Auto-reply
// ======================================================
bot.on('message', (m) => {
  if (m.text && m.text.startsWith('/')) return;
  const t = (m.text || '').toLowerCase();
  const n = m.from.first_name || 'Trader';
  let r = '';
  if (/halo|hai|hello|hi/.test(t)) r = `Halo ${n}! 👋 Ketik /xauusd untuk analisa.`;
  else if (/analisa|signal|gold|emas|xau/.test(t)) r = `Coba /xauusd ya ${n} 📊`;
  else if (/help|bantu/.test(t)) r = 'Ketik /help untuk info.';
  else if (t.length > 0) r = `Hai ${n}! Ketik /xauusd untuk mulai analisa.`;
  if (r) bot.sendMessage(m.chat.id, r);
});

// ======================================================
//  START
// ======================================================
console.log('⏳ Waiting 25s...');
setTimeout(() => {
  console.log('✓ Polling started');
  bot.startPolling().catch(e => console.error('startPolling err:', e.message));
}, 25000);

bot.on('polling_error', (err) => {
  if (err.message.includes('409') || err.message.includes('Conflict')) {
    console.log('⚠️ 409 conflict, restart in 15s...');
    setTimeout(() => {
      bot.stopPolling().then(() => {
        setTimeout(() => bot.startPolling().catch(() => {}), 1000);
      });
    }, 15000);
  } else {
    console.error('❌ Polling:', err.message);
  }
});
