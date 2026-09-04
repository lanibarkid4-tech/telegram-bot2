// ======================================================
//  📰 MODULE ANALISA FUNDAMENTAL (Finnhub only)
// ======================================================
//  Menghitung currency strength dari pergerakan pair forex
//  utama (EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CAD,
//  USD/CHF, NZD/USD) menggunakan candle D1 dari Finnhub.
//
//  Komponen:
//  - Currency strength (% perubahan relatif antar pair)
//  - DXY proxy (inverse EUR/USD)
//  - Market regime detection (trending / ranging)
//  - Volatility score
//
//  Semua berbasis data harga real, bukan asumsi.
// ======================================================

const candles = require('./candles');
const { SimpleCache } = require('./utils');

const strengthCache = new SimpleCache(3600, 5); // 1 jam

// Daftar pair untuk hitung currency strength
const CCY_PAIRS = [
  { pair: 'EUR/USD', base: 'EUR', quote: 'USD' },
  { pair: 'GBP/USD', base: 'GBP', quote: 'USD' },
  { pair: 'USD/JPY', base: 'USD', quote: 'JPY' },
  { pair: 'AUD/USD', base: 'AUD', quote: 'USD' },
  { pair: 'USD/CAD', base: 'USD', quote: 'CAD' },
  { pair: 'USD/CHF', base: 'USD', quote: 'CHF' },
  { pair: 'NZD/USD', base: 'NZD', quote: 'USD' },
];

// Hitung kekuatan mata uang berdasarkan perubahan D1 (14 candle terakhir)
async function getCurrencyStrength() {
  const cached = strengthCache.get('ccy_strength');
  if (cached) return cached;

  const strength = {
    USD: 0, EUR: 0, GBP: 0, JPY: 0, CHF: 0, AUD: 0, CAD: 0, NZD: 0
  };

  for (const { pair, base, quote } of CCY_PAIRS) {
    try {
      const data = await candles.getCandles(pair, '1day', 14);
      if (data.length < 2) continue;
      const first = data[0].close;
      const last = data[data.length - 1].close;
      const pct = ((last - first) / first) * 100;
      // pair naik = base menguat (relatif thd quote)
      strength[base] += pct;
      strength[quote] -= pct;
    } catch (e) {
      // Skip pair yang gagal, lanjut ke berikutnya
      continue;
    }
    // jeda agar tidak kena rate limit
    await new Promise(r => setTimeout(r, 200));
  }

  strengthCache.set('ccy_strength', strength);
  return strength;
}

// Tentukan market regime (trending atau ranging)
// Berdasarkan perbandingan SMA 7 vs SMA 21 dan range harga
function determineRegime(prices) {
  if (!prices || prices.length < 21) return 'UNKNOWN';

  const sma7 = prices.slice(-7).reduce((a, b) => a + b, 0) / 7;
  const sma21 = prices.slice(-21).reduce((a, b) => a + b, 0) / 21;

  // Range = (high - low) / avg
  const recent = prices.slice(-14);
  const high = Math.max(...recent);
  const low = Math.min(...recent);
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const rangePct = ((high - low) / avg) * 100;

  const smaDiff = Math.abs(((sma7 - sma21) / sma21) * 100);

  // Trending jika SMA7 dan SMA21 cukup berbeda DAN range cukup besar
  if (smaDiff > 0.5 && rangePct > 1.5) {
    return sma7 > sma21 ? 'TRENDING_UP' : 'TRENDING_DOWN';
  }
  // Ranging jika SMA berdekatan dan range sempit
  if (smaDiff < 0.3 || rangePct < 1.0) {
    return 'RANGING';
  }
  return 'TRANSITION';
}

// Hitung volatility (deviasi standar dari perubahan harian)
function calculateVolatility(prices) {
  if (!prices || prices.length < 5) return { value: 0, level: 'UNKNOWN' };

  const changes = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(((prices[i] - prices[i-1]) / prices[i-1]) * 100);
  }

  const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
  const variance = changes.reduce((a, b) => a + (b - mean) ** 2, 0) / changes.length;
  const stdDev = Math.sqrt(variance);

  // Annualized volatility (approx)
  const annualized = stdDev * Math.sqrt(252);

  let level = 'LOW';
  if (annualized > 25) level = 'HIGH';
  else if (annualized > 12) level = 'MEDIUM';

  return { value: stdDev, annualized, level };
}

// Mapping pair ke currency strength-nya
function getPairCurrencyStrength(pair, strength) {
  if (!strength) return { base: 0, quote: 0 };

  const sym = (pair.symbol || '').toUpperCase();

  // Commodity / index → proxy USD inverse
  if (sym === 'XAU/USD' || sym === 'XAUUSD') {
    return { base: 0, quote: -strength.USD * 0.7 };
  }
  if (['NDX', 'NASDAQ', 'SPX', 'DJI'].includes(sym)) {
    return { base: -strength.USD * 0.5, quote: 0 };
  }

  // Crypto major (BTC, ETH) → proxy risk-on
  if (sym.includes('BTC') || sym.includes('ETH')) {
    return { base: -strength.USD * 0.5, quote: 0 };
  }

  // Forex pair biasa (EURUSD, USDJPY, dll)
  return {
    base: strength[pair.base] || 0,
    quote: strength[pair.quote] || 0
  };
}

// Analisa fundamental lengkap untuk satu pair
async function analyzeFundamental(pair, prices) {
  let strength = null;
  try {
    strength = await getCurrencyStrength();
  } catch (err) {
    console.error('Currency strength error:', err.message);
  }

  const regime = determineRegime(prices);
  const volatility = calculateVolatility(prices);

  // Kalau strength null, gunakan default netral
  const pairStrength = strength
    ? getPairCurrencyStrength(pair, strength)
    : { base: 0, quote: 0 };

  // Fundamental bias (pair base menguat + quote melemah = BUY favorable)
  const fundamentalBias = pairStrength.base - pairStrength.quote;

  let bias = 'NEUTRAL';
  if (fundamentalBias > 0.3) bias = 'BULLISH';
  else if (fundamentalBias < -0.3) bias = 'BEARISH';

  return {
    strength: strength || {},
    pairStrength,
    fundamentalBias: fundamentalBias.toFixed(2),
    bias,
    regime,
    volatility
  };
}

module.exports = {
  getCurrencyStrength,
  determineRegime,
  calculateVolatility,
  getPairCurrencyStrength,
  analyzeFundamental
};
