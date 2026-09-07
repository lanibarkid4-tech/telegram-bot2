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
  const tfInternal = mode === 'scalping' ? '1min' : (tfMap[execTF] || '15min');

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

  // Pilih zone searah HTF bias
  let zoneInfo = null;
  let zoneType = 'NONE';
  const buySignal = htfBias === 'BULLISH';
  const sellSignal = htfBias === 'BEARISH';

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

  if (buySignal || htfBias === 'RANGING') {
    // Cari BULLISH OB di bawah harga
    const buyOB = (ictA.orderBlocks || []).find(o => o.type === 'BULLISH_OB' && o.high < lastLtf);
    const buyFVG = (ictA.fvgs || []).find(f => f.type === 'BULLISH_FVG' && f.high < lastLtf);
    if (buyOB) { zoneInfo = buyOB; zoneType = 'BULLISH_OB'; }
    else if (buyFVG) { zoneInfo = buyFVG; zoneType = 'BULLISH_FVG'; }
  }
  if (sellSignal || (htfBias === 'RANGING' && !zoneInfo)) {
    const sellOB = (ictA.orderBlocks || []).find(o => o.type === 'BEARISH_OB' && o.low > lastLtf);
    const sellFVG = (ictA.fvgs || []).find(f => f.type === 'BEARISH_FVG' && f.low > lastLtf);
    if (sellOB) { zoneInfo = sellOB; zoneType = 'BEARISH_OB'; }
    else if (sellFVG) { zoneInfo = sellFVG; zoneType = 'BEARISH_FVG'; }
  }

  // 3. LTF: deteksi sweep
  const ltfSweeps = detectSweeps(ltf);
  const ltfStruct = detectStructure(ltf);

  // 4. Entry direction
  const direction = zoneInfo
    ? (zoneType.startsWith('BULLISH') ? 'BUY' : 'SELL')
    : (htfBias === 'BULLISH' ? 'BUY' : htfBias === 'BEARISH' ? 'SELL' : 'NONE');
  const ltfPrev = ltf[ltf.length - 2];
  const ltfLast = ltf[ltf.length - 1];
  const bullishTrigger = ltfLast && ltfPrev && ltfLast.close > ltfLast.open && ltfLast.close > ltfPrev.high;
  const bearishTrigger = ltfLast && ltfPrev && ltfLast.close < ltfLast.open && ltfLast.close < ltfPrev.low;
  const m1Trigger = direction === 'BUY' && bullishTrigger
    ? 'Bullish candle + break struktur mikro (BOS)'
    : direction === 'SELL' && bearishTrigger
      ? 'Bearish candle + break struktur mikro (BOS)'
      : null;

  // 5. Entry, SL, TP
  let entry, sl, tp1, tp2, slPips, tp1Pips, tp2Pips;
  const scalpDistance = 0.50;
  const newsBlocked = mode === 'scalping' && process.env.HIGH_IMPACT_NEWS === 'true';
  const scalpNoTrade = mode === 'scalping' && (htfBias === 'RANGING' || !m1Trigger || newsBlocked);
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
    scalpNoTrade, newsBlocked, m1Trigger,
    invalidation, wibStr,
    lastLtf,
    realtimePrice, high24h, low24h, open24h, change24h, changePct,
    dataSource: getLastDataSource(),
    ta
  };
}

// ======================================================
//  FORMAT OUTPUT
// ======================================================
function formatScalpingAnalysis(a) {
  const biasReason = a.htfBias === 'BULLISH'
    ? 'struktur bullish H1'
    : a.htfBias === 'BEARISH'
      ? 'struktur bearish H1'
      : 'struktur H1 sideways/choppy';
  if (a.scalpNoTrade) {
    const reason = a.newsBlocked
      ? 'ada indikasi news high-impact; hindari 15 menit sebelum/sesudah rilis'
      : a.htfBias === 'RANGING'
        ? 'bias H1 tidak jelas atau choppy'
        : 'trigger M1 belum terkonfirmasi searah bias H1';
    return `🚫 NO TRADE — XAUUSD, ${reason}.\n\n` +
      `🕐 BIAS H1: ${a.htfBias} — ${biasReason}.\n` +
      `📉 STRUKTUR M5: tunggu zona ${a.htfBias === 'BEARISH' ? 'supply' : 'demand'} yang searah bias.\n` +
      `⏱️ TRIGGER M1: belum valid.\n` +
      `⏳ Validasi ulang dalam 5 menit.\n` +
      `📝 CATATAN: scalping tidak boleh dipaksakan; cek kalender news high-impact dan spread secara manual.`;
  }

  const directionSign = a.direction === 'BUY' ? '+' : '-';
  const zone = a.zoneInfo ? `${fmt(a.zoneInfo.low)} - ${fmt(a.zoneInfo.high)} (${a.zoneType})` : 'current price, tanpa OB/FVG valid';
  return `⚡ SCALPING SIGNAL\n` +
    `📊 PAIR: XAUUSD\n` +
    `🕐 BIAS H1: ${a.direction} — ${biasReason}; filter arah saja.\n` +
    `📉 STRUKTUR M5: ${zone}\n` +
    `⏱️ TRIGGER M1: ${a.m1Trigger}\n` +
    `🎯 ENTRY ZONE: ${fmt(a.entry)} (range sempit, eksekusi cepat)\n` +
    `🛑 STOP LOSS: ${fmt(a.sl)} (–50 pips)\n` +
    `✅ TAKE PROFIT 1: ${fmt(a.tp1)} (${directionSign}50 pips, RR 1:1)\n` +
    `✅ TAKE PROFIT 2: ${fmt(a.tp2)} (${directionSign}75 pips, RR 1:1.5)\n` +
    `⏳ VALID SELAMA: 15-20 menit sejak sinyal dikirim\n` +
    `📝 CATATAN: time stop bila harga belum bergerak sesuai arah setelah 15-20 menit. Hindari 15 menit sebelum/sesudah news high-impact; kalender news belum terhubung otomatis.`;
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
  const sourceLabel = sourceName || 'twelvedata';
  let delayInfo = '~15min delay';
  if (sourceLabel.startsWith('oanda')) delayInfo = 'real-time';
  else if (sourceLabel.startsWith('twelvedata')) delayInfo = '~15min delay';

  lines.push('💰 HARGA REAL-TIME');
  lines.push(rtLine);
  lines.push(`   ${changeEmoji} 24h: ${changeSign}${fmt(a.change24h)} (${changeSign}${fmt(a.changePct, 2)}%)`);
  lines.push(`   📊 24h High: $${fmt(a.high24h)} | Low: $${fmt(a.low24h)}`);
  lines.push(`   📏 Jarak ke High: ${distToHigh}% | ke Low: ${distToLow}%`);
  lines.push(`   📡 Source: ${sourceLabel} (${delayInfo})`);
  lines.push('');

  const biasEmoji = a.htfBias === 'BULLISH' ? '🟢' : a.htfBias === 'BEARISH' ? '🔴' : '🟡';
  lines.push(`🔎 HTF BIAS (${a.htfTF}): ${biasEmoji} ${a.htfBias}`);
  lines.push(`   Struktur: ${a.htfStruct.structure}${a.htfStruct.lastSwing ? ' di level ' + fmt(a.htfStruct.lastSwing.price) : ''}`);
  lines.push(`   Zona: ${a.htfZone}`);
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
