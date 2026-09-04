// ======================================================
//  🤖 XAU/USD ANALYST — Pure Teknikal + ICT
// ======================================================
//  Strategy:
//   1. TREND FOLLOWING  → EMA 9/21/50 alignment
//   2. REVERSAL         → Sweep + CISD di premium/discount
//   3. MOMENTUM         → RSI + MACD histogram confirm
//
//  Modules: candles, xauusd-ta, ict-structures, utils
// ======================================================

require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');

const candles = require('./candles');
const xauusdTA = require('./xauusd-ta');
const ict = require('./ict-structures');
const { RateLimiter, Logger, GracefulShutdown } = require('./utils');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TOKEN) {
  console.log('❌ TELEGRAM_BOT_TOKEN kosong! Isi di .env');
  process.exit(1);
}

const TD_KEY = process.env.TWELVE_DATA_API_KEY;
console.log('========================================');
console.log('✅ XAU/USD ANALYST (Pure Teknikal + ICT)');
console.log('📡 TwelveData: ' + (TD_KEY ? 'ON' : 'OFF'));
console.log('⏰ ' + new Date().toLocaleString());
console.log('========================================');

const bot = new TelegramBot(TOKEN, { polling: false });
const logger = new Logger('[bot]', 'info');

const limiter = new RateLimiter({
  '/signal': 5, '/xauusd': 5, '/bias': 5, '/zones': 5,
  '/sweep': 5, '/ot': 5, '/m15': 10, '/m5': 10,
}, 60);

const shutdown = new GracefulShutdown();
shutdown.init();

const fmt = (n, d = 2) => (n === null || n === undefined || !Number.isFinite(n)) ? '—' : Number(n).toFixed(d);

// ======================================================
//  CACHE HELPER (aman kalau multiple call)
// ======================================================
const cache = {
  _s: {},
  get(k) { const e = this._s[k]; if (!e) return null; if (Date.now() > e.exp) { delete this._s[k]; return null; } return e.v; },
  set(k, v, ttlSec = 60) { this._s[k] = { v, exp: Date.now() + ttlSec * 1000 }; }
};

async function getCandles(tf, count = 200) {
  const k = 'c-' + tf + '-' + count;
  let v = cache.get(k);
  if (v) return v;
  v = await candles.getCandles('xauusd', tf, count);
  if (v && v.length) cache.set(k, v, 60);
  return v || [];
}

// ======================================================
//  /start, /help
// ======================================================
const WELCOME = (n) => `Halo ${n}! 👋

*XAU/USD Analyst* — Pure Teknikal + ICT.

📊 *PERINTAH:*
/signal  — Signal lengkap (teknikal + ICT + momentum)
/bias    — Trend H4/H1/M15/M5
/zones   — OB, FVG, IFVG, Breaker
/sweep   — Liquidity sweep
/ot      — Optimal entry (premium/discount)
/m15     — Detail M15
/m5      — Detail M5
/status  — Uptime

⚠️ _Bukan saran finansial. MM yang baik._`;

bot.onText(/^\/start$/, (m) => {
  bot.sendMessage(m.chat.id, WELCOME(m.from.first_name || 'Trader'), { parse_mode: 'Markdown' });
  logger.info('New user: ' + m.from.first_name + ' (' + m.chat.id + ')');
});

bot.onText(/^\/help$/, (m) => {
  bot.sendMessage(m.chat.id, WELCOME(m.from.first_name || 'Trader'), { parse_mode: 'Markdown' });
});

// ======================================================
//  /status
// ======================================================
const bootTime = Date.now();
bot.onText(/^\/status$/, (m) => {
  const up = Math.floor((Date.now() - bootTime) / 1000);
  const h = Math.floor(up / 3600);
  const min = Math.floor((up % 3600) / 60);
  const s = up % 60;
  bot.sendMessage(m.chat.id,
    '🟢 *STATUS*\n' +
    `⏱ ${h}h ${min}m ${s}s\n` +
    `📡 TwelveData: ${TD_KEY ? '✅' : '❌'}\n` +
    `🎯 XAU/USD only\n` +
    `🧠 Strategy: Trend + Reversal + Momentum`,
    { parse_mode: 'Markdown' }
  );
});

// ======================================================
//  CORE STRATEGY: Trend / Reversal / Momentum
// ======================================================
function classifySetup(ta, ictA, h1Candles) {
  if (!ta.ok) return { mode: 'ERROR', reason: ta.error || 'no data' };
  if (!h1Candles || h1Candles.length < 30) return { mode: 'NO_DATA' };

  const last = h1Candles[h1Candles.length - 1].close;
  const ema9 = ta.indicators.ema9;
  const ema21 = ta.indicators.ema21;
  const ema50 = ta.indicators.ema50;
  const rsi = ta.indicators.rsi;
  const macdH = ta.indicators.macd_hist;
  const trend = ta.indicators.ema_trend;

  // 1. TREND detection
  let trendDir = 'NONE';
  if (trend === 'STRONG_UP') trendDir = 'UP';
  else if (trend === 'STRONG_DOWN') trendDir = 'DOWN';
  else if (trend === 'WEAK_UP') trendDir = 'UP_WEAK';
  else if (trend === 'WEAK_DOWN') trendDir = 'DOWN_WEAK';

  // 2. REVERSAL signals (ICT)
  const recentSweep = (ictA.sweeps || [])[0];          // most recent
  const recentCisd = (ictA.cisds || [])[0];            // most recent
  const pd = ictA.premiumDiscount;
  const inDiscount = pd && pd.zone === 'DISCOUNT';
  const inPremium = pd && pd.zone === 'PREMIUM';

  let reversalSignal = null;
  // Bullish reversal: sweep of lows + CISD bullish in discount
  if (recentSweep && recentSweep.direction === 'BULLISH' && inDiscount) {
    if (rsi !== null && rsi < 45) {
      reversalSignal = { dir: 'BUY', strength: 'STRONG', reason: 'sweep lows + CISD + discount + RSI <45' };
    }
  }
  // Bearish reversal: sweep of highs + CISD bearish in premium
  if (recentSweep && recentSweep.direction === 'BEARISH' && inPremium) {
    if (rsi !== null && rsi > 55) {
      reversalSignal = { dir: 'SELL', strength: 'STRONG', reason: 'sweep highs + CISD + premium + RSI >55' };
    }
  }
  // CISD only (no sweep)
  if (!reversalSignal && recentCisd) {
    if (recentCisd.type === 'BULLISH_CISD' && inDiscount && rsi !== null && rsi < 50) {
      reversalSignal = { dir: 'BUY', strength: 'MEDIUM', reason: 'CISD + discount' };
    } else if (recentCisd.type === 'BEARISH_CISD' && inPremium && rsi !== null && rsi > 50) {
      reversalSignal = { dir: 'SELL', strength: 'MEDIUM', reason: 'CISD + premium' };
    }
  }

  // 3. MOMENTUM confirm
  const macdBull = macdH !== null && macdH > 0;
  const macdBear = macdH !== null && macdH < 0;
  const rsiBull = rsi !== null && rsi > 50 && rsi < 75;
  const rsiBear = rsi !== null && rsi < 50 && rsi > 25;

  // 4. DECISION
  let mode = 'TREND';
  let dir = null;
  let confidence = 50;
  let reasons = [];

  if (reversalSignal && reversalSignal.strength === 'STRONG') {
    // Reversal > trend
    mode = 'REVERSAL';
    dir = reversalSignal.dir;
    confidence = 75;
    reasons.push('🔁 Reversal: ' + reversalSignal.reason);
  } else if (trendDir === 'UP' || trendDir === 'UP_WEAK') {
    mode = 'TREND';
    dir = 'BUY';
    confidence = trendDir === 'UP' ? 70 : 55;
    reasons.push('📈 Trend UP (EMA 9>21' + (ema50 && ema9 > ema50 ? '>50' : '') + ')');
    if (macdBull) { confidence += 10; reasons.push('✅ MACD bullish'); }
    if (rsiBull) { confidence += 5; reasons.push('✅ RSI momentum OK'); }
    if (inDiscount) { confidence += 5; reasons.push('✅ Buy at discount'); }
  } else if (trendDir === 'DOWN' || trendDir === 'DOWN_WEAK') {
    mode = 'TREND';
    dir = 'SELL';
    confidence = trendDir === 'DOWN' ? 70 : 55;
    reasons.push('📉 Trend DOWN (EMA 9<21' + (ema50 && ema9 < ema50 ? '<50' : '') + ')');
    if (macdBear) { confidence += 10; reasons.push('✅ MACD bearish'); }
    if (rsiBear) { confidence += 5; reasons.push('✅ RSI momentum OK'); }
    if (inPremium) { confidence += 5; reasons.push('✅ Sell at premium'); }
  } else if (reversalSignal) {
    mode = 'REVERSAL';
    dir = reversalSignal.dir;
    confidence = 60;
    reasons.push('🔁 Reversal (medium): ' + reversalSignal.reason);
  } else {
    mode = 'NO_SETUP';
    confidence = 30;
    reasons.push('⏸ Tidak ada momentum jelas');
  }

  // Cap confidence 95
  confidence = Math.min(95, Math.max(20, confidence));

  return { mode, dir, confidence, reasons, trendDir, inDiscount, inPremium, last };
}

// ======================================================
//  /signal — Full signal
// ======================================================
bot.onText(/^\/(signal|xauusd)$/, async (m) => {
  const cid = m.chat.id;
  if (!limiter.allow('/signal', cid)) return bot.sendMessage(cid, '⏳ Tunggu...');

  const loading = await bot.sendMessage(cid, '⏳ Generate signal XAU/USD...');
  try {
    const [ta, h1] = await Promise.all([
      xauusdTA.analyze(true).catch(e => ({ ok: false, error: e.message })),
      getCandles('1h', 200)
    ]);

    if (!ta.ok) {
      return bot.editMessageText('❌ Error: ' + ta.error, { chat_id: cid, message_id: loading.message_id });
    }
    if (!h1 || h1.length < 50) {
      return bot.editMessageText('❌ Data H1 kurang', { chat_id: cid, message_id: loading.message_id });
    }

    const ictA = ict.analyze(h1, { lookback: 80 });
    const setup = classifySetup(ta, ictA, h1);

    if (setup.mode === 'NO_SETUP' || setup.mode === 'NO_DATA' || setup.mode === 'ERROR') {
      return bot.editMessageText(
        `⚪ *XAU/USD — NO SETUP*\n` +
        `💰 $${fmt(ta.price)}\n` +
        `📊 Trend: ${setup.trendDir || 'NONE'}\n` +
        `📍 Zone: ${setup.inDiscount ? 'DISCOUNT' : setup.inPremium ? 'PREMIUM' : 'EQ'}\n` +
        `\n⏸ Belum ada momentum. Tunggu konfirmasi.`,
        { chat_id: cid, message_id: loading.message_id, parse_mode: 'Markdown' }
      );
    }

    const isBuy = setup.dir === 'BUY';
    const emoji = isBuy ? '🟢' : '🔴';
    const dirText = isBuy ? 'BUY' : 'SELL';
    const last = setup.last;

    // Hitung TP/SL dengan ATR
    const atr = ta.atr;
    const entry = ta.price;
    const tp = isBuy ? entry + atr * 1.5 : entry - atr * 1.5;
    const sl = isBuy ? entry - atr * 1.0 : entry + atr * 1.0;
    const risk = Math.abs(entry - sl);
    const reward = Math.abs(tp - entry);
    const rr = reward / Math.max(0.01, risk);

    // Cari ICT zone konfirmasi
    let ictConf = '';
    if (isBuy) {
      const ob = (ictA.orderBlocks || []).find(o => o.type === 'BULLISH_OB' && o.midpoint < entry);
      const fvg = (ictA.fvgs || []).find(f => f.type === 'BULLISH_FVG' && f.midpoint < entry);
      if (ob) ictConf += `\n🎯 OB: $${fmt(ob.low)} — $${fmt(ob.high)}`;
      if (fvg) ictConf += `\n🎯 FVG: $${fmt(fvg.low)} — $${fmt(fvg.high)}`;
    } else {
      const ob = (ictA.orderBlocks || []).find(o => o.type === 'BEARISH_OB' && o.midpoint > entry);
      const fvg = (ictA.fvgs || []).find(f => f.type === 'BEARISH_FVG' && f.midpoint > entry);
      if (ob) ictConf += `\n🎯 OB: $${fmt(ob.low)} — $${fmt(ob.high)}`;
      if (fvg) ictConf += `\n🎯 FVG: $${fmt(fvg.low)} — $${fmt(fvg.high)}`;
    }

    const lines = [];
    lines.push(`${emoji} *XAU/USD — ${dirText}* (${setup.mode})`);
    lines.push(`💰 Price: *$${fmt(entry)}*`);
    lines.push(`🎯 Confidence: *${setup.confidence}%*`);
    lines.push(`📊 RSI: ${fmt(ta.indicators.rsi, 1)} | MACD-h: ${fmt(ta.indicators.macd_hist, 3)}`);
    lines.push(`📈 Trend: ${setup.trendDir} | Zone: ${setup.inDiscount ? 'DISCOUNT' : setup.inPremium ? 'PREMIUM' : 'EQ'}`);
    lines.push('');
    lines.push('━━━ PLAN ━━━');
    lines.push(`📍 Entry: *$${fmt(entry)}*`);
    lines.push(`🎯 TP: *$${fmt(tp)}*`);
    lines.push(`🛑 SL: *$${fmt(sl)}*`);
    lines.push(`📏 R:R = 1:${fmt(rr, 2)} | ATR: $${fmt(atr)}`);
    if (ictConf) {
      lines.push('');
      lines.push('━━━ ICT ZONE ━━━');
      lines.push(ictConf.trim());
    }
    lines.push('');
    lines.push('━━━ ALASAN ━━━');
    setup.reasons.forEach(r => lines.push('• ' + r));
    lines.push('');
    lines.push('⚠️ _Bukan saran finansial. MM yang baik._');

    bot.editMessageText(lines.join('\n'), {
      chat_id: cid, message_id: loading.message_id, parse_mode: 'Markdown'
    });
  } catch (e) {
    logger.error('/signal error: ' + e.message);
    bot.editMessageText('❌ ' + e.message, { chat_id: cid, message_id: loading.message_id });
  }
});

// ======================================================
//  /bias — Trend MTF (4 timeframe)
// ======================================================
bot.onText(/^\/(bias|xauusd-bias)$/, async (m) => {
  const cid = m.chat.id;
  if (!limiter.allow('/bias', cid)) return bot.sendMessage(cid, '⏳ Tunggu...');

  const loading = await bot.sendMessage(cid, '⏳ Cek bias...');
  try {
    const tfs = ['4h', '1h', '15m', '5m'];
    const data = {};
    for (const tf of tfs) data[tf] = await getCandles(tf, 100);

    const labels = { '4h': 'H4', '1h': 'H1', '15m': 'M15', '5m': 'M5' };
    const lines = ['🎯 *BIAS XAU/USD*', ''];
    let bull = 0, total = 0;

    for (const tf of tfs) {
      const d = data[tf];
      if (!d || d.length < 30) {
        lines.push(`${labels[tf]}: ❌ no data`);
        continue;
      }
      const closes = d.map(c => c.close);
      const sma7 = closes.slice(-7).reduce((a, b) => a + b, 0) / 7;
      const sma21 = closes.slice(-21).reduce((a, b) => a + b, 0) / 21;
      const last = closes[closes.length - 1];
      let dir = 'SIDE', em = '⚪';
      if (sma7 > sma21 && last > sma7) { dir = 'BULL'; em = '🟢'; bull++; total++; }
      else if (sma7 < sma21 && last < sma7) { dir = 'BEAR'; em = '🔴'; total++; }
      else if (sma7 > sma21) { dir = 'PB↑'; em = '🟡'; total++; bull += 0.5; }
      else if (sma7 < sma21) { dir = 'PB↓'; em = '🟠'; total++; }
      const strength = Math.abs(((sma7 - sma21) / sma21) * 100);
      lines.push(`${em} *${labels[tf]}:* ${dir} (Δ ${fmt(strength, 3)}%)`);
    }

    lines.push('');
    if (total > 0 && bull / total >= 0.7) lines.push('📈 *CONFLUENCE: BULLISH*');
    else if (total > 0 && bull / total <= 0.3) lines.push('📉 *CONFLUENCE: BEARISH*');
    else lines.push('⚖️ *CONFLUENCE: MIXED*');

    bot.editMessageText(lines.join('\n'), {
      chat_id: cid, message_id: loading.message_id, parse_mode: 'Markdown'
    });
  } catch (e) {
    bot.editMessageText('❌ ' + e.message, { chat_id: cid, message_id: loading.message_id });
  }
});

// ======================================================
//  /zones — High-probability zones
// ======================================================
bot.onText(/^\/(zones|ict)$/, async (m) => {
  const cid = m.chat.id;
  if (!limiter.allow('/zones', cid)) return bot.sendMessage(cid, '⏳ Tunggu...');

  const loading = await bot.sendMessage(cid, '⏳ Scan zones...');
  try {
    const h1 = await getCandles('1h', 200);
    if (!h1 || h1.length < 50) {
      return bot.editMessageText('❌ Data H1 kurang', { chat_id: cid, message_id: loading.message_id });
    }
    const last = h1[h1.length - 1].close;
    const a = ict.analyze(h1, { lookback: 80 });
    const lines = ['🎯 *ZONES XAU/USD*', `💰 Last: *$${fmt(last)}*`, ''];

    if (a.premiumDiscount) {
      const pd = a.premiumDiscount;
      lines.push('━━━ PREMIUM/DISCOUNT ━━━');
      lines.push(`Zone: *${pd.zone}* (${pd.distanceFromEQ >= 0 ? '+' : ''}${fmt(pd.distanceFromEQ, 3)}% dari EQ)`);
      lines.push(`🟢 OTE Buy: $${fmt(pd.oTE_buy)}`);
      lines.push(`🔴 OTE Sell: $${fmt(pd.oTE_sell)}`);
      lines.push('');
    }

    const ob = (a.orderBlocks || []).filter(o => Math.abs((o.midpoint - last) / last) * 100 < 2).slice(0, 3);
    if (ob.length) {
      lines.push('━━━ ORDER BLOCKS ━━━');
      for (const o of ob) {
        const em = o.type === 'BULLISH_OB' ? '🟢' : '🔴';
        lines.push(`${em} $${fmt(o.low)} — $${fmt(o.high)} (mid $${fmt(o.midpoint)})`);
      }
      lines.push('');
    }

    const fv = (a.fvgs || []).filter(f => Math.abs((f.midpoint - last) / last) * 100 < 2).slice(0, 3);
    if (fv.length) {
      lines.push('━━━ FVG ━━━');
      for (const f of fv) {
        const em = f.type === 'BULLISH_FVG' ? '🟢' : '🔴';
        lines.push(`${em} $${fmt(f.low)} — $${fmt(f.high)}`);
      }
      lines.push('');
    }

    const ifv = (a.ifvgs || []).slice(0, 2);
    if (ifv.length) {
      lines.push('━━━ IFVG (Strong S/R) ━━━');
      for (const f of ifv) {
        const em = f.type === 'BULLISH_IFVG' ? '🟢' : '🔴';
        lines.push(`${em} $${fmt(f.low)} — $${fmt(f.high)}`);
      }
      lines.push('');
    }

    const bb = (a.breakerBlocks || []).slice(0, 2);
    if (bb.length) {
      lines.push('━━━ BREAKER ━━━');
      for (const b of bb) {
        const em = b.type === 'BULLISH_BREAKER' ? '🟢' : '🔴';
        lines.push(`${em} $${fmt(b.low)} — $${fmt(b.high)}`);
      }
      lines.push('');
    }

    if (lines.length <= 3) lines.push('ℹ️ Tidak ada zone dekat harga.');

    bot.editMessageText(lines.join('\n'), {
      chat_id: cid, message_id: loading.message_id, parse_mode: 'Markdown'
    });
  } catch (e) {
    bot.editMessageText('❌ ' + e.message, { chat_id: cid, message_id: loading.message_id });
  }
});

// ======================================================
//  /sweep — Liquidity sweep
// ======================================================
bot.onText(/^\/sweep$/, async (m) => {
  const cid = m.chat.id;
  if (!limiter.allow('/sweep', cid)) return bot.sendMessage(cid, '⏳ Tunggu...');

  const loading = await bot.sendMessage(cid, '⏳ Scan sweep...');
  try {
    const lines = ['💧 *LIQUIDITY SWEEP*', ''];
    for (const tf of ['4h', '1h', '15m']) {
      const d = await getCandles(tf, 200);
      if (!d || d.length < 30) continue;
      const a = ict.analyze(d, { lookback: 50 });
      if (!a.sweeps || a.sweeps.length === 0) continue;
      const labels = { '4h': 'H4', '1h': 'H1', '15m': 'M15' };
      lines.push(`━━━ ${labels[tf]} ━━━`);
      for (const s of a.sweeps.slice(0, 2)) {
        const em = s.direction === 'BULLISH' ? '🟢' : '🔴';
        const rj = s.rejected ? ' ✓ rejected' : '';
        lines.push(`${em} ${s.type} @ $${fmt(s.level)}${rj}`);
      }
      lines.push('');
    }
    if (lines.length <= 2) lines.push('ℹ️ Tidak ada sweep.');
    bot.editMessageText(lines.join('\n'), {
      chat_id: cid, message_id: loading.message_id, parse_mode: 'Markdown'
    });
  } catch (e) {
    bot.editMessageText('❌ ' + e.message, { chat_id: cid, message_id: loading.message_id });
  }
});

// ======================================================
//  /ot — Optimal trade entry
// ======================================================
bot.onText(/^\/ot$/, async (m) => {
  const cid = m.chat.id;
  if (!limiter.allow('/ot', cid)) return bot.sendMessage(cid, '⏳ Tunggu...');

  const loading = await bot.sendMessage(cid, '⏳ Hitung OTE...');
  try {
    const h1 = await getCandles('1h', 200);
    if (!h1 || h1.length < 50) {
      return bot.editMessageText('❌ Data H1 kurang', { chat_id: cid, message_id: loading.message_id });
    }
    const a = ict.analyze(h1, { lookback: 50 });
    if (!a.premiumDiscount) {
      return bot.editMessageText('❌ Tidak bisa hitung zone', { chat_id: cid, message_id: loading.message_id });
    }
    const pd = a.premiumDiscount;
    const lines = [
      '🎯 *OPTIMAL TRADE ENTRY*',
      `💰 Last: $${fmt(pd.currentPrice)}`,
      '',
      `High: $${fmt(pd.swingHigh)} | Low: $${fmt(pd.swingLow)}`,
      `EQ (50%): $${fmt(pd.equilibrium)}`,
      `Zone: *${pd.zone}* (${pd.distanceFromEQ >= 0 ? '+' : ''}${fmt(pd.distanceFromEQ, 3)}%)`,
      '',
      `🟢 OTE Buy (62%): $${fmt(pd.oTE_buy)}`,
      `🔴 OTE Sell (79%): $${fmt(pd.oTE_sell)}`,
      ''
    ];
    if (pd.zone === 'DISCOUNT') {
      lines.push('📈 *Setup: BUY*', `Entry: $${fmt(pd.oTE_buy)} — $${fmt(pd.equilibrium)}`, `SL: < $${fmt(pd.swingLow)}`);
    } else {
      lines.push('📉 *Setup: SELL*', `Entry: $${fmt(pd.equilibrium)} — $${fmt(pd.oTE_sell)}`, `SL: > $${fmt(pd.swingHigh)}`);
    }
    bot.editMessageText(lines.join('\n'), {
      chat_id: cid, message_id: loading.message_id, parse_mode: 'Markdown'
    });
  } catch (e) {
    bot.editMessageText('❌ ' + e.message, { chat_id: cid, message_id: loading.message_id });
  }
});

// ======================================================
//  /m15, /m5 — Detail TF
// ======================================================
async function detailTF(m, tf) {
  const cid = m.chat.id;
  const labels = { '15m': 'M15', '5m': 'M5' };
  if (!limiter.allow('/' + tf, cid)) return bot.sendMessage(cid, '⏳ Tunggu...');
  const loading = await bot.sendMessage(cid, `⏳ ${labels[tf]}...`);
  try {
    const d = await getCandles(tf, 200);
    if (!d || d.length < 30) return bot.editMessageText('❌ Data kurang', { chat_id: cid, message_id: loading.message_id });
    const closes = d.map(c => c.close);
    const sma7 = closes.slice(-7).reduce((a, b) => a + b, 0) / 7;
    const sma21 = closes.slice(-21).reduce((a, b) => a + b, 0) / 21;
    const last = closes[closes.length - 1];
    const high = Math.max(...d.slice(-7).map(c => c.high));
    const low = Math.min(...d.slice(-7).map(c => c.low));
    let trend = 'SIDE', em = '⚪';
    if (sma7 > sma21 && last > sma7) { trend = 'BULL'; em = '🟢'; }
    else if (sma7 < sma21 && last < sma7) { trend = 'BEAR'; em = '🔴'; }
    else if (sma7 > sma21) { trend = 'PB↑'; em = '🟡'; }
    else if (sma7 < sma21) { trend = 'PB↓'; em = '🟠'; }
    const a = ict.analyze(d, { lookback: 50 });
    const lines = [
      `${em} *XAU/USD — ${labels[tf]}*`,
      `💰 $${fmt(last)} | Trend: *${trend}*`,
      `SMA7: $${fmt(sma7)} | SMA21: $${fmt(sma21)}`,
      `7-bar: H $${fmt(high)} L $${fmt(low)}`
    ];
    if (a.premiumDiscount) {
      lines.push(`Zone: *${a.premiumDiscount.zone}* | OTE Buy $${fmt(a.premiumDiscount.oTE_buy)} Sell $${fmt(a.premiumDiscount.oTE_sell)}`);
    }
    if (a.sweeps && a.sweeps.length) {
      lines.push('', 'Sweeps:');
      a.sweeps.slice(0, 2).forEach(s => {
        const em2 = s.direction === 'BULLISH' ? '🟢' : '🔴';
        lines.push(`${em2} ${s.type} @ $${fmt(s.level)}`);
      });
    }
    bot.editMessageText(lines.join('\n'), {
      chat_id: cid, message_id: loading.message_id, parse_mode: 'Markdown'
    });
  } catch (e) {
    bot.editMessageText('❌ ' + e.message, { chat_id: cid, message_id: loading.message_id });
  }
}
bot.onText(/^\/m15$/, (m) => detailTF(m, '15m'));
bot.onText(/^\/m5$/, (m) => detailTF(m, '5m'));

// ======================================================
//  Auto-reply
// ======================================================
bot.on('message', (m) => {
  if (m.text && m.text.startsWith('/')) return;
  const t = (m.text || '').toLowerCase();
  const n = m.from.first_name || 'Trader';
  let r = '';
  if (/halo|hai|hello|hi/.test(t)) r = `Halo ${n}! 👋 /signal untuk analisa XAU/USD.`;
  else if (/signal|analisa|gold|emas|xau/.test(t)) r = `Coba /signal ya ${n} 📊`;
  else if (/help|bantu/.test(t)) r = 'Ketik /help untuk list command.';
  else if (t.length > 0) r = `Hai ${n}! Ketik /signal atau /help.`;
  if (r) bot.sendMessage(m.chat.id, r);
});

// ======================================================
//  Start polling (delay 25s avoid 409)
// ======================================================
console.log('⏳ Waiting 25s sebelum polling...');
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
