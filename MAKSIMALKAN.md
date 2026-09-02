# 🚀 Bot Telegram Pemula - MAKSIMALKAN Edition

Upgrade bot Anda dengan:
- **Tape Delta Real-time**: Monitor buyer/seller pressure per bar (1m/5m/15m)
- **Whale Alert Monitor**: Deteksi trade >$50K + divergence patterns
- **Signal Aggregator**: Composite signal dari tape + orderbook + whale activity
- **FastBull Scraper**: Real-time news + economic calendar
- **Advanced Utils**: Rate limiter, caching, graceful shutdown, batch processor

---

## 📦 File Baru (Maksimalkan)

| File | Fungsi |
|---|---|
| `utils.js` | SimpleCache, RateLimiter, Logger, BatchProcessor, retryWithBackoff |
| `tape-delta.js` | Real-time buyer/seller pressure per bar (1m/5m/15m) |
| `whale-alert.js` | Monitor whale trades (>$50K), divergences, absorption |
| `signal-aggregator.js` | Composite signal: tape + orderbook + whale |
| `fastbull.js` | Scraper news + economic calendar (cache 5 menit) |

---

## 🎯 Fitur Baru

### 1. Tape Delta (Real-time Momentum)
Hitung per bar:
- **Buy Volume** vs **Sell Volume** (aggressive trade classification)
- **Delta** = buy - sell per bar
- **CVD** (Cumulative Volume Delta)
- **Whale Trades** (≥$50K per trade)
- **ASCII chart** untuk visualisasi di Telegram

**Commands:**
```
/tape       - Snapshot 1m (default)
/tape 5m    - Snapshot 5m
/tape 15m   - Snapshot 15m
/delta      - Detail bar aktif sekarang
```

### 2. Whale Alert Monitor
Deteksi real-time:
- **Large Trades** >$50K (whale activity)
- **Bar Concentration** >70% buy/sell (pressure)
- **Bearish/Bullish Divergence** (price up but delta down = exhaustion)
- **Absorption** (buyer stepping in after seller dump = accumulation)

**Commands:**
```
/whale      - Top 5 whale alerts terbaru
```

### 3. Composite Signal (Aggregator)
Gabung semua sinyal jadi satu:
- 35% weight: Tape Delta (momentum)
- 25% weight: Orderbook Imbalance (structure)
- 20% weight: Whale Activity (accumulation)
- 20% weight: Economic Calendar (event risk)

Output:
- **Direction**: BUY / SELL / NEUTRAL
- **Confidence**: 0-100%
- **Severity**: CRITICAL / HIGH / MEDIUM / LOW / WEAK
- **Agreement**: % komponen yang convergence

**Commands:**
```
/signal-composite       - Signal 1m
/signal-composite 5m    - Signal 5m
/signal-composite 15m   - Signal 15m
```

### 4. FastBull News & Calendar
Scraper HTML ringan dari FastBull:
- Top 10 news (cache 5 menit)
- Economic calendar 24 jam ke depan
- High impact events disorot 🔥
- Auto-refresh setiap 5 menit

**Commands:**
```
/news       - Top news
/calendar   - Event ekonomi
```

### 5. Bot Status & Monitoring
**Commands:**
```
/status     - Bot uptime, services running, stats
```

---

## ⚙️ Advanced Utils

### SimpleCache
```javascript
const { SimpleCache } = require('./utils');
const cache = new SimpleCache(300, 100); // 5 min TTL, max 100 items
cache.set('key', data);
const result = cache.get('key');
```

### RateLimiter
```javascript
const { RateLimiter } = require('./utils');
const limiter = new RateLimiter({
  '/signal': 5,    // max 5 calls/min
  '/tape': 10,     // max 10 calls/min
}, 60);

if (limiter.checkLimit('/signal')) {
  // proceed
}
```

### Logger
```javascript
const { Logger } = require('./utils');
const logger = new Logger('[my-module]', 'info');
logger.debug('Debug message');
logger.info('Info message');
logger.warn('Warning');
logger.error('Error', { detail: 'data' });
```

### GracefulShutdown
```javascript
const { GracefulShutdown } = require('./utils');
const shutdown = new GracefulShutdown();
shutdown.register('module1', async () => { /* cleanup */ });
shutdown.init(); // listen SIGTERM/SIGINT
```

### retryWithBackoff
```javascript
const { retryWithBackoff } = require('./utils');
const result = await retryWithBackoff(
  () => fetch(url),
  3,      // max retries
  500     // base delay ms (exponential)
);
```

---

## 🔧 Performance Tunning

### Rate Limiting
- `/signal`: max 5/min (API expensive)
- `/tape`: max 10/min (WebSocket stream cheap)
- `/news`: max 3/min (HTML scraping, respect server)
- `/calendar`: max 3/min

### Caching
- **Tape Delta**: rolling 60 bars per timeframe (memory efficient)
- **FastBull**: 5 min TTL (news + calendar)
- **Signal**: 30 sec cache (composite signal)

### Memory Management
- **SimpleCache**: auto-evict oldest item when maxItems reached
- **Rolling windows**: only keep last N bars (default 60)
- **Whale alerts**: deduplicate within 2 sec (prevent spam)

### Graceful Shutdown
Register cleanup handlers untuk:
- Close WebSocket connections (tape-delta, whale-alert)
- Stop FastBull cache warmer
- Flush any pending requests

---

## 📊 Signal Aggregator Example

```javascript
const signals = require('./signal-aggregator');

// Get composite signal
const sig = signals.getCompositeSignal('1m');
// {
//   direction: 'BUY',
//   confidence: 85,
//   severity: 'HIGH',
//   agreement: '100%',
//   components: [
//     { name: 'TAPE_DELTA', score: 45.3, weight: '35%' },
//     { name: 'ORDERBOOK', score: 30.1, weight: '25%' },
//     { name: 'WHALE', score: 25.0, weight: '20%' },
//     { name: 'CALENDAR', score: 0, weight: '20%' }
//   ]
// }
```

---

## 🐋 Whale Alert Example

Monitor aktivitas besar:

```
🐋 WHALE TRADE [CRITICAL]
Side: BUY
Price: $2045.50
Qty: 500.00
Value: $1,022,750.00
```

Juga deteksi pola:
- **BEARISH DIVERGENCE**: harga +2.5%, delta -15% (exhaustion)
- **ABSORPTION**: Seller dump + buyer stepping in (accumulation)
- **CONCENTRATION**: 75% buy pressure (one-sided)

---

## 📈 Command Quick Reference

| Command | Fungsi | Rate Limit |
|---|---|---|
| `/tape` | Tape delta 1m | 10/min |
| `/tape 5m` | Tape delta 5m | 10/min |
| `/delta` | Detail bar aktif | 10/min |
| `/whale` | Whale alerts | 5/min |
| `/signal-composite` | Composite signal | 5/min |
| `/signal-composite 5m` | Composite 5m | 5/min |
| `/news` | FastBull news | 3/min |
| `/calendar` | Event ekonomi | 3/min |
| `/status` | Bot status | unlimited |

---

## 🚀 Deploy

```bash
# Stage files baru
git add utils.js whale-alert.js signal-aggregator.js tape-delta.js fastbull.js

# Commit
git commit -m "feat: whale-alert, signal-aggregator, utils optimization"

# Deploy ke Railway
node ./redeploy.js
```

---

## 📝 Notes

- **FastBull Scraper**: Tidak resmi (best-effort HTML parsing). Kalau layout berubah, perlu disesuaikan.
- **Whale Detection**: Threshold $50K configurable di `whale-alert.js` (line THRESHOLDS)
- **Signal Aggregator**: Weights bisa disesuaikan di `signal-aggregator.js` (line `weight: 0.35`)
- **Cache TTL**: Configurable per modul (default 5 min untuk news/calendar, 30 sec untuk signal)

---

## 🎯 Next Steps (Opsional)

1. **WebSocket Order Flow**: Integrate real-time order flow dari exchange lain (Kraken, Bybit)
2. **ML Signal**: Train model untuk predict signal accuracy
3. **Alert Subscription**: User bisa subscribe ke whale alerts tertentu
4. **Database**: Store signals + performance untuk backtesting
5. **Dashboard**: Web dashboard untuk visualisasi real-time

---

## 📚 Dokumentasi Module

### tape-delta.js
- `start()` / `stop()` - start/stop WebSocket
- `getSnapshot(tf, lastN)` - get bar snapshot
- `getCVD(tf, lastN)` - get cumulative volume delta
- `formatTapeMessage(tf)` - format untuk Telegram
- `onBar(callback)` - subscribe ke new bars
- `onTrade(callback)` - subscribe ke trades

### whale-alert.js
- `start()` / `stop()` - start/stop monitor
- `subscribe(callback)` - subscribe ke alerts
- `getLatestAlerts(limit)` - get recent alerts
- `formatAlertMessage(alert)` - format untuk Telegram

### signal-aggregator.js
- `getCompositeSignal(tf)` - composite signal
- `getTapeDeltaSignal(tf)` - tape component
- `getOrderbookSignal()` - orderbook component
- `getWhaleSignal()` - whale component
- `getCalendarSignal()` - calendar component (WIP)
- `formatSignalMessage(signal)` - format untuk Telegram

### fastbull.js
- `start()` / `stop()` - start/stop cache warmer
- `getNews(limit)` - get cached news
- `getCalendar(hoursAhead)` - get calendar events
- `refreshNews(limit)` - force refresh
- `refreshCalendar(hoursAhead)` - force refresh
- `formatNewsMessage(items)` - format untuk Telegram
- `formatCalendarMessage(items)` - format untuk Telegram

### utils.js
- `SimpleCache` - LRU cache dengan TTL
- `RateLimiter` - token bucket rate limiter
- `Logger` - structured logging dengan level
- `BatchProcessor` - batch async processing
- `retryWithBackoff()` - exponential backoff retry
- `GracefulShutdown` - handle SIGTERM/SIGINT

---

Enjoy! 🎉
