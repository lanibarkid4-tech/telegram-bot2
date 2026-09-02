// ======================================================
//  ⚙️ CACHING & RATE-LIMITER UTILITY
// ======================================================
//  Untuk maksimalkan bot:
//    1. Cache layer untuk API calls (reduce cost + latency)
//    2. Rate limiter per endpoint (avoid throttle/ban)
//    3. Memory-efficient storage (max N items per cache key)
//
//  USAGE:
//    const cache = new SimpleCache(300); // 5 min TTL
//    cache.set('key', data);
//    const data = cache.get('key');
//
//    const limiter = new RateLimiter({ '/order': 2, '/trade': 5 }, 60); // max 2 /order per 60s
//    limiter.checkLimit('/order') -> true/false
// ======================================================

class SimpleCache {
  constructor(ttlSeconds = 300, maxItems = 100) {
    this.ttlSeconds = ttlSeconds;
    this.maxItems = maxItems;
    this.cache = new Map();
    this.timestamps = new Map();
  }

  set(key, value) {
    // Evict oldest item kalau sudah maxItems
    if (this.cache.size >= this.maxItems && !this.cache.has(key)) {
      let oldest = null;
      let oldestTime = Infinity;
      for (const [k, ts] of this.timestamps) {
        if (ts < oldestTime) {
          oldestTime = ts;
          oldest = k;
        }
      }
      if (oldest) {
        this.cache.delete(oldest);
        this.timestamps.delete(oldest);
      }
    }

    this.cache.set(key, value);
    this.timestamps.set(key, Date.now());
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    const ts = this.timestamps.get(key);
    if (Date.now() - ts > this.ttlSeconds * 1000) {
      this.cache.delete(key);
      this.timestamps.delete(key);
      return null;
    }
    return this.cache.get(key);
  }

  delete(key) {
    this.cache.delete(key);
    this.timestamps.delete(key);
  }

  clear() {
    this.cache.clear();
    this.timestamps.clear();
  }

  size() {
    return this.cache.size;
  }
}

class RateLimiter {
  // limitsPerSecond = { '/order': 2, '/trade': 5 }
  // timeWindowSeconds = 60
  constructor(limitsPerSecond = {}, timeWindowSeconds = 60) {
    this.limits = limitsPerSecond;
    this.windowSeconds = timeWindowSeconds;
    this.requests = new Map(); // key -> [ts1, ts2, ts3, ...]
  }

  checkLimit(key) {
    const limit = this.limits[key];
    if (!limit) return true; // unlimited

    const now = Date.now();
    const windowStart = now - this.windowSeconds * 1000;

    if (!this.requests.has(key)) {
      this.requests.set(key, []);
    }

    const times = this.requests.get(key);
    // Remove old timestamps outside window
    const filtered = times.filter(t => t > windowStart);
    this.requests.set(key, filtered);

    if (filtered.length < limit) {
      filtered.push(now);
      return true;
    }
    return false;
  }

  getRemainingCalls(key) {
    const limit = this.limits[key];
    if (!limit) return Infinity;

    const now = Date.now();
    const windowStart = now - this.windowSeconds * 1000;
    const times = this.requests.get(key) || [];
    const filtered = times.filter(t => t > windowStart);
    return Math.max(0, limit - filtered.length);
  }

  reset(key) {
    this.requests.delete(key);
  }

  resetAll() {
    this.requests.clear();
  }
}

// ======================================================
//  LOGGER DENGAN LEVEL & TIMESTAMP
// ======================================================
class Logger {
  constructor(prefix = '[bot]', level = 'info') {
    this.prefix = prefix;
    this.level = level; // 'debug' | 'info' | 'warn' | 'error'
    this.levels = { debug: 0, info: 1, warn: 2, error: 3 };
  }

  _log(lvl, msg, data) {
    if (this.levels[lvl] < this.levels[this.level]) return;
    const ts = new Date().toISOString().substr(11, 12);
    const icon = { debug: '🔍', info: 'ℹ️ ', warn: '⚠️ ', error: '❌' }[lvl] || '';
    const line = `${icon} [${ts}] ${this.prefix} ${msg}`;
    if (data) {
      console.log(line, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    } else {
      console.log(line);
    }
  }

  debug(msg, data) { this._log('debug', msg, data); }
  info(msg, data) { this._log('info', msg, data); }
  warn(msg, data) { this._log('warn', msg, data); }
  error(msg, data) { this._log('error', msg, data); }
}

// ======================================================
//  BATCH PROCESSOR (untuk delay-batch request)
// ======================================================
class BatchProcessor {
  constructor(batchSize = 5, delayMs = 100) {
    this.batchSize = batchSize;
    this.delayMs = delayMs;
    this.queue = [];
    this.processing = false;
  }

  add(item) {
    return new Promise((resolve, reject) => {
      this.queue.push({ item, resolve, reject });
      this.processIfReady();
    });
  }

  processIfReady() {
    if (this.processing || this.queue.length < this.batchSize) return;

    this.processing = true;
    const batch = this.queue.splice(0, this.batchSize);

    setImmediate(async () => {
      for (const { item, resolve, reject } of batch) {
        try {
          const result = await item();
          resolve(result);
        } catch (e) {
          reject(e);
        }
      }
      this.processing = false;

      if (this.queue.length >= this.batchSize) {
        setTimeout(() => this.processIfReady(), this.delayMs);
      }
    });
  }
}

// ======================================================
//  EXPONENTIAL BACKOFF RETRY
// ======================================================
async function retryWithBackoff(fn, maxRetries = 3, baseDelayMs = 500) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (i < maxRetries - 1) {
        const delayMs = baseDelayMs * Math.pow(2, i) + Math.random() * 100;
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
}

// ======================================================
//  GRACEFUL SHUTDOWN
// ======================================================
class GracefulShutdown {
  constructor() {
    this.handlers = [];
  }

  register(name, handler) {
    this.handlers.push({ name, handler });
  }

  async shutdown(signal) {
    console.log(`\n\n🛑 Received ${signal}, graceful shutdown...`);
    for (const { name, handler } of this.handlers) {
      try {
        console.log(`  ⏳ Shutting down: ${name}...`);
        await handler();
        console.log(`  ✅ ${name} closed`);
      } catch (e) {
        console.error(`  ❌ ${name} failed: ${e.message}`);
      }
    }
    console.log('👋 Goodbye!');
    process.exit(0);
  }

  init() {
    const handler = (signal) => this.shutdown(signal);
    process.on('SIGTERM', () => handler('SIGTERM'));
    process.on('SIGINT', () => handler('SIGINT'));
  }
}

module.exports = {
  SimpleCache,
  RateLimiter,
  Logger,
  BatchProcessor,
  retryWithBackoff,
  GracefulShutdown,
};
