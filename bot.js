// ======================================================
//  🤖 XAU/USD PRO ANALYST — Trader-Grade Signal Engine
// ======================================================
//  Logic: Multi-confluence scoring (minimal 3 dari 7 indikator)
//         + ICT smart money + session filter + news filter
//         + risk management + SL 50 pips dari zone
//
//  7 Konfirmasi Signal:
//    1. TREND       (EMA 9/21/50 + structure HH/HL atau LH/LL)
//    2. MOMENTUM    (RSI + MACD histogram)
//    3. ICT ZONE    (OB / FVG / OTE premium-discount)
//    4. SWEEP       (liquidity grab di swing high/low)
//    5. STRUCTURE   (BOS / CHoCH / MSS)
//    6. SESSION     (London / NY = high volatility, Asia = ranging)
//    7. RISK/REWARD (min 1:2, ideal 1:3)
//
//  Scoring:
//    - 7/7 = 95% confidence (SNIPER)
//    - 6/7 = 85%
//    - 5/7 = 75%
//    - 4/7 = 60%
//    - 3/7 = 45% (minimal)
//    - <3 = NO SETUP
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
console.log('🏆 XAU/USD PRO ANALYST (Trader-Grade)');
console.log('📡 TwelveData: ' + (TD_KEY ? 'ON' : 'OFF'));
console.log('⏰ ' + new Date().toLocaleString());
console.log('========================================');

const bot = new TelegramBot(TOKEN, { polling: false });
const logger = new Logger('[pro]', 'info');

const limiter = new RateLimiter({
  '/signal': 5, '/xauusd': 5, '/bias': 5, '/zones': 5,
  '/sweep': 5, '/ot': 5, '/m15': 10, '/m5': 10, '/m3': 10, '/m2': 10, '/m1': 10,
  '/scalp': 3, '/intra': 3, '/swing': 3, '/mode': 5,
  '/analyze': 5, '/grade': 5,
}, 60);

const shutdown = new GracefulShutdown();
shutdown.init();

const fmt = (n, d = 2) => (n === null || n === undefined || !Number.isFinite(n)) ? '—' : Number(n).toFixed(d);

const cache = {
  _s: {},
  get(k) { const e = this._s[k]; if (!e) return null; if (Date.now() > e.exp) { delete this._s[k]; return null; } return e.v; },
  set(k, v, ttl = 60) { this._s[k] = { v, exp: Date.now() + ttl * 1000 }; }
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
//  MODES
// ======================================================
const MODES = {
  scalping: {
    label: 'SCALPING',
    emoji: '⚡',
    tfs: { bias: '1h', entry: '5m', confirm: '15m' },
    slPipsFromZone: 50, tpMultiplier: 3,
    holdBars: 6, timeInTrade: '5-30 menit',
    bestFor: 'Quick profit di zone, R:R 1:3'
  },
  intraday: {
    label: 'INTRADAY',
    emoji: '📊',
    tfs: { bias: '4h', entry: '15m', confirm: '1h' },
    slPipsFromZone: 50, tpMultiplier: 3,
    holdBars: 16, timeInTrade: '1-4 jam',
    bestFor: 'Hold di zone premium/discount, R:R 1:3'
  },
  swing: {
    label: 'SWING',
    emoji: '📈',
    tfs: { bias: '1day', entry: '1h', confirm: '4h' },
    slPipsFromZone: 50, tpMultiplier: 3,
    holdBars: 24, timeInTrade: '1-3 hari',
    bestFor: 'Hold dari zone besar, target 1:3'
  }
};
let currentMode = 'intraday';

function getMode(name) {
  if (!name) return MODES[currentMode];
  return MODES[name.toLowerCase()] || MODES[currentMode];
}

// ======================================================
//  SESSION DETECTION
//  Asia: 00:00-08:00 UTC (low vol, ranging)
//  London: 08:00-16:00 UTC (trending, high vol)
//  NY: 13:00-22:00 UTC (volatile, news-driven)
//  London+NY overlap: 13:00-16:00 UTC (best time, highest vol)
// ======================================================
function getSession() {
  const h = new Date().getUTCHours();
  if (h >= 13 && h < 16) return { name: 'LONDON+NY OVERLAP', emoji: '🔥', quality: 'BEST' };
  if (h >= 8 && h < 13) return { name: 'LONDON', emoji: '🇬🇧', quality: 'HIGH' };
  if (h >= 16 && h < 22) return { name: 'NEW YORK', emoji: '🇺🇸', quality: 'HIGH' };
  if (h >= 22 || h < 0) return { name: 'ASIA', emoji: '🌏', quality: 'LOW' };
  return { name: 'QUIET', emoji: '⏸', quality: 'LOW' };
}

// ======================================================
//  ICT ZONE FINDER
// ======================================================
function findEntryZone(ictA, isBuy, currentPrice) {
  if (isBuy) {
    const ob = (ictA.orderBlocks || []).find(o => o.type === 'BULLISH_OB' && o.high < currentPrice);
    if (ob) return { type: 'BULLISH_OB', price: ob.midpoint, low: ob.low, high: ob.high, strength: ob.strength || 1 };
    const fvg = (ictA.fvgs || []).find(f => f.type === 'BULLISH_FVG' && f.high < currentPrice);
    if (fvg) return { type: 'BULLISH_FVG', price: fvg.midpoint, low: fvg.low, high: fvg.high };
    if (ictA.premiumDiscount && ictA.premiumDiscount.zone === 'DISCOUNT') {
      return { type: 'DISCOUNT_OTE', price: ictA.premiumDiscount.oTE_buy, low: ictA.premiumDiscount.swingLow, high: ictA.premiumDiscount.oTE_buy };
    }
  } else {
    const ob = (ictA.orderBlocks || []).find(o => o.type === 'BEARISH_OB' && o.low > currentPrice);
    if (ob) return { type: 'BEARISH_OB', price: ob.midpoint, low: ob.low, high: ob.high, strength: ob.strength || 1 };
    const fvg = (ictA.fvgs || []).find(f => f.type === 'BEARISH_FVG' && f.low > currentPrice);
    if (fvg) return { type: 'BEARISH_FVG', price: fvg.midpoint, low: fvg.low, high: fvg.high };
    if (ictA.premiumDiscount && ictA.premiumDiscount.zone === 'PREMIUM') {
      return { type: 'PREMIUM_OTE', price: ictA.premiumDiscount.oTE_sell, low: ictA.premiumDiscount.oTE_sell, high: ictA.premiumDiscount.swingHigh };
    }
  }
  return null;
}

function calcSLTPFromZone(zone, isBuy, mode) {
  const slDistUSD = mode.slPipsFromZone * 0.01;
  const entry = zone.price;
  let sl;
  if (isBuy) {
    sl = Math.min(zone.low - slDistUSD, entry - slDistUSD);
  } else {
    sl = Math.max(zone.high + slDistUSD, entry + slDistUSD);
  }
  const slDist = Math.abs(entry - sl);
  const tpDist = slDist * mode.tpMultiplier;
  const tp = isBuy ? entry + tpDist : entry - tpDist;
  return { entry, sl, tp, slDist, tpDist };
}

// ======================================================
//  CORE PRO ANALYSIS — 7-CONFLUENCE SCORING
// ======================================================
async function proAnalyze(modeName) {
  const mode = getMode(modeName);
  const session = getSession();

  // Fetch data parallel
  const [ta, entryTF, biasTF, confirmTF] = await Promise.all([
    xauusdTA.analyze(true),
    getCandles(mode.tfs.entry, 200),
    getCandles(mode.tfs.bias, 200),
    getCandles(mode.tfs.confirm, 200)
  ]);

  if (!ta.ok) return { error: ta.error || 'no ta' };
  if (!entryTF || entryTF.length < 50) return { error: 'Data ' + mode.tfs.entry + ' tidak cukup' };

  const ictA = ict.analyze(entryTF, { lookback: 80 });
  const ictBias = ict.analyze(biasTF, { lookback: 50 });
  const ictConfirm = ict.analyze(confirmTF, { lookback: 50 });

  const price = ta.price;
  const closes = entryTF.map(c => c.close);
  const lastCandle = entryTF[entryTF.length - 1];

  // ============ 7 CONFLUENCES ============

  // 1. TREND (H1/H4 bias)
  const trendDir = ta.indicators.ema_trend;
  const trendStrong = trendDir === 'STRONG_UP' || trendDir === 'STRONG_DOWN';
  const trendBull = trendDir === 'STRONG_UP' || trendDir === 'WEAK_UP';
  const trendBear = trendDir === 'STRONG_DOWN' || trendDir === 'WEAK_DOWN';
  const conf1 = trendStrong ? 'STRONG' : (trendBull || trendBear ? 'WEAK' : 'NONE');

  // 2. MOMENTUM (RSI + MACD)
  const rsi = ta.indicators.rsi;
  const macdH = ta.indicators.macd_hist;
  const rsiBull = rsi > 50 && rsi < 75;
  const rsiBear = rsi < 50 && rsi > 25;
  const rsiExtreme = (rsi < 30 || rsi > 70);
  const macdBull = macdH > 0;
  const macdBear = macdH < 0;
  const conf2 = (rsiBull && macdBull) || (rsiBear && macdBear) ? 'STRONG' :
                 (rsiBull || macdBull || rsiBear || macdBear) ? 'WEAK' : 'NONE';

  // 3. ICT ZONE
  const inDiscount = ictA.premiumDiscount && ictA.premiumDiscount.zone === 'DISCOUNT';
  const inPremium = ictA.premiumDiscount && ictA.premiumDiscount.zone === 'PREMIUM';
  const buyOB = (ictA.orderBlocks || []).find(o => o.type === 'BULLISH_OB' && o.high < price);
  const sellOB = (ictA.orderBlocks || []).find(o => o.type === 'BEARISH_OB' && o.low > price);
  const hasBuyZone = !!(buyOB || inDiscount);
  const hasSellZone = !!(sellOB || inPremium);
  const conf3 = (buyOB || sellOB) ? 'STRONG' : (hasBuyZone || hasSellZone) ? 'WEAK' : 'NONE';

  // 4. SWEEP (liquidity grab)
  const recentSweep = (ictA.sweeps || [])[0];
  const hasBullSweep = recentSweep && recentSweep.direction === 'BULLISH' && recentSweep.rejected;
  const hasBearSweep = recentSweep && recentSweep.direction === 'BEARISH' && recentSweep.rejected;
  const conf4 = (hasBullSweep || hasBearSweep) ? 'STRONG' : 'NONE';

  // 5. STRUCTURE (BOS / MSS)
  const struct = ictA.structure || ictConfirm.structure;
  const bos = struct && struct.bos;
  const mss = struct && struct.mss;
  const bosBull = bos && bos.type === 'BULLISH_BOS';
  const bosBear = bos && bos.type === 'BEARISH_BOS';
  const mssBull = mss && mss.type === 'BULLISH_MSS';
  const mssBear = mss && mss.type === 'BEARISH_MSS';
  const conf5 = (bos || mss) ? 'STRONG' : 'NONE';

  // 6. SESSION quality
  const conf6 = (session.quality === 'BEST') ? 'STRONG' :
                 (session.quality === 'HIGH') ? 'WEAK' : 'NONE';

  // 7. RISK/REWARD (auto satisfied kalau pakai mode, always >= 1:2)
  const conf7 = 'STRONG';  // mode config guarantee 1:3

  // ============ DECISION ============
  const confluences = [
    { name: 'TREND', score: conf1 },
    { name: 'MOMENTUM', score: conf2 },
    { name: 'ICT ZONE', score: conf3 },
    { name: 'SWEEP', score: conf4 },
    { name: 'STRUCTURE', score: conf5 },
    { name: 'SESSION', score: conf6 },
    { name: 'RISK/REWARD', score: conf7 }
  ];

  const strongCount = confluences.filter(c => c.score === 'STRONG').length;
  const weakCount = confluences.filter(c => c.score === 'WEAK').length;
  const totalScore = strongCount + (weakCount * 0.5);

  // Tentukan direction
  let dir = null;
  let dirScore = { BUY: 0, SELL: 0 };

  // TREND vote
  if (trendBull) dirScore.BUY += trendStrong ? 2 : 1;
  if (trendBear) dirScore.SELL += trendStrong ? 2 : 1;

  // MOMENTUM vote
  if (rsiBull && macdBull) dirScore.BUY += 2;
  else if (rsiBull || macdBull) dirScore.BUY += 1;
  if (rsiBear && macdBear) dirScore.SELL += 2;
  else if (rsiBear || macdBear) dirScore.SELL += 1;

  // ZONE vote
  if (hasBuyZone) dirScore.BUY += 1.5;
  if (hasSellZone) dirScore.SELL += 1.5;

  // SWEEP vote (strong reversal signal)
  if (hasBullSweep) dirScore.BUY += 2;
  if (hasBearSweep) dirScore.SELL += 2;

  // STRUCTURE vote
  if (bosBull || mssBull) dirScore.BUY += 1.5;
  if (bosBear || mssBear) dirScore.SELL += 1.5;

  if (dirScore.BUY > dirScore.SELL) dir = 'BUY';
  else if (dirScore.SELL > dirScore.BUY) dir = 'SELL';

  // RSI extreme override (counter-trend reversal)
  if (rsiExtreme) {
    if (rsi < 30 && inDiscount) dir = 'BUY';
    if (rsi > 70 && inPremium) dir = 'SELL';
  }

  // Min threshold
  const MIN_CONFLUENCE = 3;
  const passed = strongCount >= MIN_CONFLUENCE || totalScore >= 3.5;

  // Confidence
  let confidence;
  if (strongCount >= 6) confidence = 95;
  else if (strongCount === 5) confidence = 85;
  else if (strongCount === 4) confidence = 75;
  else if (totalScore >= 3.5) confidence = 60;
  else if (totalScore >= 3) confidence = 45;
  else confidence = 0;

  // Grade
  let grade = 'NO SETUP';
  if (strongCount >= 6) grade = '🏆 SNIPER (A++)';
  else if (strongCount === 5) grade = '💎 EXCELLENT (A+)';
  else if (strongCount === 4) grade = '✅ GOOD (A)';
  else if (totalScore >= 3.5) grade = '🟡 FAIR (B)';
  else if (totalScore >= 3) grade = '🟠 WEAK (C)';

  // Zone & SL/TP
  const isBuy = dir === 'BUY';
  const zone = dir ? findEntryZone(ictA, isBuy, price) : null;
  let sltp = null;
  if (zone) sltp = calcSLTPFromZone(zone, isBuy, mode);

  return {
    ok: passed && dir && zone,
    grade,
    confidence,
    dir,
    confluences,
    strongCount,
    weakCount,
    totalScore,
    zone,
    sltp,
    ta,
    ictA,
    session,
    price,
    rsi,
    macdH,
    trendDir,
    inDiscount,
    inPremium,
    mode
  };
}

// ======================================================
//  WELCOME & BASIC COMMANDS
// ======================================================
const WELCOME = (n) => `Halo ${n}! 👋

*🏆 XAU/USD PRO ANALYST*

Bot ini menganalisa XAU/USD dengan logika trader profesional:
- Minimal 3 konfirmasi dari 7 indikator
- SL 50 pips dari zone (R:R 1:3)
- Limit/Market order sesuai zone

🎯 *MODE:* ${MODES[currentMode].emoji} ${MODES[currentMode].label}

📊 *COMMAND:*
/signal — Full pro analysis
/analyze — Detail 7 confluence + score
/scalp — Mode SCALPING
/intra — Mode INTRADAY
/swing — Mode SWING
/grade — Cek grade kriteria signal
/bias — Multi-TF trend
/zones — ICT zones
/sweep — Liquidity sweep
/ot — Optimal entry
/m1 /m2 /m3 /m5 /m15 — Detail TF
/status — Uptime

⚠️ _Bukan saran finansial. Selalu pakai MM._`;

bot.onText(/^\/start$/, (m) => {
  bot.sendMessage(m.chat.id, WELCOME(m.from.first_name || 'Trader'), { parse_mode: 'Markdown' });
  logger.info('User: ' + m.from.first_name);
});
bot.onText(/^\/help$/, (m) => {
  bot.sendMessage(m.chat.id, WELCOME(m.from.first_name || 'Trader'), { parse_mode: 'Markdown' });
});

const bootTime = Date.now();
bot.onText(/^\/status$/, (m) => {
  const up = Math.floor((Date.now() - bootTime) / 1000);
  const h = Math.floor(up / 3600);
  const min = Math.floor((up % 3600) / 60);
  const s = up % 60;
  const sess = getSession();
  bot.sendMessage(m.chat.id,
    '🟢 *PRO STATUS*\n' +
    `⏱ ${h}h ${min}m ${s}s\n` +
    `📡 TwelveData: ${TD_KEY ? '✅' : '❌'}\n` +
    `🎯 Mode: ${MODES[currentMode].emoji} ${MODES[currentMode].label}\n` +
    `🌐 Session: ${sess.emoji} ${sess.name} (${sess.quality})`,
    { parse_mode: 'Markdown' }
  );
});

// ======================================================
//  MODE SET
// ======================================================
function setMode(m, name) {
  const cid = m.chat.id;
  const mode = MODES[name];
  if (!mode) return;
  currentMode = name;
  const slPips = mode.slPipsFromZone;
  const tpPips = slPips * mode.tpMultiplier;
  bot.sendMessage(cid,
    `${mode.emoji} *MODE: ${mode.label}*\n` +
    `⏱ ${mode.timeInTrade}\n` +
    `🛑 SL: ${slPips} pips dari zone\n` +
    `🎯 TP: ${tpPips} pips (1:${mode.tpMultiplier})\n` +
    `📊 TF: ${mode.tfs.bias} → ${mode.tfs.confirm} → ${mode.tfs.entry}`,
    { parse_mode: 'Markdown' });
}
bot.onText(/^\/(scalp|scalping)$/, (m) => setMode(m, 'scalping'));
bot.onText(/^\/(intra|intraday)$/, (m) => setMode(m, 'intraday'));
bot.onText(/^\/swing$/, (m) => setMode(m, 'swing'));

// ======================================================
//  /signal — Pro signal
// ======================================================
bot.onText(/^\/(signal|xauusd)$/, async (m) => {
  const cid = m.chat.id;
  if (!limiter.checkLimit('/signal')) return bot.sendMessage(cid, '⏳ Tunggu...');

  const mode = getMode();
  const loading = await bot.sendMessage(cid, `⏳ Pro analysis XAU/USD (${mode.label})...`);
  try {
    const r = await proAnalyze();
    if (r.error) return bot.editMessageText('❌ ' + r.error, { chat_id: cid, message_id: loading.message_id });

    if (!r.ok) {
      // Tampilkan hasil meski NO SETUP biar user tau
      const confLines = r.confluences.map(c => {
        const em = c.score === 'STRONG' ? '✅' : c.score === 'WEAK' ? '🟡' : '❌';
        return `${em} ${c.name}: ${c.score}`;
      }).join('\n');
      return bot.editMessageText(
        `⚪ *NO SETUP — ${r.grade}*\n` +
        `💰 Price: $${fmt(r.price)}\n` +
        `🌐 Session: ${r.session.emoji} ${r.session.name}\n` +
        `📊 Strong: ${r.strongCount}/7 | Total: ${r.totalScore.toFixed(1)}\n\n` +
        `━━━ CONFLUENCES ━━━\n${confLines}\n\n` +
        `⏸ Tunggu ${3 - r.strongCount} konfirmasi lagi. Patience is key.`,
        { chat_id: cid, message_id: loading.message_id, parse_mode: 'Markdown' }
      );
    }

    const isBuy = r.dir === 'BUY';
    const emoji = isBuy ? '🟢' : '🔴';
    const dirText = isBuy ? 'BUY' : 'SELL';
    const slDist = r.sltp.slDist;
    const tpDist = r.sltp.tpDist;
    const slPips = Math.round(slDist / 0.01);
    const tpPips = Math.round(tpDist / 0.01);
    const rr = tpDist / Math.max(0.01, slDist);
    const distToEntry = Math.abs(r.price - r.sltp.entry);
    const orderType = distToEntry > 0.5 ? 'LIMIT' : 'MARKET';

    const confLines = r.confluences.map(c => {
      const em = c.score === 'STRONG' ? '✅' : c.score === 'WEAK' ? '🟡' : '❌';
      return `${em} ${c.name}: ${c.score}`;
    }).join('\n');

    const lines = [];
    lines.push(`${emoji} *XAU/USD ${dirText} — ${r.grade}*`);
    lines.push(`💰 Price: $${fmt(r.price)} | ${mode.emoji} ${mode.label}`);
    lines.push(`🎯 Confidence: *${r.confidence}%* | Strong: ${r.strongCount}/7`);
    lines.push(`🌐 Session: ${r.session.emoji} ${r.session.name}`);
    lines.push('');
    lines.push('━━━ CONFLUENCE ━━━');
    lines.push(confLines);
    lines.push('');
    lines.push('━━━ ORDER ━━━');
    lines.push(`📥 *${orderType} ${dirText}:* $${fmt(r.sltp.entry)}`);
    lines.push(`📦 Zone: ${r.zone.type} $${fmt(r.zone.low)}—$${fmt(r.zone.high)}`);
    lines.push('');
    lines.push('━━━ PLAN ━━━');
    lines.push(`🎯 TP: *$${fmt(r.sltp.tp)}* (${tpPips} pips)`);
    lines.push(`🛑 SL: *$${fmt(r.sltp.sl)}* (${slPips} pips dari zone)`);
    lines.push(`📏 R:R = 1:${fmt(rr, 2)}`);
    lines.push('');
    lines.push('━━━ MARKET STATE ━━━');
    lines.push(`📈 Trend: ${r.trendDir}`);
    lines.push(`📊 RSI: ${fmt(r.rsi, 1)} | MACD-h: ${fmt(r.macdH, 3)}`);
    lines.push(`📍 Zone: ${r.inDiscount ? 'DISCOUNT ✅' : r.inPremium ? 'PREMIUM ✅' : 'EQ (kurang ideal)'}`);
    lines.push('');
    lines.push('⚠️ _Pro analysis. Selalu pakai MM. Bukan saran finansial._');

    bot.editMessageText(lines.join('\n'), {
      chat_id: cid, message_id: loading.message_id, parse_mode: 'Markdown'
    });
  } catch (e) {
    logger.error('/signal err: ' + e.message);
    bot.editMessageText('❌ ' + e.message, { chat_id: cid, message_id: loading.message_id });
  }
});

// ======================================================
//  /analyze — Detail 7 confluence breakdown
// ======================================================
bot.onText(/^\/analyze$/, async (m) => {
  const cid = m.chat.id;
  if (!limiter.checkLimit('/analyze')) return bot.sendMessage(cid, '⏳ Tunggu...');

  const loading = await bot.sendMessage(cid, '⏳ Deep analysis XAU/USD...');
  try {
    const r = await proAnalyze();
    if (r.error) return bot.editMessageText('❌ ' + r.error, { chat_id: cid, message_id: loading.message_id });

    const lines = [];
    lines.push('🔬 *DEEP ANALYSIS XAU/USD*');
    lines.push(`💰 $${fmt(r.price)} | ${r.session.emoji} ${r.session.name}`);
    lines.push('');
    lines.push('━━━ 7 CONFLUENCE BREAKDOWN ━━━');

    r.confluences.forEach((c, i) => {
      const em = c.score === 'STRONG' ? '✅' : c.score === 'WEAK' ? '🟡' : '❌';
      const pct = c.score === 'STRONG' ? '+2' : c.score === 'WEAK' ? '+1' : '+0';
      lines.push(`${i+1}. ${em} *${c.name}* (${c.score}) [${pct}]`);
    });

    lines.push('');
    lines.push(`📊 *Total Score: ${r.totalScore.toFixed(1)}/7*`);
    lines.push(`   Strong: ${r.strongCount} | Weak: ${r.weakCount}`);
    lines.push(`🎯 *Grade: ${r.grade}*`);
    lines.push('');
    if (r.dir) {
      lines.push(`📍 *Direction: ${r.dir}*`);
      if (r.zone) {
        lines.push(`📦 *Entry Zone: ${r.zone.type}*`);
        lines.push(`   $${fmt(r.zone.low)} — $${fmt(r.zone.high)} (mid $${fmt(r.zone.price)})`);
      }
    } else {
      lines.push('⏸ *Direction: UNCLEAR* (mixed signals)');
    }

    lines.push('');
    lines.push('━━━ MARKET STATE ━━━');
    lines.push(`📈 Trend (H1): ${r.trendDir}`);
    lines.push(`📊 RSI: ${fmt(r.rsi, 1)} | MACD-h: ${fmt(r.macdH, 3)}`);
    lines.push(`📍 Zone: ${r.inDiscount ? 'DISCOUNT' : r.inPremium ? 'PREMIUM' : 'EQUILIBRIUM'}`);

    bot.editMessageText(lines.join('\n'), {
      chat_id: cid, message_id: loading.message_id, parse_mode: 'Markdown'
    });
  } catch (e) {
    bot.editMessageText('❌ ' + e.message, { chat_id: cid, message_id: loading.message_id });
  }
});

// ======================================================
//  /grade — Cek apa signal saat ini layak entry
// ======================================================
bot.onText(/^\/grade$/, async (m) => {
  const cid = m.chat.id;
  if (!limiter.checkLimit('/grade')) return bot.sendMessage(cid, '⏳ Tunggu...');

  const loading = await bot.sendMessage(cid, '⏳ Grading current setup...');
  try {
    const r = await proAnalyze();
    if (r.error) return bot.editMessageText('❌ ' + r.error, { chat_id: cid, message_id: loading.message_id });

    let recommendation;
    if (r.strongCount >= 5) recommendation = '✅ ENTRY — High probability setup';
    else if (r.strongCount === 4) recommendation = '🟡 ENTRY WITH CAUTION — Solid tapi bisa gagal';
    else if (r.totalScore >= 3.5) recommendation = '⚠️ WAIT — Setup belum konfluen';
    else if (r.totalScore >= 3) recommendation = '🛑 STAND ASIDE — Sinyal lemah';
    else recommendation = '❌ NO TRADE — Tidak ada setup valid';

    const gradeEmoji = r.strongCount >= 5 ? '🟢' : r.strongCount >= 4 ? '🟡' : r.strongCount >= 3 ? '🟠' : '🔴';

    bot.editMessageText(
      `${gradeEmoji} *SIGNAL GRADE*\n\n` +
      `Grade: *${r.grade}*\n` +
      `Score: ${r.totalScore.toFixed(1)}/7 (${r.strongCount} strong)\n` +
      `Direction: ${r.dir || 'UNCLEAR'}\n` +
      `Session: ${r.session.emoji} ${r.session.name}\n\n` +
      `*Rekomendasi:*\n${recommendation}\n\n` +
      `Kirim /signal untuk detail lengkap.`,
      { chat_id: cid, message_id: loading.message_id, parse_mode: 'Markdown' }
    );
  } catch (e) {
    bot.editMessageText('❌ ' + e.message, { chat_id: cid, message_id: loading.message_id });
  }
});

// ======================================================
//  /bias — Multi-TF trend
// ======================================================
bot.onText(/^\/bias$/, async (m) => {
  const cid = m.chat.id;
  if (!limiter.checkLimit('/bias')) return bot.sendMessage(cid, '⏳ Tunggu...');
  const loading = await bot.sendMessage(cid, '⏳ Cek bias...');
  try {
    const tfs = ['4h', '1h', '15m', '5m'];
    const labels = { '4h': 'H4', '1h': 'H1', '15m': 'M15', '5m': 'M5' };
    const lines = ['🎯 *BIAS XAU/USD*', ''];
    let bull = 0, total = 0;

    for (const tf of tfs) {
      const d = await getCandles(tf, 100);
      if (!d || d.length < 30) { lines.push(`${labels[tf]}: ❌`); continue; }
      const closes = d.map(c => c.close);
      const sma7 = closes.slice(-7).reduce((a, b) => a + b, 0) / 7;
      const sma21 = closes.slice(-21).reduce((a, b) => a + b, 0) / 21;
      const last = closes[closes.length - 1];
      let dir = 'SIDE', em = '⚪';
      if (sma7 > sma21 && last > sma7) { dir = 'BULL'; em = '🟢'; bull++; total++; }
      else if (sma7 < sma21 && last < sma7) { dir = 'BEAR'; em = '🔴'; total++; }
      else if (sma7 > sma21) { dir = 'PB↑'; em = '🟡'; total++; bull += 0.5; }
      else if (sma7 < sma21) { dir = 'PB↓'; em = '🟠'; total++; }
      lines.push(`${em} *${labels[tf]}:* ${dir}`);
    }
    lines.push('');
    if (total > 0 && bull / total >= 0.7) lines.push('📈 *CONFLUENCE: BULLISH*');
    else if (total > 0 && bull / total <= 0.3) lines.push('📉 *CONFLUENCE: BEARISH*');
    else lines.push('⚖️ *CONFLUENCE: MIXED*');

    bot.editMessageText(lines.join('\n'), { chat_id: cid, message_id: loading.message_id, parse_mode: 'Markdown' });
  } catch (e) {
    bot.editMessageText('❌ ' + e.message, { chat_id: cid, message_id: loading.message_id });
  }
});

// ======================================================
//  /zones — ICT zones
// ======================================================
bot.onText(/^\/zones$/, async (m) => {
  const cid = m.chat.id;
  if (!limiter.checkLimit('/zones')) return bot.sendMessage(cid, '⏳ Tunggu...');
  const loading = await bot.sendMessage(cid, '⏳ Scan zones...');
  try {
    const tf = getMode().tfs.entry;
    const d = await getCandles(tf, 200);
    if (!d || d.length < 50) return bot.editMessageText('❌ Data kurang', { chat_id: cid, message_id: loading.message_id });
    const last = d[d.length - 1].close;
    const a = ict.analyze(d, { lookback: 80 });
    const lines = [`🎯 *ZONES XAU/USD* (${tf})`, `💰 $${fmt(last)}`, ''];
    if (a.premiumDiscount) {
      const pd = a.premiumDiscount;
      lines.push('━━━ P/D ━━━');
      lines.push(`Zone: *${pd.zone}*`);
      lines.push(`🟢 OTE Buy: $${fmt(pd.oTE_buy)}`);
      lines.push(`🔴 OTE Sell: $${fmt(pd.oTE_sell)}`);
      lines.push('');
    }
    const ob = (a.orderBlocks || []).filter(o => Math.abs((o.midpoint - last) / last) * 100 < 2).slice(0, 3);
    if (ob.length) {
      lines.push('━━━ OB ━━━');
      for (const o of ob) lines.push(`${o.type === 'BULLISH_OB' ? '🟢' : '🔴'} $${fmt(o.low)}—$${fmt(o.high)}`);
      lines.push('');
    }
    const fv = (a.fvgs || []).filter(f => Math.abs((f.midpoint - last) / last) * 100 < 2).slice(0, 3);
    if (fv.length) {
      lines.push('━━━ FVG ━━━');
      for (const f of fv) lines.push(`${f.type === 'BULLISH_FVG' ? '🟢' : '🔴'} $${fmt(f.low)}—$${fmt(f.high)}`);
      lines.push('');
    }
    if (lines.length <= 3) lines.push('ℹ️ Tidak ada zone dekat harga.');
    bot.editMessageText(lines.join('\n'), { chat_id: cid, message_id: loading.message_id, parse_mode: 'Markdown' });
  } catch (e) {
    bot.editMessageText('❌ ' + e.message, { chat_id: cid, message_id: loading.message_id });
  }
});

// ======================================================
//  /sweep — Liquidity sweep
// ======================================================
bot.onText(/^\/sweep$/, async (m) => {
  const cid = m.chat.id;
  if (!limiter.checkLimit('/sweep')) return bot.sendMessage(cid, '⏳ Tunggu...');
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
        const rj = s.rejected ? ' ✓rejected' : '';
        lines.push(`${em} ${s.type} @ $${fmt(s.level)}${rj}`);
      }
      lines.push('');
    }
    if (lines.length <= 2) lines.push('ℹ️ Tidak ada sweep.');
    bot.editMessageText(lines.join('\n'), { chat_id: cid, message_id: loading.message_id, parse_mode: 'Markdown' });
  } catch (e) {
    bot.editMessageText('❌ ' + e.message, { chat_id: cid, message_id: loading.message_id });
  }
});

// ======================================================
//  /ot — Optimal entry
// ======================================================
bot.onText(/^\/ot$/, async (m) => {
  const cid = m.chat.id;
  if (!limiter.checkLimit('/ot')) return bot.sendMessage(cid, '⏳ Tunggu...');
  const loading = await bot.sendMessage(cid, '⏳ Hitung OTE...');
  try {
    const tf = getMode().tfs.entry;
    const d = await getCandles(tf, 200);
    if (!d || d.length < 50) return bot.editMessageText('❌ Data kurang', { chat_id: cid, message_id: loading.message_id });
    const a = ict.analyze(d, { lookback: 50 });
    if (!a.premiumDiscount) return bot.editMessageText('❌ Tidak bisa hitung zone', { chat_id: cid, message_id: loading.message_id });
    const pd = a.premiumDiscount;
    const lines = [
      '🎯 *OPTIMAL TRADE ENTRY*',
      `💰 Last: $${fmt(pd.currentPrice)}`,
      '',
      `High: $${fmt(pd.swingHigh)} | Low: $${fmt(pd.swingLow)}`,
      `EQ: $${fmt(pd.equilibrium)} | Zone: *${pd.zone}*`,
      '',
      `🟢 OTE Buy (62%): $${fmt(pd.oTE_buy)}`,
      `🔴 OTE Sell (79%): $${fmt(pd.oTE_sell)}`
    ];
    bot.editMessageText(lines.join('\n'), { chat_id: cid, message_id: loading.message_id, parse_mode: 'Markdown' });
  } catch (e) {
    bot.editMessageText('❌ ' + e.message, { chat_id: cid, message_id: loading.message_id });
  }
});

// ======================================================
//  Multi-TF detail handlers
// ======================================================
async function detailTF(m, tf) {
  const cid = m.chat.id;
  const labels = { '15m': 'M15', '5m': 'M5', '3m': 'M3', '2m': 'M2', '1m': 'M1' };
  if (!limiter.checkLimit('/' + tf)) return bot.sendMessage(cid, '⏳ Tunggu...');
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
      `7-bar H: $${fmt(high)} L: $${fmt(low)}`
    ];
    if (a.premiumDiscount) {
      lines.push(`Zone: *${a.premiumDiscount.zone}* | OTE Buy $${fmt(a.premiumDiscount.oTE_buy)} Sell $${fmt(a.premiumDiscount.oTE_sell)}`);
    }
    bot.editMessageText(lines.join('\n'), { chat_id: cid, message_id: loading.message_id, parse_mode: 'Markdown' });
  } catch (e) {
    bot.editMessageText('❌ ' + e.message, { chat_id: cid, message_id: loading.message_id });
  }
}
bot.onText(/^\/m15$/, (m) => detailTF(m, '15m'));
bot.onText(/^\/m5$/, (m) => detailTF(m, '5m'));
bot.onText(/^\/m3$/, (m) => detailTF(m, '3m'));
bot.onText(/^\/m2$/, (m) => detailTF(m, '2m'));
bot.onText(/^\/m1$/, (m) => detailTF(m, '1m'));

// ======================================================
//  Auto-reply
// ======================================================
bot.on('message', (m) => {
  if (m.text && m.text.startsWith('/')) return;
  const t = (m.text || '').toLowerCase();
  const n = m.from.first_name || 'Trader';
  let r = '';
  if (/halo|hai|hello|hi/.test(t)) r = `Halo ${n}! 👋 /signal untuk analisa.`;
  else if (/signal|analisa|gold|emas|xau/.test(t)) r = `Coba /signal ya ${n} 📊`;
  else if (/help|bantu/.test(t)) r = 'Ketik /help untuk list command.';
  else if (t.length > 0) r = `Hai ${n}! Ketik /signal atau /help.`;
  if (r) bot.sendMessage(m.chat.id, r);
});

// ======================================================
//  Start polling
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
