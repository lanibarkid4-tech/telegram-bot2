// ======================================================
//  🤖 BOT TELEGRAM UNTUK PEMULA
// ======================================================
//  File ini adalah kode utama bot Anda.
//  Setiap baris sudah diberi penjelasan agar mudah dipahami.
// ======================================================

// 1️⃣  LOAD DOTENV - Untuk membaca file .env (isi token)
require('dotenv').config();

// 2️⃣  IMPORT LIBRARY TELEGRAM - Untuk komunikasi dengan Telegram
const TelegramBot = require('node-telegram-bot-api');

// 2️⃣b IMPORT MODULE FOREX (signal trading gratis)
const forex = require('./forex');

// 2️⃣c IMPORT MODULE ORDERFLOW (XAUUSDT Binance)
const orderflow = require('./orderflow');

// 2️⃣d IMPORT MODULE LIQUIDATION WATCHER
const liquidations = require('./liquidations');

// 2️⃣e IMPORT MODULE TAPE DELTA (buyer/seller aggression per bar)
const tapeDelta = require('./tape-delta');

// 2️⃣f IMPORT MODULE FASTBULL (news & economic calendar scraper)
const fastbull = require('./fastbull');

// 2️⃣g IMPORT UTILITIES (cache, rate limiter, logger)
const { SimpleCache, RateLimiter, Logger, GracefulShutdown, retryWithBackoff } = require('./utils');

// 2️⃣h IMPORT WHALE ALERT (big trades + divergence detection)
const whaleAlert = require('./whale-alert');

// 2️⃣i IMPORT SIGNAL AGGREGATOR (composite signal dari semua data)
const signals = require('./signal-aggregator');

// 3️⃣  AMBIL TOKEN DARI FILE .env
//     Token ini seperti "password" bot Anda. Jangan share ke orang lain!
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// 4️⃣  CEK APAKAH TOKEN SUDAH DIISI
if (!TOKEN) {
  // Kalau token belum diisi, tampilkan pesan error dan hentikan program
  console.log('========================================');
  console.log('❌ TOKEN BELUM DIISI!');
  console.log('========================================');
  console.log('Cara memperbaiki:');
  console.log('1. Buka file .env di folder ini');
  console.log('2. Isi TELEGRAM_BOT_TOKEN dengan token dari BotFather');
  console.log('3. Jalankan ulang: npm start');
  console.log('========================================');
  process.exit(1); // hentikan program
}

// 4️⃣b CEK TWELVE DATA API KEY (untuk forex signals)
const TWELVE_DATA_KEY = process.env.TWELVE_DATA_API_KEY;
if (!TWELVE_DATA_KEY) {
  console.log('========================================');
  console.log('⚠️  TWELVE_DATA_API_KEY BELUM DIISI!');
  console.log('========================================');
  console.log('Forex signal butuh Twelve Data API key (gratis 800 req/hari).');
  console.log('Cara setup (10 detik):');
  console.log('1. Buka https://twelvedata.com/pricing');
  console.log('2. Sign up dengan email');
  console.log('3. Verifikasi email, copy API key dari dashboard');
  console.log('4. Isi TWELVE_DATA_API_KEY di file .env');
  console.log('5. Restart bot');
  console.log('========================================');
  console.log('Bot tetap jalan, tapi command /signal akan error.');
  console.log('========================================');
} else {
  console.log('✅ TWELVE_DATA_API_KEY loaded (forex signal aktif)');
}

// 5️⃣  BUAT BOT BARU dengan metode POLLING
//     Polling = bot cek Telegram secara berkala apakah ada pesan baru
//   Bot instance dibuat tanpa polling dulu (kita start manual setelah delay).
const bot = new TelegramBot(TOKEN, { polling: false });

// 6️⃣  TAMPILKAN PESAN DI CONSOLE bahwa bot sudah jalan
console.log('========================================');
console.log('✅ BOT BERHASIL DIJALANKAN!');
console.log('🤖 Bot siap menerima pesan...');
console.log('⏰ Waktu: ' + new Date().toLocaleString());
console.log('========================================');
console.log('💡 Tekan CTRL + C untuk mematikan bot');

// ======================================================
//  SETUP UTILITIES & RATE LIMITERS
// ======================================================
const logger = new Logger('[bot]', 'info');
const commandLimiter = new RateLimiter({
  '/signal': 5,      // max 5 signal/menit
  '/tape': 10,       // max 10 tape/menit
  '/news': 3,        // max 3 news/menit
  '/calendar': 3,
  '/whale': 5,
}, 60);

const gracefulShutdown = new GracefulShutdown();

// Register shutdown handlers
gracefulShutdown.register('tape-delta', () => new Promise((r) => {
  tapeDelta.stop?.();
  r();
}));
gracefulShutdown.register('whale-alert', () => new Promise((r) => {
  whaleAlert.stop?.();
  r();
}));
gracefulShutdown.register('fastbull', () => new Promise((r) => {
  fastbull.stop?.();
  r();
}));
gracefulShutdown.init();

// === STARTUP TEST: Verifikasi orderflow endpoint bisa diakses ===
(async () => {
  try {
    console.log('🔧 [startup-test] Testing orderflow.getOrderBook(XAUUSDT)...');
    const book = await orderflow.getOrderBook('XAUUSDT', 5);
    console.log(`✅ [startup-test] XAUUSDT orderbook OK: bid=${book.bestBid} ask=${book.bestAsk}`);
  } catch (e) {
    console.error(`❌ [startup-test] XAUUSDT FAILED: ${e.message}`);
  }
})();

// === START BACKGROUND SERVICES ===
// Tape delta: real-time buyer/seller pressure per bar
try {
  tapeDelta.start();
  console.log('✅ [tape-delta] started');
} catch (e) {
  console.error('❌ [tape-delta] start failed:', e.message);
}

// FastBull: news + economic calendar (cache 5 menit)
fastbull.start().catch(e => console.error('❌ [fastbull] start failed:', e.message));

// Whale alert: monitor large trades + divergences
try {
  whaleAlert.start();
  console.log('✅ [whale-alert] started');
} catch (e) {
  console.error('❌ [whale-alert] start failed:', e.message);
}

// === DELAY POLLING START ===
// Tunggu 25 detik untuk pastikan container lama benar-benar mati,
// sehingga tidak kena 409 Conflict dari Telegram getUpdates.
console.log('⏳ Waiting 25 detik sebelum mulai polling (avoid 409)...');
setTimeout(() => {
  console.log('✓ Memulai Telegram polling sekarang');
  bot.startPolling().catch(e => console.error('startPolling err:', e.message));
}, 25000);

// ======================================================
//  PERINTAH /start
// ======================================================
//  Ini artinya: ketika user ketik /start, bot akan balas pesan ini
bot.onText(/\/start/, (pesan) => {
  // Ambil ID chat user (semacam "alamat" user di Telegram)
  const chatId = pesan.chat.id;

  // Ambil nama depan user, kalau gak ada default "Sahabat"
  const nama = pesan.from.first_name || 'Sahabat';

  // Pesan yang akan dikirim ke user
  const teksBalasan = `
Halo ${nama}! 👋

Selamat datang di Bot Telegram saya!

Saya bot yang siap membantu Anda 24 jam.

📌 PERINTAH YANG TERSEDIA:
/start - Tampilkan pesan ini
/help  - Bantuan
/halo  - Sapa bot
/info  - Info tentang Anda
/jam   - Lihat jam sekarang
/quote - Quote motivasi

⚡ ORDERFLOW XAUUSDT (Binance):
/orderflow - Snapshot lengkap (OB + Delta + CVD + Whale)
/cvd       - Cumulative Volume Delta 60 menit
/liquidations - Trade besar futures (indikasi liq)
/orderbook - Top 20 bids/asks
/flow      - Taker buy/sell + delta

📊 FOREX SIGNAL (gratis):
/pairs   - Daftar pair forex
/signal  - Signal EUR/USD
/signal GBPJPY - Pair tertentu
/signals - Semua signal

📈 TAPE DELTA (buyer vs seller aggression):
/tape     - Snapshot tape 1m + CVD + ASCII chart
/tape 5m  - Snapshot per 5 menit
/delta    - Detail delta bar aktif

📰 FASTBULL (news & kalender):
/news     - Top news terbaru
/calendar - Event ekonomi 24 jam ke depan

🐋 WHALE ALERT & COMPOSITE SIGNAL:
/whale              - Aktivitas whale terbaru (>$50K)
/signal-composite   - Composite signal (tape+book+whale)
/signal-composite 5m - Per timeframe
/status            - Bot status & uptime

Silakan coba salah satu perintah di atas! 😊
  `;

  // Kirim pesan ke user
  bot.sendMessage(chatId, teksBalasan);

  // Catat di console bahwa ada user baru
  console.log(`📩 User baru: ${nama} (ID: ${chatId})`);
});

// ======================================================
//  PERINTAH /help
// ======================================================
bot.onText(/\/help/, (pesan) => {
  const chatId = pesan.chat.id;

  const teksBantuan = `
📚 BANTUAN

Berikut perintah yang bisa Anda gunakan:

/start  - Pesan pembuka
/help   - Tampilkan bantuan ini
/halo   - Sapa bot
/info   - Lihat info akun Telegram Anda
/jam    - Lihat waktu sekarang

⚡ ORDERFLOW XAUUSDT (Binance):
/orderflow - Snapshot lengkap (OB + Delta + CVD + Whale)
/cvd       - Cumulative Volume Delta 60 menit
/liquidations - Trade besar futures (indikasi liq)
/orderbook - Top 20 bids/asks
/flow      - Taker buy/sell + delta
/quote  - Dapatkan kata-kata motivasi

📊 FOREX SIGNAL (gratis):
/pairs   - Lihat daftar pair forex
/signal  - Signal EUR/USD (default)
/signal GBPJPY - Signal pair tertentu
/signals - Ringkasan semua pair

� TAPE DELTA (buyer vs seller aggression):
/tape     - Snapshot tape 1m + CVD + ASCII chart
/tape 5m  - Snapshot per 5 menit
/delta    - Detail delta bar aktif

📰 FASTBULL (news & kalender):
/news     - Top news terbaru
/calendar - Event ekonomi 24 jam ke depan

�💡 Tips: Cukup kirim pesan biasa (contoh: "halo", "apa kabar"),
maka bot akan membalas Anda!
  `;

  bot.sendMessage(chatId, teksBantuan);
});

// ======================================================
//  PERINTAH /halo
// ======================================================
bot.onText(/\/halo/, (pesan) => {
  const chatId = pesan.chat.id;
  const nama = pesan.from.first_name || 'Sahabat';

  bot.sendMessage(chatId, `Halo juga ${nama}! 🌟 Senang berjumpa dengan Anda!`);
});

// ======================================================
//  PERINTAH /info
// ======================================================
bot.onText(/\/info/, (pesan) => {
  const chatId = pesan.chat.id;
  const user = pesan.from;

  // Ambil info user
  const id = user.id;
  const namaDepan = user.first_name || '(tidak ada)';
  const namaBelakang = user.last_name || '(tidak ada)';
  const username = user.username ? '@' + user.username : '(tidak ada)';

  const teksInfo = `
👤 INFO AKUN ANDA

🆔 ID        : ${id}
📛 Nama Depan: ${namaDepan}
📛 Nama Blkg : ${namaBelakang}
👤 Username  : ${username}
🌐 Bahasa    : ${user.language_code || '(tidak diketahui)'}
  `;

  bot.sendMessage(chatId, teksInfo);
});

// ======================================================
//  PERINTAH /jam
// ======================================================
bot.onText(/\/jam/, (pesan) => {
  const chatId = pesan.chat.id;

  // Ambil waktu sekarang
  const sekarang = new Date();
  const jam = sekarang.toLocaleString('id-ID', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Asia/Jakarta'
  });

  bot.sendMessage(chatId, `🕐 WAKTU SAAT INI (WIB):\n\n${jam}`);
});

// ======================================================
//  PERINTAH /quote
// ======================================================
const daftarQuote = [
  "Jangan pernah menyerah, karena kegagalan adalah awal dari kesuksesan. 💪",
  "Hidup adalah petualangan yang berani atau tidak sama sekali. 🌟",
  "Sukses dimulai dengan langkah pertama. 🚀",
  "Bermimpilah besar, karena Anda bisa mewujudkannya. ⭐",
  "Jangan takut gagal, takutlah untuk tidak mencoba. 🔥",
  "Hari ini adalah hadiah, maka itu disebut 'hadiah' (present). 🎁",
  "Kegagalan adalah kesempatan untuk memulai lagi dengan lebih cerdas. 🎯",
  "Kerja keras mengalahkan bakat ketika bakat tidak bekerja keras. 🏆"
];

bot.onText(/\/quote/, (pesan) => {
  const chatId = pesan.chat.id;

  // Pilih quote secara acak
  const indexAcak = Math.floor(Math.random() * daftarQuote.length);
  const quoteTerpilih = daftarQuote[indexAcak];

  bot.sendMessage(chatId, `💭 QUOTE HARI INI:\n\n"${quoteTerpilih}"`);
});

// ======================================================
//  📊 PERINTAH FOREX - SIGNAL TRADING
// ======================================================

// /forex atau /signal → signal untuk pair tertentu atau default EURUSD
// Default mode: SCALPING (bisa override: /signal EURUSD swing, dll)
// /signal → GABUNGKAN SEMUA DATA untuk sinyal akurat
// - Forex teknikal (SMA, RSI, support/resistance)
// - Multi-timeframe confluence
// - Orderflow real-time (delta, CVD, orderbook imbalance)
// - Liquidations (whale trades futures)
// - Fundamental (regime, volatility, bias)
bot.onText(/^\/(forex|signal)(\s+(\S+))?(\s+(scalping|intraday|swing))?$/i, async (pesan, match) => {
  const chatId = pesan.chat.id;
  const input = match[3] ? match[3].trim().toUpperCase() : 'EURUSD';
  const mode = match[5] ? match[5].toLowerCase() : 'scalping';

  const loadingMsg = await bot.sendMessage(chatId,
    `⚡ *GABUNGAN SINYAL LENGKAP*\n` +
    `Pair: *${input}* | Mode: *${mode.toUpperCase()}*\n` +
    `⏳ Mengambil data teknikal + orderflow + CVD + orderbook + liquidations + fundamental...`
  );

  try {
    // ===== 1. AMBIL SIGNAL TEKNIKAL FOREX (sudah termasuk orderflow) =====
    const fxResult = await forex.getSignalForPair(input, mode);
    if (!fxResult.success) {
      bot.editMessageText(fxResult.message, { chat_id: chatId, message_id: loadingMsg.message_id });
      return;
    }

    // ===== 2. AMBIL DATA ORDERBOOK, FLOW, CVD (untuk XAUUSD) =====
    let obData = null;
    let flowData = null;
    let cvdData = null;
    let liquidData = null;
    if (input.includes('XAU') || input === 'GOLD') {
      try {
        [obData, flowData, cvdData] = await Promise.all([
          orderflow.getOrderBook('XAUUSDT', 10),
          orderflow.getAggTrades('XAUUSDT', 500),
          orderflow.getCVD('XAUUSDT', 60),
        ]);
      } catch (e) {
        console.warn('orderflow data fetch failed:', e.message);
      }
      // Liquidations (long-running ws, ambil 5 recent)
      try {
        const liqState = liquidations.getState ? liquidations.getState() : null;
        if (liqState && liqState.recent) liquidData = liqState.recent.slice(0, 5);
      } catch (e) {
        // ignore
      }
    }

    // ===== 3. GABUNGKAN semua jadi pesan ringkas =====
    const lines = [];
    // Ambil forex signal message utama (sudah ada orderflow di dalamnya)
    lines.push(fxResult.message);
    lines.push('');

    // Tambahan data mikrostruktur (kalau XAU)
    if (obData || flowData || cvdData || liquidData) {
      lines.push('━━━━━━━━━━━━━━━━━━━━');
      lines.push('📊 *DATA MIKROSTRUKTUR TAMBAHAN (Binance Futures)*');
      lines.push('');

      if (obData) {
        lines.push(`📚 *Orderbook Top 10:*`);
        lines.push(`   Bid: $${obData.bestBid} | Ask: $${obData.bestAsk}`);
        lines.push(`   Spread: $${obData.spread.toFixed(4)} | Imb: *${obData.imbalance.toFixed(1)}%* ${obData.imbalance > 0 ? '(buyer heavy)' : '(seller heavy)'}`);
        // Top 3 bids & asks
        lines.push('   *Top Bids:*');
        obData.bids.slice(0, 3).forEach(b => {
          lines.push(`     $${b.price.toFixed(2)} → ${b.qty.toFixed(2)} XAU`);
        });
        lines.push('   *Top Asks:*');
        obData.asks.slice(0, 3).forEach(a => {
          lines.push(`     $${a.price.toFixed(2)} → ${a.qty.toFixed(2)} XAU`);
        });
        lines.push('');
      }

      if (flowData) {
        lines.push(`⚡ *Taker Flow (${flowData.totalTrades} trades):*`);
        lines.push(`   Buy Vol: *${flowData.buyVol.toFixed(1)}* XAU ($${(flowData.buyValue/1000).toFixed(1)}K)`);
        lines.push(`   Sell Vol: *${flowData.sellVol.toFixed(1)}* XAU ($${(flowData.sellValue/1000).toFixed(1)}K)`);
        lines.push(`   Delta: *${flowData.delta >= 0 ? '+' : ''}${flowData.delta.toFixed(1)}* XAU`);
        lines.push(`   Buy/Sell: *${flowData.buyPct.toFixed(1)}%* / *${flowData.sellPct.toFixed(1)}%*`);
        lines.push('');
      }

      if (cvdData) {
        lines.push(`📈 *CVD (${cvdData.windowMinutes}min):*`);
        lines.push(`   Final: *${cvdData.finalCVD.toFixed(1)}* XAU`);
        lines.push(`   Trend: *${cvdData.trend}* (${cvdData.buckets} buckets)`);
        lines.push('');
      }

      if (liquidData && liquidData.length > 0) {
        lines.push(`💥 *Liquidations (recent ${liquidData.length}):*`);
        liquidData.slice(0, 5).forEach(l => {
          lines.push(`   ${l.side} $${(l.value/1000).toFixed(1)}K @ $${l.price.toFixed(2)}`);
        });
        lines.push('');
      }
    }

    // Kirim pesan gabungan
    bot.editMessageText(lines.join('\n'), {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
      parse_mode: 'Markdown'
    });
  } catch (e) {
    console.error('signal handler error:', e);
    bot.editMessageText(`❌ Error: ${e.message}`, { chat_id: chatId, message_id: loadingMsg.message_id });
  }
});

// /scalping, /swing, /intraday → shortcut untuk mode
bot.onText(/^\/(scalping|swing|intraday)(\s+(\S+))?$/i, async (pesan, match) => {
  const chatId = pesan.chat.id;
  const mode = match[1].toLowerCase();
  const input = match[3] ? match[3].trim().toUpperCase() : 'EURUSD';

  const loadingMsg = await bot.sendMessage(chatId, `⏳ Mode ${mode.toUpperCase()} - Mengambil data ${input}...`);

  const result = await forex.getSignalForPair(input, mode);
  if (result.success) {
    bot.editMessageText(result.message, {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
      parse_mode: 'Markdown'
    });
  } else {
    bot.editMessageText(result.message, {
      chat_id: chatId,
      message_id: loadingMsg.message_id
    });
  }
});

// /modes → lihat 3 mode trading
bot.onText(/^\/modes$/, (pesan) => {
  const chatId = pesan.chat.id;
  const modes = forex.TRADING_MODES || {};
  const lines = [
    '🎯 *3 MODE TRADING*',
    '',
  ];

  for (const [key, cfg] of Object.entries(modes)) {
    lines.push(`${cfg.name}`);
    lines.push(`_${cfg.description}_`);
    lines.push(`⏰ ${cfg.timeInTrade}`);
    lines.push(`📌 ${cfg.bestFor}`);
    lines.push('');
  }

  lines.push('*Cara Pakai:*');
  lines.push('`/scalping EURUSD` - Mode scalping');
  lines.push('`/intraday GBPJPY` - Mode intraday');
  lines.push('`/swing XAUUSD` - Mode swing');
  lines.push('`/signal EURUSD swing` - Dengan mode di argumen');

  bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
});

// /pairs → daftar semua pair forex yang didukung
bot.onText(/^\/pairs$/, (pesan) => {
  const chatId = pesan.chat.id;
  const daftar = forex.SUPPORTED_PAIRS.map(p => `• \`${p.display}\``).join('\n');
  const pesanDaftar = `
📋 *DAFTAR PAIR FOREX*

${daftar}

📌 *Cara pakai:*
Ketik \`/signal EURUSD\` (atau pair lain)
Contoh: \`/signal GBPJPY\`

⏰ Data realtime & historical dari Twelve Data API.
  `;
  bot.sendMessage(chatId, pesanDaftar, { parse_mode: 'Markdown' });
});

// /signals → ringkasan signal semua pair (default mode scalping)
bot.onText(/^\/signals$/, async (pesan) => {
  const chatId = pesan.chat.id;
  const loadingMsg = await bot.sendMessage(chatId, '⚡ Mode SCALPING\n⏳ Mengambil signal semua pair...');

  const results = await forex.getAllSignals('scalping');
  if (!results.length) {
    bot.editMessageText('❌ Gagal mengambil data. Coba lagi nanti.', {
      chat_id: chatId,
      message_id: loadingMsg.message_id
    });
    return;
  }

  // Hitung ringkasan BUY / SELL / NETRAL
  const buy = results.filter(r => r.analysis.signal === 'BUY');
  const sell = results.filter(r => r.analysis.signal === 'SELL');
  const netral = results.filter(r => r.analysis.signal === 'NETRAL');

  const lines = [];
  lines.push('⚡ *RINGKASAN SIGNAL - SCALPING*');
  lines.push(`🕐 ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`);
  lines.push('🎯 *Mode: Scalping (1-15 menit)*');
  lines.push('');
  lines.push('*Ringkasan:*');
  lines.push(`🟢 BUY: ${buy.length} pair`);
  lines.push(`🔴 SELL: ${sell.length} pair`);
  lines.push(`🟡 NETRAL: ${netral.length} pair`);
  lines.push('');
  lines.push('*Detail (urut prioritas):*');

  // Urutkan: BUY dulu, lalu SELL, lalu NETRAL
  const sorted = [...buy, ...sell, ...netral];
  sorted.forEach(({ pair, analysis }) => {
    const emoji = analysis.signal === 'BUY' ? '🟢' : analysis.signal === 'SELL' ? '🔴' : '🟡';
    lines.push(`${emoji} \`${pair.display.padEnd(7)}\` → *${analysis.signal}*`);
  });

  lines.push('');
  lines.push('📌 Detail per pair: `/signal <PAIR>`');
  lines.push('⚠️ _Bukan saran finansial. Gunakan manajemen risiko._');

  bot.editMessageText(lines.join('\n'), {
    chat_id: chatId,
    message_id: loadingMsg.message_id,
    parse_mode: 'Markdown'
  });
});

// ======================================================
//  AUTO-REPLY UNTUK PESAN BIASA
// ======================================================
//  Ini menangkap SEMUA pesan yang bukan command (diawali /)
bot.on('message', (pesan) => {
  // Kalau pesan adalah command (diawali /), abaikan
  // karena sudah ditangani oleh handler di atas
  if (pesan.text && pesan.text.startsWith('/')) return;

  const chatId = pesan.chat.id;
  const nama = pesan.from.first_name || 'Sahabat';
  const teks = (pesan.text || '').toLowerCase(); // ubah ke huruf kecil

  // Cek kata kunci dan beri balasan sesuai
  if (teks.includes('halo') || teks.includes('hai') || teks.includes('hello')) {
    bot.sendMessage(chatId, `Halo juga ${nama}! 👋 Ada yang bisa saya bantu?`);
  }
  else if (teks.includes('apa kabar') || teks.includes('kabar')) {
    bot.sendMessage(chatId, 'Alhamdulillah baik! 😊 Bagaimana dengan Anda?');
  }
  else if (teks.includes('terima kasih') || teks.includes('thanks') || teks.includes('makasih')) {
    bot.sendMessage(chatId, 'Sama-sama! Senang bisa membantu 😊');
  }
  else if (teks.includes('siapa kamu') || teks.includes('kamu siapa')) {
    bot.sendMessage(chatId, 'Saya adalah bot Telegram yang dibuat dengan Node.js! 🤖');
  }
  else if (teks.includes('selamat pagi')) {
    bot.sendMessage(chatId, 'Selamat pagi! ☀️ Semoga harimu menyenangkan!');
  }
  else if (teks.includes('selamat siang')) {
    bot.sendMessage(chatId, 'Selamat siang! 🌤️ Jangan lupa makan siang ya!');
  }
  else if (teks.includes('selamat malam')) {
    bot.sendMessage(chatId, 'Selamat malam! 🌙 Istirahat yang cukup ya!');
  }
  else if (teks.includes('bot') && teks.includes('?')) {
    bot.sendMessage(chatId, 'Ya, saya bot! 🤖 Ketik /help untuk lihat perintah.');
  }
  else {
    // Balasan default untuk pesan yang tidak dikenali
    bot.sendMessage(chatId, `Saya menerima pesan Anda: "${pesan.text}"\n\nKetik /help untuk melihat daftar perintah.`);
  }
});

// ======================================================
//  ⚡ PERINTAH ORDERFLOW XAUUSDT - BINANCE
// ======================================================

// /orderflow → snapshot lengkap (OB + Flow + CVD + Whale)
bot.onText(/^\/orderflow$/, async (pesan) => {
  const chatId = pesan.chat.id;
  console.log('📞 /orderflow request from chat', chatId);
  const loadingMsg = await bot.sendMessage(
    chatId,
    '📊 Mengambil orderflow XAUUSDT dari Binance...\n⏳ Orderbook + AggTrades + CVD + OI'
  );
  try {
    const snap = await orderflow.getFullOrderflow('XAUUSDT');
    console.log('✓ /orderflow success');
    const text = orderflow.formatOrderflowMessage(snap);
    bot.editMessageText(text, {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
      parse_mode: 'Markdown',
    });
  } catch (e) {
    console.error('✗ /orderflow error:', e.message);
    bot.editMessageText(
      `❌ Gagal mengambil orderflow: ${e.message}\n\n` +
      `Coba lagi dalam beberapa detik.`,
      { chat_id: chatId, message_id: loadingMsg.message_id }
    );
  }
});

// /debugof → debug orderflow symbols (test XAUUSDT vs BTCUSDT)
bot.onText(/^\/debugof$/, async (pesan) => {
  const chatId = pesan.chat.id;
  const loadingMsg = await bot.sendMessage(chatId, '🔧 Testing Binance Futures endpoints...');
  try {
    const tests = [
      { name: 'XAUUSDT', fn: () => orderflow.getOrderBook('XAUUSDT', 5) },
      { name: 'BTCUSDT', fn: () => orderflow.getOrderBook('BTCUSDT', 5) },
      { name: 'ETHUSDT', fn: () => orderflow.getOrderBook('ETHUSDT', 5) },
      { name: 'PAXGUSDT', fn: () => orderflow.getOrderBook('PAXGUSDT', 5) },
      { name: 'XAUUSDT-ticker', fn: () => orderflow.get24hTicker('XAUUSDT') },
      { name: 'XAUUSDT-aggTrades', fn: () => orderflow.getAggTrades('XAUUSDT', 5) },
    ];

    let msg = '🔧 *DEBUG ORDERFLOW*\n\n';
    for (const t of tests) {
      try {
        const r = await t.fn();
        const summary = r.bestBid !== undefined
          ? `bid=${r.bestBid} ask=${r.bestAsk}`
          : r.last !== undefined
          ? `last=$${r.last}`
          : r.totalTrades !== undefined
          ? `${r.totalTrades} trades`
          : 'OK';
        msg += `✅ *${t.name}*: ${summary}\n`;
      } catch (e) {
        msg += `❌ *${t.name}*: ${e.message.slice(0, 200)}\n`;
      }
    }
    bot.editMessageText(msg, { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' });
  } catch (e) {
    bot.editMessageText(`❌ Debug error: ${e.message}`, { chat_id: chatId, message_id: loadingMsg.message_id });
  }
});

// /cvd → fokus CVD 60 menit
bot.onText(/^\/cvd$/, async (pesan) => {
  const chatId = pesan.chat.id;
  const loadingMsg = await bot.sendMessage(chatId, '📈 Menghitung CVD 60 menit XAUUSDT...');
  try {
    const cvd = await orderflow.getCVD('XAUUSDT', 60);
    const ticker = await orderflow.get24hTicker('XAUUSDT');
    const trendEmoji = cvd.trend.includes('BULLISH')
      ? '📈'
      : cvd.trend.includes('BEARISH')
      ? '📉'
      : '➡️';

    let msg = `${trendEmoji} *CVD XAUUSDT — ${cvd.windowMinutes}min window*\n`;
    msg += `━━━━━━━━━━━━━━━━━━\n`;
    msg += `💰 Last: $${orderflow.fmt(ticker.last)}\n`;
    msg += `📊 Final CVD: *${orderflow.fmt(cvd.finalCVD, 1)}* XAU\n`;
    msg += `🎯 Trend: *${cvd.trend}*\n`;
    msg += `🕐 Buckets (1min): ${cvd.buckets}\n\n`;

    // Tampilkan 10 bucket terakhir
    const last10 = cvd.series.slice(-10);
    msg += `*Last 10 menit (delta per bucket):*\n`;
    for (const b of last10) {
      const dEmoji = b.delta >= 0 ? '🟢' : '🔴';
      const time = new Date(b.time).toLocaleTimeString('id-ID', {
        timeZone: 'Asia/Jakarta',
        hour: '2-digit',
        minute: '2-digit',
      });
      msg += `${dEmoji} ${time} → Δ ${b.delta >= 0 ? '+' : ''}${orderflow.fmt(b.delta, 2)} (CVD: ${orderflow.fmt(b.cvd, 1)})\n`;
    }
    msg += `\n📌 _CVD naik + harga naik = uptrend sehat. CVD divergence = warning._`;

    bot.editMessageText(msg, {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
      parse_mode: 'Markdown',
    });
  } catch (e) {
    bot.editMessageText(`❌ Error: ${e.message}`, {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
    });
  }
});

// /orderbook → top 20 bids/asks + imbalance
bot.onText(/^\/orderbook$/, async (pesan) => {
  const chatId = pesan.chat.id;
  const loadingMsg = await bot.sendMessage(chatId, '📚 Mengambil orderbook XAUUSDT...');
  try {
    const book = await orderflow.getOrderBook('XAUUSDT', 20);
    const ticker = await orderflow.get24hTicker('XAUUSDT');
    let msg = `📚 *ORDER BOOK XAUUSDT (Top 20)*\n`;
    msg += `━━━━━━━━━━━━━━━━━━\n`;
    msg += `💰 Last: $${orderflow.fmt(ticker.last)}\n`;
    msg += `🟢 Bid: $${orderflow.fmt(book.bestBid)} | 🔴 Ask: $${orderflow.fmt(book.bestAsk)}\n`;
    msg += `📏 Spread: $${orderflow.fmt(book.spread, 4)} (${orderflow.fmt(book.spreadPct, 4)}%)\n`;
    msg += `📊 Mid: $${orderflow.fmt(book.midPrice)}\n`;
    msg += `⚖️ Imbalance: *${orderflow.fmt(book.imbalance, 1)}%* ${book.imbalance > 0 ? '(buyer heavy)' : '(seller heavy)'}\n\n`;

    msg += `*ASKS (sell side):*\n`;
    book.asks.slice(0, 10).reverse().forEach((a) => {
      msg += `  $${orderflow.fmt(a.price)} → ${orderflow.fmt(a.qty, 2)} XAU\n`;
    });
    msg += `\n*BIDS (buy side):*\n`;
    book.bids.slice(0, 10).forEach((b) => {
      msg += `  $${orderflow.fmt(b.price)} → ${orderflow.fmt(b.qty, 2)} XAU\n`;
    });
    msg += `\n📌 _Imbalance > +10% = buyer dominan, <-10% = seller dominan._`;

    bot.editMessageText(msg, {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
      parse_mode: 'Markdown',
    });
  } catch (e) {
    bot.editMessageText(`❌ Error: ${e.message}`, {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
    });
  }
});

// /flow → fokus taker buy/sell delta
bot.onText(/^\/flow$/, async (pesan) => {
  const chatId = pesan.chat.id;
  const loadingMsg = await bot.sendMessage(chatId, '🌊 Menghitung taker flow 500 trades terakhir...');
  try {
    const agg = await orderflow.getAggTrades('XAUUSDT', 500);
    const ticker = await orderflow.get24hTicker('XAUUSDT');
    const emoji = agg.delta > 0 ? '🟢' : agg.delta < 0 ? '🔴' : '⚪';

    let msg = `${emoji} *TAKER FLOW XAUUSDT (${agg.totalTrades} trades)*\n`;
    msg += `━━━━━━━━━━━━━━━━━━\n`;
    msg += `💰 Last: $${orderflow.fmt(ticker.last)} (${ticker.changePct >= 0 ? '+' : ''}${orderflow.fmt(ticker.changePct, 2)}% 24h)\n\n`;
    msg += `🟢 *Buy Volume:*  ${orderflow.fmt(agg.buyVol, 1)} XAU ($${orderflow.fmtBig(agg.buyValue)})\n`;
    msg += `   Trades: ${agg.buyCount}\n\n`;
    msg += `🔴 *Sell Volume:* ${orderflow.fmt(agg.sellVol, 1)} XAU ($${orderflow.fmtBig(agg.sellValue)})\n`;
    msg += `   Trades: ${agg.sellCount}\n\n`;
    msg += `⚡ *DELTA:* *${agg.delta >= 0 ? '+' : ''}${orderflow.fmt(agg.delta, 1)}* XAU\n`;
    msg += `📊 Buy: *${orderflow.fmt(agg.buyPct, 1)}%* | Sell: *${orderflow.fmt(agg.sellPct, 1)}%*\n\n`;

    // Deteksi whale
    const whales = orderflow.detectWhales(agg.trades, 50000);
    if (whales.length > 0) {
      msg += `🐋 *WHALE TRADES (≥$50K):*\n`;
      for (const w of whales.slice(0, 5)) {
        msg += `   ${w.side} $${orderflow.fmtBig(w.value)} @ $${orderflow.fmt(w.price)}\n`;
      }
    } else {
      msg += `_Tidak ada whale trades terdeteksi._`;
    }

    msg += `\n📌 _Delta+ & harga+ = trend sehat. Delta-/harga+ = divergence (warning)._`;

    bot.editMessageText(msg, {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
      parse_mode: 'Markdown',
    });
  } catch (e) {
    bot.editMessageText(`❌ Error: ${e.message}`, {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
    });
  }
});

// /liquidations → trade besar futures XAUUSDT
bot.onText(/^\/liquidations$/, async (pesan) => {
  const chatId = pesan.chat.id;
  const loadingMsg = await bot.sendMessage(chatId, '⚡ Scan liquidations XAUUSDT Futures...');
  try {
    const liqs = await liquidations.getRecentLiquidations(100);
    const msg = liquidations.formatLiquidationsList(liqs);
    bot.editMessageText(msg, {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
      parse_mode: 'Markdown',
    });
  } catch (e) {
    bot.editMessageText(`❌ Error: ${e.message}`, {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
    });
  }
});

// /alert on|off → enable/disable liquidation alert ke chat ini
const alertSubscribers = new Set();
bot.onText(/^\/alert\s+(on|off)$/i, (pesan, match) => {
  const chatId = pesan.chat.id;
  const state = match[1].toLowerCase();
  if (state === 'on') {
    alertSubscribers.add(chatId);
    bot.sendMessage(
      chatId,
      '🔔 *Liquidation alert AKTIF*\n\nAnda akan menerima notifikasi setiap ada spike trade besar (≥$' +
        orderflow.fmtBig(liquidations.SPIKE_THRESHOLD_USD) +
        ') di XAUUSDT Futures.\n\nMatikan dengan: `/alert off`',
      { parse_mode: 'Markdown' }
    );
  } else {
    alertSubscribers.delete(chatId);
    bot.sendMessage(chatId, '🔕 Liquidation alert dimatikan.');
  }
});

// ======================================================
//  🔥 START LIQUIDATION WATCHER (WebSocket auto-alert)
// ======================================================
liquidations.connectLiquidationStream((trade) => {
  const alertText = liquidations.formatLiquidationAlert(trade);
  console.log('[alert]', alertText.replace(/\n/g, ' | '));
  for (const chatId of alertSubscribers) {
    bot.sendMessage(chatId, alertText, { parse_mode: 'Markdown' }).catch((e) => {
      console.error('Failed send alert to', chatId, e.message);
    });
  }
});

// ======================================================
//  PERINTAH /tape - TAPE DELTA SNAPSHOT
// ======================================================
//  Format: /tape         -> 1m default
//          /tape 5m      -> 5m
//          /tape 15m     -> 15m
bot.onText(/^\/tape(?: (1m|5m|15m))?$/, async (pesan, match) => {
  const chatId = pesan.chat.id;
  const tf = match[1] || '1m';

  try {
    const text = tapeDelta.formatTapeMessage(tf);
    // Telegram max 4096 chars; ASCII chart bisa panjang. Split kalau perlu.
    if (text.length <= 4000) {
      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } else {
      // Split: kirim header (Markdown) + chart sebagai plain text
      const parts = text.split('```');
      // parts[0] = header markdown, parts[1] = chart code, parts[2] = footer markdown
      if (parts.length >= 3) {
        await bot.sendMessage(chatId, parts[0], { parse_mode: 'Markdown' });
        await bot.sendMessage(chatId, '```\n' + parts[1] + '\n```');
        if (parts[2] && parts[2].trim()) {
          await bot.sendMessage(chatId, parts[2], { parse_mode: 'Markdown' });
        }
      } else {
        await bot.sendMessage(chatId, text.slice(0, 4000));
      }
    }
  } catch (e) {
    console.error('/tape error:', e.message);
    bot.sendMessage(chatId, `❌ /tape error: ${e.message}`);
  }
});

// ======================================================
//  PERINTAH /delta - DETAIL DELTA BAR AKTIF
// ======================================================
bot.onText(/^\/delta(?: (1m|5m|15m))?$/, (pesan, match) => {
  const chatId = pesan.chat.id;
  const tf = match[1] || '1m';

  const bar = tapeDelta.getLatestBar(tf);
  if (!bar) {
    return bot.sendMessage(chatId, `⏳ Belum ada data bar ${tf}. Tunggu beberapa detik...`);
  }
  const cvd = tapeDelta.getCVD(tf, 20);
  const side = bar.delta >= 0 ? '🟢 BUY pressure' : '🔴 SELL pressure';
  const text = `📊 *DELTA BAR* ${tapeDelta.SYMBOL} (${tf})\n\n` +
    `🕐 Bar start: \`${new Date(bar.start).toISOString().substr(11, 19)} UTC\`\n` +
    `💰 OHLC: \`${bar.open.toFixed(2)} / ${bar.high.toFixed(2)} / ${bar.low.toFixed(2)} / ${bar.close.toFixed(2)}\`\n` +
    `📈 Buy vol:  \`${bar.buyVol.toFixed(2)}\` (${bar.buyCount} trades)\n` +
    `📉 Sell vol: \`${bar.sellVol.toFixed(2)}\` (${bar.sellCount} trades)\n` +
    `⚖️  Delta:   \`${bar.delta >= 0 ? '+' : ''}${bar.delta.toFixed(2)}\`\n` +
    `📊 CVD (20): \`${cvd.last >= 0 ? '+' : ''}${cvd.last.toFixed(2)}\`\n` +
    `🎯 Pressure: ${side}`;

  bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
});

// ======================================================
//  PERINTAH /news - FASTBULL TOP NEWS
// ======================================================
bot.onText(/^\/news$/, async (pesan) => {
  const chatId = pesan.chat.id;
  const loading = await bot.sendMessage(chatId, '⏳ Mengambil news dari FastBull...');
  try {
    const items = await fastbull.getNews(8);
    const text = fastbull.formatNewsMessage(items, 8);
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: loading.message_id,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
  } catch (e) {
    console.error('/news error:', e.message);
    await bot.editMessageText(`❌ /news error: ${e.message}`, {
      chat_id: chatId,
      message_id: loading.message_id,
    });
  }
});

// ======================================================
//  PERINTAH /calendar - FASTBULL ECONOMIC CALENDAR
// ======================================================
bot.onText(/^\/calendar$/, async (pesan) => {
  const chatId = pesan.chat.id;
  const loading = await bot.sendMessage(chatId, '⏳ Mengambil kalender ekonomi dari FastBull...');
  try {
    const items = await fastbull.getCalendar(24);
    const text = fastbull.formatCalendarMessage(items, 24);
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: loading.message_id,
      parse_mode: 'Markdown',
    });
  } catch (e) {
    console.error('/calendar error:', e.message);
    await bot.editMessageText(`❌ /calendar error: ${e.message}`, {
      chat_id: chatId,
      message_id: loading.message_id,
    });
  }
});

// ======================================================
//  PERINTAH /whale - WHALE ACTIVITY MONITOR
// ======================================================
bot.onText(/^\/whale$/, (pesan) => {
  const chatId = pesan.chat.id;

  if (!commandLimiter.checkLimit('/whale')) {
    return bot.sendMessage(chatId, `⏱️ Rate limit /whale. Remaining: ${commandLimiter.getRemainingCalls('/whale')} calls/min`);
  }

  try {
    const alerts = whaleAlert.getLatestAlerts(5);
    if (!alerts || !alerts.length) {
      return bot.sendMessage(chatId, `🐋 *WHALE ALERT*\n\n⏳ Tidak ada aktivitas whale saat ini.`);
    }

    let text = `🐋 *WHALE ALERTS* (top ${alerts.length}):\n\n`;
    for (const alert of alerts) {
      text += whaleAlert.formatAlertMessage(alert) + '\n\n';
    }
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (e) {
    logger.error('/whale error', e.message);
    bot.sendMessage(chatId, `❌ /whale error: ${e.message}`);
  }
});

// ======================================================
//  PERINTAH /signal-composite - COMPOSITE SIGNAL
// ======================================================
bot.onText(/^\/signal-composite(?: (1m|5m|15m))?$/, (pesan, match) => {
  const chatId = pesan.chat.id;
  const tf = match[1] || '1m';

  if (!commandLimiter.checkLimit('/signal')) {
    return bot.sendMessage(chatId, `⏱️ Rate limit /signal. Remaining: ${commandLimiter.getRemainingCalls('/signal')} calls/min`);
  }

  try {
    const signal = signals.getCompositeSignal(tf);
    const text = signals.formatSignalMessage(signal);
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (e) {
    logger.error('/signal-composite error', e.message);
    bot.sendMessage(chatId, `❌ /signal-composite error: ${e.message}`);
  }
});

// ======================================================
//  PERINTAH /status - BOT STATUS & STATS
// ======================================================
bot.onText(/^\/status$/, (pesan) => {
  const chatId = pesan.chat.id;

  const uptime = Math.floor((Date.now() - (stats.startedAt || Date.now())) / 1000);
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = uptime % 60;

  const tapeDeltaSnap = tapeDelta.getSnapshot('1m', 5);
  const whaleAlerts = whaleAlert.getLatestAlerts ? whaleAlert.getLatestAlerts(3) : [];

  let text = `🤖 *BOT STATUS*\n\n`;
  text += `⏱️ Uptime: ${hours}h ${minutes}m ${seconds}s\n`;
  text += `📊 Tape Delta Bars (1m): ${tapeDeltaSnap.bars.length}\n`;
  text += `🐋 Whale Alerts: ${whaleAlerts.length}\n`;
  text += `📰 News Cache: ${fastbull.CACHE_TTL_MS / 1000}s TTL\n\n`;

  text += `✅ Services Running:\n`;
  text += `  ✓ Tape Delta (aggTrade)\n`;
  text += `  ✓ Whale Alert Monitor\n`;
  text += `  ✓ FastBull News/Calendar\n`;
  text += `  ✓ Signal Aggregator\n\n`;

  text += `💡 Tips: /help untuk lihat semua command`;

  bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
});

// ======================================================
//  ERROR HANDLING
// ======================================================
let pollingRestartTimer = null;
bot.on('polling_error', (error) => {
  console.log('❌ Polling error:', error.message);

  // Auto-restart polling kalau kena 409 Conflict (biasanya karena container lama masih jalan)
  if (error.message && (error.message.includes('409') || error.message.includes('Conflict'))) {
    if (pollingRestartTimer) return; // sudah ada timer pending
    console.log('🔄 Akan restart polling dalam 15 detik...');
    pollingRestartTimer = setTimeout(() => {
      pollingRestartTimer = null;
      try {
        console.log('🔄 Restarting polling now...');
        bot.stopPolling().then(() => {
          setTimeout(() => {
            bot.startPolling();
            console.log('✓ Polling restarted');
          }, 1000);
        }).catch(e => console.error('stopPolling err:', e.message));
      } catch (e) {
        console.error('Restart polling failed:', e.message);
      }
    }, 15000);
  }
});

process.on('unhandledRejection', (error) => {
  console.log('❌ Error tidak tertangani:', error.message);
});

// ======================================================
//  TANGANI KETIKA BOT DIMATIKAN
// ======================================================
process.on('SIGINT', () => {
  console.log('\n👋 Bot dimatikan. Sampai jumpa!');
  bot.stopPolling();
  process.exit(0);
});
