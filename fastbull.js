// ======================================================
//  📰 MODULE FASTBULL - News & Economic Calendar Scraper
// ======================================================
//  FastBull (fastbull.com) adalah portal trading populer yang menyediakan:
//    - Real-time news (forex, crypto, commodities, stocks)
//    - Economic calendar (NFP, CPI, FOMC, dll)
//    - Live signals & market analysis
//
//  CATATAN PENTING:
//    - FastBull TIDAK menyediakan public API resmi.
//    - Module ini melakukan HTML scraping ringan dari halaman public.
//    - Hasil scraping bisa berubah sewaktu-waktu jika FastBull update layout.
//    - Untuk penggunaan serius, pertimbangkan API resmi seperti:
//      ForexFactory (scraping), Investing.com, atau Finnhub/Polygon.
//    - DILARANG SCRAPE BERULANG KALI! Default cache 5 menit.
//
//  CARA PAKAI:
//    const fastbull = require('./fastbull');
//    await fastbull.start();              // start cache warmer
//    const news = await fastbull.getNews(10);
//    const cal  = await fastbull.getCalendar(24); // next 24h events
// ======================================================

const https = require('https');

// ======================================================
//  CONFIG
// ======================================================
const CACHE_TTL_MS = 5 * 60 * 1000;   // 5 menit
const REQUEST_TIMEOUT_MS = 15000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Cache
let newsCache = { data: [], ts: 0 };
let calendarCache = { data: [], ts: 0 };
let isWarming = false;

// ======================================================
//  HTTP HELPER
// ======================================================
function fetch(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // redirect
        return fetch(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

// ======================================================
//  HTML PARSERS (best-effort, fallback ke RSS/JSON kalau ada)
// ======================================================

// FastBull kadang expose JSON di window.__INITIAL_STATE__ atau
// script tag. Kita coba ekstrak itu lebih dulu.
function extractJsonState(html) {
  const patterns = [
    /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/,
    /window\.__NUXT__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/,
    /window\.__NEXT_DATA__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      try { return JSON.parse(m[1]); } catch (e) { /* ignore */ }
    }
  }
  return null;
}

// Parser dari HTML mentah: cari tag <a> dengan judul berita
function parseNewsFromHtml(html, limit = 10) {
  const items = [];

  // Pola: <a ... class="news-item ..." href="..."> ... <h3>title</h3> ... <span>time</span> </a>
  // FastBull sering pakai class "live-list__item" atau "news-item"
  const itemRegex = /<a[^>]+href="(\/[^"]*?(?:news|live|article)[^"]*?)"[^>]*>([\s\S]*?)<\/a>/gi;

  let m;
  let count = 0;
  while ((m = itemRegex.exec(html)) !== null && count < limit * 3) {
    const href = m[1];
    const block = m[2];

    // Title
    const titleMatch = block.match(/<h\d[^>]*>([\s\S]*?)<\/h\d>/i)
                    || block.match(/class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\//i)
                    || block.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\//i);
    if (!titleMatch) continue;

    const title = stripTags(titleMatch[1]).trim();
    if (title.length < 8) continue;

    // Time
    const timeMatch = block.match(/<span[^>]*class="[^"]*time[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
                   || block.match(/(\d{1,2}:\d{2})/);
    const time = timeMatch ? stripTags(timeMatch[1]).trim() : '';

    // Image
    const imgMatch = block.match(/<img[^>]+data-src="([^"]+)"/i)
                  || block.match(/<img[^>]+src="([^"]+)"/i);
    const img = imgMatch ? imgMatch[1] : null;

    items.push({
      title,
      url: href.startsWith('http') ? href : `https://fastbull.com${href}`,
      time,
      image: img,
    });
    count++;
  }
  return items.slice(0, limit);
}

function parseCalendarFromHtml(html, hoursAhead = 24) {
  const items = [];
  const now = Date.now();
  const cutoff = now + hoursAhead * 3600 * 1000;

  // FastBull calendar biasanya render sebagai <tr> dengan kolom: time, currency, event, importance, actual, forecast, previous
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRegex.exec(html)) !== null) {
    const row = m[1];
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => stripTags(c[1]).trim());
    if (cells.length < 4) continue;

    // Filter: harus ada jam + currency (3 huruf besar) + event
    const time = cells[0] || '';
    const currency = (cells[1] || '').toUpperCase();
    const event = cells[2] || '';
    if (!currency.match(/^[A-Z]{3}$/) || event.length < 4) continue;

    // Importance: biasanya di cells[3] (bintang ★) atau class
    const importance = (row.match(/class="[^"]*(?:high|red|important)[^"]*"/i) ? 'HIGH' : 'NORMAL');

    items.push({
      time, currency, event, importance,
      actual: cells[4] || '',
      forecast: cells[5] || '',
      previous: cells[6] || '',
    });
  }
  return items.slice(0, 30);
}

function stripTags(s) {
  return (s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

// ======================================================
//  PUBLIC API - NEWS
// ======================================================
async function getNews(limit = 10) {
  // Cache check
  if (newsCache.data.length && Date.now() - newsCache.ts < CACHE_TTL_MS) {
    return newsCache.data.slice(0, limit);
  }
  return refreshNews(limit);
}

async function refreshNews(limit = 10) {
  const urls = [
    'https://fastbull.com/news',
    'https://fastbull.com/',
    'https://www.fastbull.com/news',
  ];

  for (const url of urls) {
    try {
      const html = await fetch(url);

      // 1) Coba parse JSON state dulu
      const state = extractJsonState(html);
      let items = [];

      if (state) {
        // Cari array yang berisi title + url (best-effort)
        const findIn = (obj, depth = 0) => {
          if (depth > 4 || !obj) return [];
          if (Array.isArray(obj)) {
            return obj.filter(x => x && x.title && (x.url || x.link)).map(x => ({
              title: x.title,
              url: x.url || x.link,
              time: x.time || x.publishTime || '',
              image: x.image || x.cover || null,
            }));
          }
          if (typeof obj === 'object') {
            for (const v of Object.values(obj)) {
              const r = findIn(v, depth + 1);
              if (r.length) return r;
            }
          }
          return [];
        };
        items = findIn(state);
      }

      // 2) Fallback: parse HTML
      if (!items.length) {
        items = parseNewsFromHtml(html, limit);
      }

      if (items.length) {
        newsCache = { data: items, ts: Date.now() };
        console.log(`📰 [fastbull] cached ${items.length} news items`);
        return items.slice(0, limit);
      }
    } catch (e) {
      console.warn(`⚠️  [fastbull] news fetch failed (${url}): ${e.message}`);
    }
  }

  // Gagal total - return cache lama kalau ada
  return newsCache.data.slice(0, limit);
}

// ======================================================
//  PUBLIC API - CALENDAR
// ======================================================
async function getCalendar(hoursAhead = 24) {
  if (calendarCache.data.length && Date.now() - calendarCache.ts < CACHE_TTL_MS) {
    return calendarCache.data;
  }
  return refreshCalendar(hoursAhead);
}

async function refreshCalendar(hoursAhead = 24) {
  const urls = [
    'https://fastbull.com/calendar',
    'https://www.fastbull.com/calendar',
  ];

  for (const url of urls) {
    try {
      const html = await fetch(url);
      const state = extractJsonState(html);
      let items = [];

      if (state) {
        const findIn = (obj, depth = 0) => {
          if (depth > 5 || !obj) return [];
          if (Array.isArray(obj)) {
            return obj.filter(x => x && (x.event || x.title) && (x.currency || x.country)).map(x => ({
              time: x.time || x.date || '',
              currency: (x.currency || x.country || '').toUpperCase(),
              event: x.event || x.title,
              importance: x.importance || (x.star >= 3 ? 'HIGH' : 'NORMAL'),
              actual: x.actual || '',
              forecast: x.forecast || '',
              previous: x.previous || '',
            }));
          }
          if (typeof obj === 'object') {
            for (const v of Object.values(obj)) {
              const r = findIn(v, depth + 1);
              if (r.length) return r;
            }
          }
          return [];
        };
        items = findIn(state);
      }

      if (!items.length) {
        items = parseCalendarFromHtml(html, hoursAhead);
      }

      if (items.length) {
        calendarCache = { data: items, ts: Date.now() };
        console.log(`📅 [fastbull] cached ${items.length} calendar events`);
        return items;
      }
    } catch (e) {
      console.warn(`⚠️  [fastbull] calendar fetch failed (${url}): ${e.message}`);
    }
  }

  return calendarCache.data;
}

// ======================================================
//  FORMATTERS (untuk Telegram)
// ======================================================
function formatNewsMessage(items, limit = 8) {
  if (!items.length) {
    return '📰 *FASTBULL NEWS*\n\n❌ Belum ada data / fetch gagal.\nCoba lagi nanti.';
  }
  let text = '📰 *FASTBULL NEWS* (top ' + Math.min(limit, items.length) + ')\n\n';
  items.slice(0, limit).forEach((n, i) => {
    const t = n.time ? ` _(${n.time})_` : '';
    text += `${i + 1}. ${n.title}${t}\n`;
    if (n.url) text += `   🔗 ${n.url}\n`;
    text += '\n';
  });
  text += `⏰ Cache: ${Math.round((Date.now() - newsCache.ts) / 1000)}s ago`;
  return text;
}

function formatCalendarMessage(items, hoursAhead = 24) {
  if (!items.length) {
    return `📅 *FASTBULL CALENDAR* (next ${hoursAhead}h)\n\n❌ Belum ada data / fetch gagal.\nCoba lagi nanti.`;
  }

  const high = items.filter(i => i.importance === 'HIGH');
  const normal = items.filter(i => i.importance !== 'HIGH');

  let text = `📅 *FASTBULL CALENDAR* (next ${hoursAhead}h)\n\n`;

  if (high.length) {
    text += `🔥 *HIGH IMPACT* (${high.length}):\n`;
    for (const e of high.slice(0, 10)) {
      text += `  • \`${e.time}\` ${e.currency} - ${e.event}\n`;
      if (e.forecast || e.previous) {
        const f = e.forecast ? `F:${e.forecast}` : '';
        const p = e.previous ? `P:${e.previous}` : '';
        const a = e.actual ? `A:${e.actual}` : '';
        const parts = [a, f, p].filter(Boolean).join(' | ');
        if (parts) text += `    _(${parts})_\n`;
      }
    }
    text += '\n';
  }

  if (normal.length) {
    text += `📌 *OTHER EVENTS* (${normal.length}):\n`;
    for (const e of normal.slice(0, 8)) {
      text += `  • \`${e.time}\` ${e.currency} - ${e.event}\n`;
    }
  }

  text += `\n⏰ Cache: ${Math.round((Date.now() - calendarCache.ts) / 1000)}s ago`;
  return text;
}

// ======================================================
//  CACHE WARMER
// ======================================================
async function start() {
  if (isWarming) return;
  isWarming = true;
  console.log('📰 [fastbull] starting cache warmer (5 min interval) ...');

  // First load
  try { await refreshNews(10); } catch (e) { console.warn('fastbull news init failed:', e.message); }
  try { await refreshCalendar(24); } catch (e) { console.warn('fastbull cal init failed:', e.message); }

  // Periodic refresh
  setInterval(async () => {
    try { await refreshNews(10); } catch (e) { /* silent */ }
    try { await refreshCalendar(24); } catch (e) { /* silent */ }
  }, CACHE_TTL_MS);
}

function stop() {
  isWarming = false;
}

module.exports = {
  start, stop,
  getNews, getCalendar,
  refreshNews, refreshCalendar,
  formatNewsMessage, formatCalendarMessage,
  CACHE_TTL_MS,
};
