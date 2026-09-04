// ======================================================
//  🤖 BOT TELEGRAM — XAU/USD ANALYST
// ======================================================
//  Fokus: 1 pair saja (XAU/USD) dengan analisa:
//    - Teknikal klasik (RSI, MACD, EMA, BB)
//    - ICT/SMC structures (OB, FVG, IFVG, Breaker, CISD, Sweep)
//    - Multi-timeframe bias (H4, H1, M15, M5)
//    - SMT (DXY correlation)
//    - High-probability zones (premium/discount equilibrium)
// ======================================================

require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');

// Core modules
const candles = require('./candles');
const xauusdTA = require('./xauusd-ta');
const ict = require('./ict-structures');
const smt = require('./smt-analysis');
const { RateLimiter, Logger, GracefulShutdown } = require('./utils');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TOKEN) {
  console.log('========================================');
  console.log('❌ TELEGRAM_BOT_TOKEN BELUM DIISI!');
  console.log('Isi di file .env lalu restart.');
  console.log('========================================');
  process.exit(1);
}

const TD_KEY = process.env.TWELVE_DATA_API_KEY;
const FH_KEY = process.env.FINNHUB_API_KEY;
console.log('========================================');
console.log('✅ BOT XAU/USD ANALYST');
console.log(`📡 Data: TwelveData ${TD_KEY ? 'ON' : 'OFF'} | Finnhub ${FH_KEY ? 'ON' : 'OFF'}`);
console.log(`⏰ ${new Date().toLocaleString()}`);
console.log('========================================');

const bot = new TelegramBot(TOKEN, { polling: false });

const logger = new Logger('[bot]', 'info');
const commandLimiter = new RateLimiter({
  '/signal': 5,
  '/xauusd': 5,
  '/bias': 5,
  '/zones': 5,
  '/sweep': 5,
  '/ot': 5,
  '/smt': 5,
  '/m15': 10,
  '/m5': 10,
}, 60);

const gracefulShutdown = new GracefulShutdown();
gracefulShutdown.init();

// ======================================================
//  HELPERS
// ======================================================
const fmt = (n, d = 2) => (n === null || n === undefined || !Number.isFinite(n)) ? '—' : Number(n).toFixed(d);

// Fetch candles 1H untuk XAU/USD (multi-TF)
async function fetchMultiTF(symbol = 'xauusd') {
  const tfs = ['1h', '4h', '15m', '5m'];
  const out = {};
  for (const tf of tfs) {
    try {
      const data = await candles.getCandles(symbol, tf, 200);
      out[tf] = data;
    } catch (e) {
      out[tf] = [];
      logger.warn(`fetchMultiTF ${tf} failed: ${e.message}`);
    }
  }
  return out;
}

// ======================================================
//  /start, /help
// ======================================================
const WELCOME = (nama) => `
Halo ${nama}! 👋

*XAU/USD Analyst* — Bot analisa teknikal + ICT/SMC khusus Gold.

📊 *PERINTAH UTAMA:*
/signal  — Signal lengkap (teknikal + ICT + bias + zones)
/bias    — Bias trend (H4, H1, M15, M5)
/zones   — High-probability zones (OB, FVG, IFVG, Breaker)
/sweep   — Liquidity sweep detection
/ot      — Optimal trade entry (premium/discount)
/smt     — Korelasi DXY & silver (SMT divergence)
/m15     — Detail analisa 15 menit
/m5      — Detail analisa 5 menit
/status  — Status bot & uptime
/help    — Bantuan

⚠️ _Bukan saran finansial. Gunakan manajemen risiko._
`;

bot.onText(/\/start/, (msg) => {
  const nama = msg.from.first_name || 'Trader';
  bot.sendMessage(msg.chat.id, WELCOME(nama), { parse_mode: 'Markdown' });
  logger.info(`New user: ${nama} (${msg.chat.id})`);
});

bot.onText(/\/help/, (msg) => {
  const nama = msg.from.first_name || 'Trader';
  bot.sendMessage(msg.chat.id, WELCOME(nama), { parse_mode: 'Markdown' });
});

// ======================================================
//  /status
// ======================================================
const startTime = Date.now();
bot.onText(/\/status/, (msg) => {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const s = uptime % 60;
  const text = `
🟢 *BOT STATUS*
⏱ Uptime: ${h}h ${m}m ${s}s
📡 TwelveData: ${TD_KEY ? '✅' : '❌'}
📡 Finnhub: ${FH_KEY ? '✅' : '❌'}
🎯 Pair: XAU/USD only
🔄 Cache: aktif
`.trim();
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

// ======================================================
//  /bias — Multi-timeframe bias
// ======================================================
bot.onText(/^\/(bias|xauusd-bias)$/, async (msg) => {
  const chatId = msg.chat.id;
  if (!commandLimiter.allow('/bias', chatId)) {
    return bot.sendMessage(chatId, '⏳ Tunggu sebentar...');
  }

  const loading = await bot.sendMessage(chatId, '⏳ Ambil bias multi-timeframe...');
  try {
    const tfs = await fetchMultiTF();
    const lines = ['🎯 *BIAS XAU/USD — MULTI-TIMEFRAME*', ''];

    const labels = { '4h': 'H4', '1h': 'H1', '15m': 'M15', '5m': 'M5' };
    for (const tf of ['4h', '1h', '15m', '5m']) {
      const data = tfs[tf];
      if (!data || data.length < 30) {
        lines.push(`${labels[tf]}: ❌ data tidak cukup`);
        continue;
      }
      // Simple trend detection via SMA7 vs SMA21
      const closes = data.map(c => c.close);
      const sma7 = closes.slice(-7).reduce((a, b) => a + b, 0) / 7;
      const sma21 = closes.slice(-21).reduce((a, b) => a + b, 0) / 21;
      const last = closes[closes.length - 1];
      let trend = 'SIDEWAYS';
      let emoji = '⚪';
      if (sma7 > sma21 && last > sma7) { trend = 'BULLISH'; emoji = '🟢'; }
      else if (sma7 < sma21 && last < sma7) { trend = 'BEARISH'; emoji = '🔴'; }
      else if (sma7 > sma21) { trend = 'PULLBACK-UP'; emoji = '🟡'; }
      else if (sma7 < sma21) { trend = 'PULLBACK-DN'; emoji = '🟠'; }

      const strength = Math.abs(((sma7 - sma21) / sma21) * 100);
      lines.push(`${emoji} *${labels[tf]}:* ${trend} (Δ ${fmt(strength, 3)}%)`);
    }

    // Overall confluence
    const t1 = lines[1].includes('BULLISH') || lines[1].includes('PULLBACK');
    const t2 = lines[2].includes('BULLISH') || lines[2].includes('PULLBACK');
    const t3 = lines[3].includes('BULLISH') || lines[3].includes('PULLBACK');
    const t4 = lines[4].includes('BULLISH') || lines[4].includes('PULLBACK');
    const bullCount = [t1, t2, t3, t4].filter(Boolean).length;

    lines.push('');
    if (bullCount >= 3) lines.push('📈 *CONFLUENCE: BULLISH* — cari setup BUY di discount');
    else if (bullCount <= 1) lines.push('📉 *CONFLUENCE: BEARISH* — cari setup SELL di premium');
    else lines.push('⚖️ *CONFLUENCE: MIXED* — tunggu konfirmasi lebih jelas');

    bot.editMessageText(lines.join('\n'), {
      chat_id: chatId, message_id: loading.message_id, parse_mode: 'Markdown'
    });
  } catch (e) {
    bot.editMessageText(`❌ Error: ${e.message}`, {
      chat_id: chatId, message_id: loading.message_id
    });
  }
});

// ======================================================
//  /zones — High-probability zones
// ======================================================
bot.onText(/^\/(zones|ict)$/, async (msg) => {
  const chatId = msg.chat.id;
  if (!commandLimiter.allow('/zones', chatId)) {
    return bot.sendMessage(chatId, '⏳ Tunggu sebentar...');
  }

  const loading = await bot.sendMessage(chatId, '⏳ Scan high-probability zones XAU/USD...');
  try {
    const tfs = await fetchMultiTF();
    const h1 = tfs['1h'];
    if (!h1 || h1.length < 50) {
      return bot.editMessageText('❌ Data H1 tidak cukup', {
        chat_id: chatId, message_id: loading.message_id
      });
    }
    const last = h1[h1.length - 1].close;
    const analysis = ict.analyze(h1, { lookback: 80 });

    const lines = [];
    lines.push('🎯 *HIGH-PROBABILITY ZONES XAU/USD*');
    lines.push(`💰 Last: *$${fmt(last)}*`);
    lines.push('');

    // Premium/Discount
    if (analysis.premiumDiscount) {
      const pd = analysis.premiumDiscount;
      lines.push('━━━ PREMIUM/DISCOUNT ━━━');
      lines.push(`📊 Zone: *${pd.zone}* (${pd.distanceFromEQ >= 0 ? '+' : ''}${fmt(pd.distanceFromEQ, 3)}% dari EQ)`);
      lines.push(`🎯 OTE Buy: $${fmt(pd.oTE_buy)}`);
      lines.push(`🎯 OTE Sell: $${fmt(pd.oTE_sell)}`);
      lines.push(`Bias: ${pd.bias}`);
      lines.push('');
    }

    // Order Blocks (only near current price)
    if (analysis.orderBlocks && analysis.orderBlocks.length) {
      lines.push('━━━ ORDER BLOCKS ━━━');
      const nearObs = analysis.orderBlocks.filter(ob => {
        const distPct = Math.abs((ob.midpoint - last) / last) * 100;
        return distPct < 2;
      }).slice(0, 3);
      if (nearObs.length === 0) {
        lines.push('(tidak ada OB dekat harga)');
      } else {
        for (const ob of nearObs) {
          const side = ob.type === 'BULLISH_OB' ? '🟢' : '🔴';
          const distPct = ((ob.midpoint - last) / last) * 100;
          lines.push(`${side} ${ob.type.replace('_', ' ')}`);
          lines.push(`   $${fmt(ob.low)} — $${fmt(ob.high)} (mid $${fmt(ob.midpoint)})`);
          lines.push(`   ${distPct >= 0 ? '+' : ''}${fmt(distPct, 3)}% dari last`);
        }
      }
      lines.push('');
    }

    // FVG
    if (analysis.fvgs && analysis.fvgs.length) {
      lines.push('━━━ FAIR VALUE GAPS ━━━');
      const nearFvg = analysis.fvgs.filter(f => {
        const distPct = Math.abs((f.midpoint - last) / last) * 100;
        return distPct < 2;
      }).slice(0, 3);
      if (nearFvg.length === 0) {
        lines.push('(tidak ada FVG dekat harga)');
      } else {
        for (const f of nearFvg) {
          const side = f.type === 'BULLISH_FVG' ? '🟢' : '🔴';
          lines.push(`${side} ${f.type.replace('_', ' ')} (${fmt(f.gapPct, 3)}%)`);
          lines.push(`   $${fmt(f.low)} — $${fmt(f.high)}`);
        }
      }
      lines.push('');
    }

    // IFVG (Inverted FVG — strong S/R)
    if (analysis.ifvgs && analysis.ifvgs.length) {
      lines.push('━━━ INVERTED FVG (Strong S/R) ━━━');
      for (const f of analysis.ifvgs.slice(0, 3)) {
        const side = f.type === 'BULLISH_IFVG' ? '🟢' : '🔴';
        lines.push(`${side} ${f.type.replace('_', ' ')}`);
        lines.push(`   $${fmt(f.low)} — $${fmt(f.high)}`);
      }
      lines.push('');
    }

    // Breaker Blocks
    if (analysis.breakerBlocks && analysis.breakerBlocks.length) {
      lines.push('━━━ BREAKER BLOCKS ━━━');
      for (const b of analysis.breakerBlocks.slice(0, 3)) {
        const side = b.type === 'BULLISH_BREAKER' ? '🟢' : '🔴';
        lines.push(`${side} ${b.type.replace('_', ' ')} (str ${fmt(b.strength, 2)}%)`);
        lines.push(`   $${fmt(b.low)} — $${fmt(b.high)}`);
      }
      lines.push('');
    }

    // CISD
    if (analysis.cisds && analysis.cisds.length) {
      lines.push('━━━ CISD (Change in State of Delivery) ━━━');
      for (const c of analysis.cisds.slice(0, 2)) {
        const side = c.type === 'BULLISH_CISD' ? '🟢' : '🔴';
        lines.push(`${side} ${c.type.replace('_', ' ')} @ $${fmt(c.breakLevel)}`);
      }
      lines.push('');
    }

    // Sweeps
    if (analysis.sweeps && analysis.sweeps.length) {
      lines.push('━━━ LIQUIDITY SWEEPS ━━━');
      for (const s of analysis.sweeps.slice(0, 3)) {
        const side = s.direction === 'BULLISH' ? '🟢' : '🔴';
        lines.push(`${side} ${s.type.replace('_', ' ')} @ $${fmt(s.level)} (${s.rejected ? 'rejected ✓' : 'no reject'})`);
      }
    }

    if (lines.length <= 3) {
      lines.push('');
      lines.push('ℹ️ Tidak ada zone dekat harga. Mungkin sedang trending kuat atau perlu tambah lookback.');
    }

    bot.editMessageText(lines.join('\n'), {
      chat_id: chatId, message_id: loading.message_id, parse_mode: 'Markdown'
    });
  } catch (e) {
    bot.editMessageText(`❌ Error: ${e.message}`, {
      chat_id: chatId, message_id: loading.message_id
    });
  }
});

// ======================================================
//  /sweep — Liquidity sweep
// ======================================================
bot.onText(/^\/sweep$/, async (msg) => {
  const chatId = msg.chat.id;
  if (!commandLimiter.allow('/sweep', chatId)) {
    return bot.sendMessage(chatId, '⏳ Tunggu sebentar...');
  }

  const loading = await bot.sendMessage(chatId, '⏳ Scan liquidity sweep XAU/USD...');
  try {
    const tfs = await fetchMultiTF();
    const lines = ['💧 *LIQUIDITY SWEEP XAU/USD*', ''];

    for (const tf of ['4h', '1h', '15m']) {
      const data = tfs[tf];
      if (!data || data.length < 30) continue;
      const analysis = ict.analyze(data, { lookback: 50 });
      if (!analysis.sweeps || analysis.sweeps.length === 0) continue;

      const labels = { '4h': 'H4', '1h': 'H1', '15m': 'M15' };
      lines.push(`━━━ ${labels[tf]} ━━━`);
      for (const s of analysis.sweeps.slice(0, 3)) {
        const dirEmoji = s.direction === 'BULLISH' ? '🟢' : '🔴';
        const rejectMark = s.rejected ? '✓ rejected' : '✗ no reject';
        lines.push(`${dirEmoji} ${s.type} @ $${fmt(s.level)} ${rejectMark}`);
        lines.push(`   wick ${fmt(s.wick, 2)} | close vs level ${fmt(s.closeVsLevel, 2)}`);
      }
      lines.push('');
    }

    if (lines.length <= 2) {
      lines.push('ℹ️ Tidak ada sweep terdeteksi. Pantau terus untuk stop hunt reversal.');
    }

    bot.editMessageText(lines.join('\n'), {
      chat_id: chatId, message_id: loading.message_id, parse_mode: 'Markdown'
    });
  } catch (e) {
    bot.editMessageText(`❌ Error: ${e.message}`, {
      chat_id: chatId, message_id: loading.message_id
    });
  }
});

// ======================================================
//  /ot — Optimal trade entry (premium/discount)
// ======================================================
bot.onText(/^\/ot$/, async (msg) => {
  const chatId = msg.chat.id;
  if (!commandLimiter.allow('/ot', chatId)) {
    return bot.sendMessage(chatId, '⏳ Tunggu sebentar...');
  }

  const loading = await bot.sendMessage(chatId, '⏳ Hitung optimal trade entry XAU/USD...');
  try {
    const tfs = await fetchMultiTF();
    const h1 = tfs['1h'];
    if (!h1 || h1.length < 50) {
      return bot.editMessageText('❌ Data H1 tidak cukup', {
        chat_id: chatId, message_id: loading.message_id
      });
    }
    const analysis = ict.analyze(h1, { lookback: 50 });
    const last = h1[h1.length - 1].close;

    if (!analysis.premiumDiscount) {
      return bot.editMessageText('❌ Tidak bisa hitung premium/discount', {
        chat_id: chatId, message_id: loading.message_id
      });
    }

    const pd = analysis.premiumDiscount;
    const lines = [];
    lines.push('🎯 *OPTIMAL TRADE ENTRY XAU/USD*');
    lines.push(`💰 Last: *$${fmt(last)}*`);
    lines.push('');
    lines.push('━━━ RANGE & EQUILIBRIUM ━━━');
    lines.push(`High: $${fmt(pd.swingHigh)}`);
    lines.push(`Low:  $${fmt(pd.swingLow)}`);
    lines.push(`Range: $${fmt(pd.range)}`);
    lines.push(`EQ (50%): $${fmt(pd.equilibrium)}`);
    lines.push('');
    lines.push('━━━ ZONE ━━━');
    lines.push(`Current: *${pd.zone}*`);
    lines.push(`Distance from EQ: ${pd.distanceFromEQ >= 0 ? '+' : ''}${fmt(pd.distanceFromEQ, 3)}%`);
    lines.push('');
    lines.push('━━━ OTE LEVELS (ICT) ━━━');
    lines.push(`🟢 OTE Buy (62%): $${fmt(pd.oTE_buy)}`);
    lines.push(`🔴 OTE Sell (79%): $${fmt(pd.oTE_sell)}`);
    lines.push('');
    lines.push('━━━ STRATEGY ━━━');
    if (pd.zone === 'DISCOUNT') {
      lines.push('📈 *Setup: BUY di discount*');
      lines.push(`• Entry zone: $${fmt(pd.oTE_buy)} — $${fmt(pd.equilibrium)}`);
      lines.push(`• SL: below $${fmt(pd.swingLow)}`);
      lines.push(`• TP: equilibrium → swing high`);
    } else {
      lines.push('📉 *Setup: SELL di premium*');
      lines.push(`• Entry zone: $${fmt(pd.equilibrium)} — $${fmt(pd.oTE_sell)}`);
      lines.push(`• SL: above $${fmt(pd.swingHigh)}`);
      lines.push(`• TP: equilibrium → swing low`);
    }

    bot.editMessageText(lines.join('\n'), {
      chat_id: chatId, message_id: loading.message_id, parse_mode: 'Markdown'
    });
  } catch (e) {
    bot.editMessageText(`❌ Error: ${e.message}`, {
      chat_id: chatId, message_id: loading.message_id
    });
  }
});

// ======================================================
//  /smt — SMT dengan DXY
// ======================================================
bot.onText(/^\/smt$/, async (msg) => {
  const chatId = msg.chat.id;
  if (!commandLimiter.allow('/smt', chatId)) {
    return bot.sendMessage(chatId, '⏳ Tunggu sebentar...');
  }

  const loading = await bot.sendMessage(chatId, '⏳ Cek korelasi DXY & silver...');
  try {
    const result = await smt.analyzeWithDXY('xauusd', '1h');
    if (!result || result.error) {
      return bot.editMessageText(`❌ Gagal: ${result?.error || 'no data'}`, {
        chat_id: chatId, message_id: loading.message_id
      });
    }

    const lines = [];
    lines.push('🔗 *SMT DIVERGENCE XAU/USD*');
    lines.push(`💰 XAU: $${fmt(result.primary?.last)}`);
    lines.push(`💵 DXY: ${fmt(result.dxy?.last, 4)}`);
    lines.push('');
    lines.push(`📊 Correlation: *${result.correlation?.direction || 'n/a'}* (${fmt(result.correlation?.strength, 1)}%)`);
    lines.push('');
    if (result.divergence) {
      const divEmoji = result.divergence.type === 'BULLISH' ? '🟢' : '🔴';
      lines.push(`${divEmoji} *DIVERGENCE:* ${result.divergence.type}`);
      lines.push(`   ${result.divergence.description || ''}`);
    } else {
      lines.push('✅ Tidak ada divergence (korelasi sehat)');
    }
    lines.push('');
    if (result.recommendation) {
      lines.push('━━━ REKOMENDASI ━━━');
      lines.push(result.recommendation);
    }

    bot.editMessageText(lines.join('\n'), {
      chat_id: chatId, message_id: loading.message_id, parse_mode: 'Markdown'
    });
  } catch (e) {
    bot.editMessageText(`❌ Error: ${e.message}`, {
      chat_id: chatId, message_id: loading.message_id
    });
  }
});

// ======================================================
//  /signal — Signal lengkap
// ======================================================
bot.onText(/^\/(signal|xauusd)$/, async (msg) => {
  const chatId = msg.chat.id;
  if (!commandLimiter.allow('/signal', chatId)) {
    return bot.sendMessage(chatId, '⏳ Tunggu sebentar...');
  }

  const loading = await bot.sendMessage(chatId, '⏳ Generate signal XAU/USD (teknikal + ICT + bias)...');
  try {
    // 1. Analisa teknikal H1
    const ta = await xauusdTA.analyze(true);
    if (!ta.ok) {
      return bot.editMessageText(`❌ Gagal: ${ta.error}`, {
        chat_id: chatId, message_id: loading.message_id
      });
    }

    // 2. Multi-TF bias
    const tfs = await fetchMultiTF();
    const bias = {};
    for (const tf of ['4h', '1h', '15m', '5m']) {
      const data = tfs[tf];
      if (!data || data.length < 30) continue;
      const closes = data.map(c => c.close);
      const sma7 = closes.slice(-7).reduce((a, b) => a + b, 0) / 7;
      const sma21 = closes.slice(-21).reduce((a, b) => a + b, 0) / 21;
      const last = closes[closes.length - 1];
      if (sma7 > sma21 && last > sma7) bias[tf] = 'BULLISH';
      else if (sma7 < sma21 && last < sma7) bias[tf] = 'BEARISH';
      else if (sma7 > sma21) bias[tf] = 'PB_UP';
      else if (sma7 < sma21) bias[tf] = 'PB_DOWN';
      else bias[tf] = 'SIDE';
    }

    // 3. ICT zones H1
    const h1 = tfs['1h'];
    const ictA = ict.analyze(h1, { lookback: 80 });

    // 4. SMT DXY
    let smtDiv = null;
    try {
      const smtR = await smt.analyzeWithDXY('xauusd', '1h');
      if (smtR && smtR.divergence) smtDiv = smtR.divergence;
    } catch (e) { /* ignore */ }

    // === Susun pesan ===
    const lines = [];
    const dirEmoji = ta.signal.includes('BUY') ? '🟢' : ta.signal.includes('SELL') ? '🔴' : '⚪';
    const dirText = ta.signal.replace('_', ' ');

    lines.push(`${dirEmoji} *XAU/USD SIGNAL — ${dirText}*`);
    lines.push(`💰 Price: *$${fmt(ta.price)}*`);
    lines.push(`🎯 Confidence: *${ta.confidence}%*`);
    lines.push(`🕐 ${ta.datetime}`);
    lines.push('');

    // Bias MTF
    lines.push('━━━ BIAS ━━━');
    const labels = { '4h': 'H4', '1h': 'H1', '15m': 'M15', '5m': 'M5' };
    for (const tf of ['4h', '1h', '15m', '5m']) {
      if (!bias[tf]) continue;
      const em = bias[tf] === 'BULLISH' ? '🟢' : bias[tf] === 'BEARISH' ? '🔴' : '🟡';
      const text = bias[tf] === 'BULLISH' ? 'BULLISH' :
                   bias[tf] === 'BEARISH' ? 'BEARISH' :
                   bias[tf] === 'PB_UP' ? 'PULLBACK-UP' : 'PULLBACK-DN';
      lines.push(`${em} ${labels[tf]}: ${text}`);
    }
    lines.push('');

    // Entry/TP/SL
    lines.push('━━━ PLAN ━━━');
    lines.push(`📍 Entry: *$${fmt(ta.entry)}*`);
    lines.push(`🎯 TP: *$${fmt(ta.tp)}*`);
    lines.push(`🛑 SL: *$${fmt(ta.sl)}*`);
    const risk = Math.max(0.01, Math.abs(ta.entry - ta.sl));
    const reward = Math.abs(ta.tp - ta.entry);
    lines.push(`📏 Risk:Reward = 1:${fmt(reward / risk, 2)}`);
    lines.push('');

    // ICT high-prob zone
    if (ta.signal.includes('BUY')) {
      const buyOB = (ictA.orderBlocks || []).find(o => o.type === 'BULLISH_OB' && o.midpoint < ta.entry);
      const buyFVG = (ictA.fvgs || []).find(f => f.type === 'BULLISH_FVG' && f.midpoint < ta.entry);
      if (buyOB) lines.push(`🎯 Konfirmasi: Bullish OB $${fmt(buyOB.low)} — $${fmt(buyOB.high)}`);
      if (buyFVG) lines.push(`🎯 Konfirmasi: Bullish FVG $${fmt(buyFVG.low)} — $${fmt(buyFVG.high)}`);
    } else if (ta.signal.includes('SELL')) {
      const sellOB = (ictA.orderBlocks || []).find(o => o.type === 'BEARISH_OB' && o.midpoint > ta.entry);
      const sellFVG = (ictA.fvgs || []).find(f => f.type === 'BEARISH_FVG' && f.midpoint > ta.entry);
      if (sellOB) lines.push(`🎯 Konfirmasi: Bearish OB $${fmt(sellOB.low)} — $${fmt(sellOB.high)}`);
      if (sellFVG) lines.push(`🎯 Konfirmasi: Bearish FVG $${fmt(sellFVG.low)} — $${fmt(sellFVG.high)}`);
    }
    if (ictA.premiumDiscount) {
      lines.push(`📊 Zone: *${ictA.premiumDiscount.zone}*`);
    }
    lines.push('');

    // SMT
    if (smtDiv) {
      const em = smtDiv.type === 'BULLISH' ? '🟢' : '🔴';
      lines.push(`🔗 SMT DXY: ${em} ${smtDiv.type}`);
    }

    // Reasons
    if (ta.reasons && ta.reasons.length) {
      lines.push('━━━ ALASAN ━━━');
      ta.reasons.slice(0, 5).forEach(r => lines.push(`• ${r}`));
    }

    lines.push('');
    lines.push('⚠️ _Bukan saran finansial. MM yang baik._');

    bot.editMessageText(lines.join('\n'), {
      chat_id: chatId, message_id: loading.message_id, parse_mode: 'Markdown'
    });
  } catch (e) {
    bot.editMessageText(`❌ Error: ${e.message}`, {
      chat_id: chatId, message_id: loading.message_id
    });
  }
});

// ======================================================
//  /m15, /m5 — Detail TF pendek
// ======================================================
async function detailTF(msg, tf) {
  const chatId = msg.chat.id;
  const key = `/${tf}`;
  if (!commandLimiter.allow(key, chatId)) {
    return bot.sendMessage(chatId, '⏳ Tunggu sebentar...');
  }
  const labels = { '15m': 'M15', '5m': 'M5' };
  const loading = await bot.sendMessage(chatId, `⏳ Ambil detail ${labels[tf]}...`);
  try {
    const data = await candles.getCandles('xauusd', tf, 100);
    if (!data || data.length < 30) {
      return bot.editMessageText('❌ Data tidak cukup', {
        chat_id: chatId, message_id: loading.message_id
      });
    }
    const closes = data.map(c => c.close);
    const sma7 = closes.slice(-7).reduce((a, b) => a + b, 0) / 7;
    const sma21 = closes.slice(-21).reduce((a, b) => a + b, 0) / 21;
    const last = closes[closes.length - 1];
    const high = Math.max(...data.slice(-7).map(c => c.high));
    const low = Math.min(...data.slice(-7).map(c => c.low));
    const analysis = ict.analyze(data, { lookback: 50 });
    let trend = 'SIDEWAYS';
    let em = '⚪';
    if (sma7 > sma21 && last > sma7) { trend = 'BULLISH'; em = '🟢'; }
    else if (sma7 < sma21 && last < sma7) { trend = 'BEARISH'; em = '🔴'; }
    else if (sma7 > sma21) { trend = 'PULLBACK-UP'; em = '🟡'; }
    else if (sma7 < sma21) { trend = 'PULLBACK-DN'; em = '🟠'; }

    const lines = [];
    lines.push(`${em} *XAU/USD — ${labels[tf]} DETAIL*`);
    lines.push(`💰 Last: *$${fmt(last)}*`);
    lines.push(`📈 Trend: *${trend}*`);
    lines.push(`📏 SMA7: $${fmt(sma7)} | SMA21: $${fmt(sma21)}`);
    lines.push(`📊 7-bar High: $${fmt(high)} | Low: $${fmt(low)}`);
    lines.push('');

    if (analysis.premiumDiscount) {
      lines.push(`Zone: *${analysis.premiumDiscount.zone}* (${analysis.premiumDiscount.distanceFromEQ >= 0 ? '+' : ''}${fmt(analysis.premiumDiscount.distanceFromEQ, 3)}%)`);
      lines.push(`OTE Buy $${fmt(analysis.premiumDiscount.oTE_buy)} | Sell $${fmt(analysis.premiumDiscount.oTE_sell)}`);
    }

    if (analysis.sweeps && analysis.sweeps.length) {
      lines.push('');
      lines.push('━━━ SWEEPS ━━━');
      analysis.sweeps.slice(0, 2).forEach(s => {
        const em2 = s.direction === 'BULLISH' ? '🟢' : '🔴';
        lines.push(`${em2} ${s.type} @ $${fmt(s.level)}`);
      });
    }

    bot.editMessageText(lines.join('\n'), {
      chat_id: chatId, message_id: loading.message_id, parse_mode: 'Markdown'
    });
  } catch (e) {
    bot.editMessageText(`❌ Error: ${e.message}`, {
      chat_id: chatId, message_id: loading.message_id
    });
  }
}

bot.onText(/^\/m15$/, (msg) => detailTF(msg, '15m'));
bot.onText(/^\/m5$/, (msg) => detailTF(msg, '5m'));

// ======================================================
//  Auto-reply untuk pesan biasa
// ======================================================
bot.on('message', (msg) => {
  if (msg.text && msg.text.startsWith('/')) return;
  const nama = msg.from.first_name || 'Trader';
  const text = (msg.text || '').toLowerCase();

  let reply = '';
  if (/halo|hai|hello|hi/.test(text)) {
    reply = `Halo ${nama}! 👋 Ketik /signal untuk analisa XAU/USD.`;
  } else if (/signal|analisa|analysis/.test(text)) {
    reply = `Gunakan command /signal ya ${nama} 📊`;
  } else if (/help|bantu/.test(text)) {
    reply = 'Ketik /help untuk lihat semua command.';
  } else if (/emas|gold|xau/.test(text)) {
    reply = 'Gunakan /signal untuk analisa XAU/USD lengkap ✅';
  } else if (text.length > 0) {
    reply = `Hai ${nama}! Aku fokus analis XAU/USD. Coba /signal atau /help.`;
  }
  if (reply) bot.sendMessage(msg.chat.id, reply);
});

// ======================================================
//  START BOT dengan delay (avoid 409 conflict)
// ======================================================
console.log('⏳ Waiting 25 detik sebelum mulai polling (avoid 409)...');
setTimeout(() => {
  console.log('✓ Memulai polling');
  bot.startPolling().catch(e => console.error('startPolling err:', e.message));
}, 25000);

// Polling error handler
bot.on('polling_error', (error) => {
  if (error.message.includes('409') || error.message.includes('Conflict')) {
    console.log('⚠️ 409 conflict detected, restart polling in 15s...');
    setTimeout(() => {
      bot.stopPolling().then(() => {
        setTimeout(() => bot.startPolling().catch(() => {}), 1000);
      });
    }, 15000);
  } else {
    console.error('❌ Polling error:', error.message);
  }
});
