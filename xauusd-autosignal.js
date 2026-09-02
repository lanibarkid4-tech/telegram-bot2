// ======================================================
//  🚀 XAUUSDT AUTO-SIGNAL WATCHER
// ======================================================
//  Monitor real-time signal untuk XAU/USDT (Gold).
//  Kirim notifikasi otomatis ke Telegram ketika ada signal BARU.
//
//  Sumber signal (di-aggregate):
//    - Tape Delta (buyer/seller aggression + CVD trend)
//    - Orderbook Imbalance (buyer/seller heavy)
//    - Whale Activity (large trades + divergences)
//
//  Filter signal (supaya tidak spam):
//    - Min confidence 70%
//    - Severity MEDIUM ke atas
//    - Cooldown antar signal 5 menit (configurable)
//    - Signal direction berubah dari sebelumnya
//
//  USAGE:
//    const autoSignal = require('./xauusd-autosignal');
//    autoSignal.start(bot, sendToChatId);   // aktifkan
//    autoSignal.stop();                      // matikan
//
//    autoSignal.subscribe(chatId);   // chat ini akan terima auto-signal
//    autoSignal.unsubscribe(chatId);
//
//    autoSignal.getStatus();          // cek status
//    autoSignal.getConfig();          // lihat konfigurasi
//    autoSignal.setConfig({...});     // update konfigurasi
// ======================================================

const { SimpleCache, Logger } = require('./utils');

const logger = new Logger('[autosignal]', 'info');

const tapeDelta = require('./tape-delta');
const signals = require('./signal-aggregator');
const orderflow = require('./orderflow');
const whaleAlert = require('./whale-alert');

// ======================================================
//  KONFIGURASI (bisa diubah via setConfig)
// ======================================================
const DEFAULT_CONFIG = {
  enabled: true,
  timeframe: '1m',                  // timeframe analisis (1m/5m/15m)
  minConfidence: 70,                // minimal confidence (%)
  minSeverity: 'MEDIUM',            // minimal severity (LOW/MEDIUM/HIGH/CRITICAL)
  cooldownMs: 5 * 60 * 1000,        // 5 menit antar signal
  checkIntervalMs: 60 * 1000,       // cek signal tiap 60 detik
  requireDirectionChange: true,     // hanya fire kalau direction berubah
  includeWhaleAlerts: true,         // sertakan info whale di pesan
  includeOrderbook: true,           // sertakan info orderbook di pesan
  onlyWhenAllAgree: false,          // kalau true, hanya fire kalau semua komponen setuju
};

let config = { ...DEFAULT_CONFIG };
let isRunning = false;
let checkTimer = null;
let bot = null;
let sendFn = null;
const subscribers = new Set();

// State internal
let lastFiredSignal = null;   // signal terakhir yang dikirim
let lastFiredTs = 0;
let totalSignalsFired = 0;
let startedAt = 0;

// Severity ranking
const SEVERITY_RANK = {
  'WEAK': 0,
  'LOW': 1,
  'MEDIUM': 2,
  'HIGH': 3,
  'CRITICAL': 4,
};

// ======================================================
//  SUBSCRIBER MANAGEMENT
// ======================================================
function subscribe(chatId) {
  subscribers.add(chatId);
  logger.info(`Subscriber added: ${chatId} (total: ${subscribers.size})`);
}

function unsubscribe(chatId) {
  subscribers.delete(chatId);
  logger.info(`Subscriber removed: ${chatId} (total: ${subscribers.size})`);
}

function getSubscribers() {
  return Array.from(subscribers);
}

// ======================================================
//  CONFIG MANAGEMENT
// ======================================================
function getConfig() {
  return { ...config };
}

function setConfig(updates) {
  config = { ...config, ...updates };
  logger.info('Config updated:', config);
  return config;
}

// ======================================================
//  SEVERITY CHECK
// ======================================================
function meetsSeverityMin(severity) {
  const currentRank = SEVERITY_RANK[severity] ?? -1;
  const minRank = SEVERITY_RANK[config.minSeverity] ?? 0;
  return currentRank >= minRank;
}

// ======================================================
//  SIGNAL EVALUATION
// ======================================================
function evaluateSignal() {
  // Pastikan data sudah siap
  const snap = tapeDelta.getSnapshot(config.timeframe, 20);
  if (!snap.bars.length || snap.bars.length < 5) {
    return { ready: false, reason: 'insufficient bars' };
  }

  // Ambil composite signal
  const signal = signals.getCompositeSignal(config.timeframe);

  // Filter confidence
  if (signal.confidence < config.minConfidence) {
    return {
      ready: false,
      reason: `confidence ${signal.confidence}% < ${config.minConfidence}%`,
      signal,
    };
  }

  // Filter direction (skip NEUTRAL)
  if (signal.direction === 'NEUTRAL') {
    return { ready: false, reason: 'direction NEUTRAL', signal };
  }

  // Filter severity
  if (!meetsSeverityMin(signal.severity)) {
    return {
      ready: false,
      reason: `severity ${signal.severity} < ${config.minSeverity}`,
      signal,
    };
  }

  // Filter agreement (opsional)
  const agreementPct = parseFloat(signal.agreement);
  if (config.onlyWhenAllAgree && agreementPct < 100) {
    return { ready: false, reason: 'not all components agree', signal };
  }

  return { ready: true, signal };
}

// ======================================================
//  CHECK SIGNAL BARU (dipanggil tiap interval)
// ======================================================
function checkForNewSignal() {
  if (!config.enabled || !isRunning) return;

  const evaluation = evaluateSignal();

  if (!evaluation.ready) {
    // Debug log saja, jangan spam
    if (Math.random() < 0.05) {
      logger.debug(`No signal: ${evaluation.reason}`);
    }
    return;
  }

  const signal = evaluation.signal;
  const now = Date.now();

  // Cooldown check
  if (lastFiredTs && (now - lastFiredTs) < config.cooldownMs) {
    return;
  }

  // Direction change check (kalau enabled)
  if (config.requireDirectionChange && lastFiredSignal) {
    if (signal.direction === lastFiredSignal.direction) {
      return; // direction sama, skip
    }
  }

  // FIRE! Kirim ke semua subscriber
  fireSignalAlert(signal);
  lastFiredSignal = signal;
  lastFiredTs = now;
  totalSignalsFired++;
}

// ======================================================
//  FIRE SIGNAL ALERT
// ======================================================
function fireSignalAlert(signal) {
  const text = formatAutoSignalMessage(signal);

  logger.info(`🚨 AUTO SIGNAL FIRED: ${signal.direction} (conf ${signal.confidence}%, ${signal.severity})`);

  if (sendFn && subscribers.size > 0) {
    for (const chatId of subscribers) {
      sendFn(chatId, text).catch((e) => {
        logger.error(`Failed send to ${chatId}: ${e.message}`);
      });
    }
  } else if (subscribers.size === 0) {
    logger.warn('No subscribers! Use autoSignal.subscribe(chatId) first.');
  }
}

// ======================================================
//  FORMAT MESSAGE untuk Telegram
// ======================================================
async function formatAutoSignalMessage(signal) {
  const dirIcon = signal.direction === 'BUY' ? '🟢' : '🔴';
  const dirText = signal.direction === 'BUY' ? 'BUY / LONG' : 'SELL / SHORT';
  const sevIcon = {
    'CRITICAL': '🔴🔴🔴',
    'HIGH': '🟠🟠',
    'MEDIUM': '🟡',
    'LOW': '⚪',
  }[signal.severity] || '❓';

  // Ambil harga XAUUSDT saat ini
  let price = 0;
  try {
    const ticker = await orderflow.get24hTicker('XAUUSDT');
    price = ticker.last;
  } catch (e) {
    price = tapeDelta.getSnapshot(config.timeframe, 1).lastPrice;
  }

  // Format harga dengan presisi sesuai XAU
  const fmtPrice = price > 0 ? price.toFixed(2) : 'N/A';

  let msg = `${dirIcon}${dirIcon}${dirIcon} *AUTO SIGNAL XAUUSDT* ${dirIcon}${dirIcon}${dirIcon}\n\n`;
  msg += `🎯 *${dirText}*\n`;
  msg += `💰 Price: \`$${fmtPrice}\`\n`;
  msg += `📊 Confidence: *${signal.confidence}%*\n`;
  msg += `🚨 Severity: ${sevIcon} ${signal.severity}\n`;
  msg += `⏰ Timeframe: ${signal.timeframe}\n`;
  msg += `🤝 Agreement: ${signal.agreement}%\n`;
  msg += `📈 Score: ${signal.score}\n\n`;

  // Component breakdown
  msg += `📊 *Signal Components:*\n`;
  for (const c of signal.components) {
    const cdir = c.score > 10 ? '🟢' : c.score < -10 ? '🔴' : '⚫';
    msg += `  ${cdir} *${c.name}* (${c.weight}%): ${c.score}\n`;
    msg += `     _${c.reason}_\n`;
  }

  // Orderbook info (optional)
  if (config.includeOrderbook) {
    try {
      const book = await orderflow.getOrderBook('XAUUSDT', 10);
      const imbPct = book.imbalance.toFixed(1);
      const imbDir = book.imbalance > 0 ? 'buyer heavy' : 'seller heavy';
      msg += `\n📚 *Orderbook:*\n`;
      msg += `  Bid: $${book.bestBid.toFixed(2)} | Ask: $${book.bestAsk.toFixed(2)}\n`;
      msg += `  Spread: $${book.spread.toFixed(4)}\n`;
      msg += `  Imbalance: *${imbPct}%* (${imbDir})\n`;
    } catch (e) {
      // ignore
    }
  }

  // Whale info (optional)
  if (config.includeWhaleAlerts) {
    try {
      const alerts = whaleAlert.getLatestAlerts ? whaleAlert.getLatestAlerts(3) : [];
      if (alerts.length > 0) {
        msg += `\n🐋 *Recent Whale Activity:*\n`;
        for (const a of alerts.slice(0, 3)) {
          msg += `  ${a.message || a.type}\n`;
        }
      }
    } catch (e) {
      // ignore
    }
  }

  // Footer
  const now = new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    day: '2-digit',
    month: 'short',
  });
  msg += `\n🕐 _${now} WIB_`;
  msg += `\n⚠️ _Bukan saran finansial. Selalu pakai stop loss._`;
  msg += `\n📌 _Auto-fire #${totalSignalsFired + 1}_`;

  return msg;
}

// ======================================================
//  START / STOP
// ======================================================
function start(botInstance, sendMessageFn) {
  if (isRunning) {
    logger.warn('Already running');
    return;
  }

  bot = botInstance;
  sendFn = sendMessageFn || defaultSendFn;
  isRunning = true;
  startedAt = Date.now();

  logger.info('🚀 Starting XAUUSDT auto-signal watcher...');
  logger.info(`Config: ${JSON.stringify(config)}`);

  // Run first check after 10 seconds (give data time to accumulate)
  setTimeout(() => {
    checkForNewSignal();
  }, 10 * 1000);

  // Then schedule periodic checks
  checkTimer = setInterval(checkForNewSignal, config.checkIntervalMs);

  logger.info(`✓ Auto-signal watcher started (check every ${config.checkIntervalMs / 1000}s)`);
}

function stop() {
  if (!isRunning) return;

  isRunning = false;
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }

  logger.info('🛑 Auto-signal watcher stopped');
}

function defaultSendFn(chatId, text) {
  if (!bot) return Promise.reject(new Error('Bot not initialized'));
  return bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

// ======================================================
//  STATUS
// ======================================================
function getStatus() {
  const uptime = isRunning ? Math.floor((Date.now() - startedAt) / 1000) : 0;
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);

  return {
    isRunning,
    uptime: isRunning ? `${hours}h ${minutes}m` : 'stopped',
    totalSignalsFired,
    subscribers: Array.from(subscribers),
    lastFiredSignal: lastFiredSignal ? {
      direction: lastFiredSignal.direction,
      confidence: lastFiredSignal.confidence,
      severity: lastFiredSignal.severity,
      firedAt: new Date(lastFiredTs).toISOString(),
    } : null,
    config,
    nextCheckIn: isRunning && checkTimer ? `${config.checkIntervalMs / 1000}s` : 'N/A',
  };
}

// ======================================================
//  MANUAL TRIGGER (untuk testing)
// ======================================================
function triggerNow() {
  logger.info('Manual trigger requested');
  // Reset lastFiredTs untuk bypass cooldown
  const originalCooldown = lastFiredTs;
  lastFiredTs = 0;
  checkForNewSignal();
  if (!lastFiredTs) {
    // No signal fired, restore
    lastFiredTs = originalCooldown;
  }
}

// ======================================================
//  EXPORTS
// ======================================================
module.exports = {
  start,
  stop,
  subscribe,
  unsubscribe,
  getSubscribers,
  getConfig,
  setConfig,
  getStatus,
  triggerNow,
  // Untuk testing/advanced
  _evaluateSignal: evaluateSignal,
  _formatMessage: formatAutoSignalMessage,
  DEFAULT_CONFIG,
};