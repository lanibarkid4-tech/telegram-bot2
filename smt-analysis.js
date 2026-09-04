// ======================================================
//  🔗 SMT ANALYSIS — Smart Money Tool correlation
// ======================================================
//  SMT (Smart Money Tool) divergence:
//    - Harga pair A naik, pair B turun → bearish SMT (satu pair lebih lemah)
//    - Harga pair A turun, pair B naik → bullish SMT
//    - Digunakan untuk konfirmasi direction + deteksi hidden divergence
//
//  Implementasi:
//    - Compare high/low antar correlated pairs dalam window waktu sama
//    - Hitung correlation strength
//    - Detect divergence (satu pair bikin higher high, pair lain lower high)
//
//  Plus: Pair dengan DXY (US Dollar Index) untuk akurasi gold analysis.
//    - Gold berkorelasi negatif dengan DXY (DXY naik → gold turun)
//    - Divergence: gold naik tapi DXY juga naik = bearish (salah satu harus weak)
//
//  USAGE:
//    const smt = require('./smt-analysis');
//    const result = await smt.analyzeWithDXY('xauusd', '15m');
//    // Returns: { primary, dxy, correlation, divergence, recommendation }
// ======================================================

const candles = require('./candles');
const { SimpleCache, Logger } = require('./utils');

const logger = new Logger('[smt]', 'info');

const cache = new SimpleCache(120, 30);

// ======================================================
//  CORRELATION MAP
//  Setiap pair punya pair korelasi + DXY
// ======================================================
const CORRELATIONS = {
  xauusd: {
    dxy: { pair: 'dxy', strength: 'STRONG', expected: 'NEGATIVE' },     // Gold vs DXY selalu berlawanan
    correlated: [
      { pair: 'xagusd', strength: 'STRONG', expected: 'POSITIVE' },     // Gold & Silver searah
      { pair: 'btcusd', strength: 'MEDIUM', expected: 'POSITIVE' },    // BTC sometimes correlated
      { pair: 'nasdaq', strength: 'WEAK', expected: 'POSITIVE' },       // Risk-on: gold turun, NASDAQ naik
    ],
    dxyDivergence: 'BULLISH_GOLD',  // Kalau DXY diverge dari gold
  },
  nasdaq: {
    dxy: { pair: 'dxy', strength: 'STRONG', expected: 'NEGATIVE' },
    correlated: [
      { pair: 'spx', strength: 'STRONG', expected: 'POSITIVE' },       // NASDAQ & SPX searah
      { pair: 'btcusd', strength: 'MEDIUM', expected: 'POSITIVE' },    // Risk-on
    ],
    dxyDivergence: 'BULLISH_NASDAQ',
  },
  btcusd: {
    dxy: { pair: 'dxy', strength: 'MEDIUM', expected: 'NEGATIVE' },
    correlated: [
      { pair: 'ethusd', strength: 'STRONG', expected: 'POSITIVE' },
      { pair: 'nasdaq', strength: 'MEDIUM', expected: 'POSITIVE' },
    ],
    dxyDivergence: 'BULLISH_BTC',
  },
  eurusd: {
    dxy: { pair: 'dxy', strength: 'STRONG', expected: 'NEGATIVE' },
    correlated: [
      { pair: 'gbpjpy', strength: 'MEDIUM', expected: 'NEGATIVE' },
    ],
    dxyDivergence: 'BULLISH_EUR',
  },
  gbpjpy: {
    dxy: { pair: 'dxy', strength: 'MEDIUM', expected: 'MIXED' },
    correlated: [
      { pair: 'usdjpy', strength: 'STRONG', expected: 'POSITIVE' },
    ],
    dxyDivergence: 'MIXED',
  },
};

// ======================================================
//  ALIGN CANDLES BY TIMESTAMP
// ======================================================
function alignCandles(primaryData, secondaryData, windowCandles = 20) {
  // Ambil window candle terakhir dari masing-masing, align by openTime
  const pSlice = primaryData.slice(-windowCandles);
  const sSlice = secondaryData.slice(-windowCandles);

  const aligned = [];
  for (const p of pSlice) {
    // Cari candle di secondary dengan timestamp <= p.openTime yang paling dekat
    const sCandle = sSlice.find(s => Math.abs(s.openTime - p.openTime) < 5 * 60 * 1000);
    if (sCandle) {
      aligned.push({
        time: p.openTime,
        primary: {
          open: p.open, high: p.high, low: p.low, close: p.close,
        },
        secondary: {
          open: sCandle.open, high: sCandle.high, low: sCandle.low, close: sCandle.close,
        },
      });
    }
  }
  return aligned;
}

// ======================================================
//  DETECT SMT DIVERGENCE
// ======================================================
//  Definisi:
//  - Bullish SMT: primary bikin higher high, tapi secondary gagal bikin higher high (lower high)
//                ATAU primary bikin higher low, secondary lower low
//  - Bearish SMT: kebalikannya
function detectDivergence(aligned, expected = 'POSITIVE') {
  if (aligned.length < 5) return null;

  // Cari swing highs & lows di primary
  const primaryHighs = [];
  const primaryLows = [];
  const secondaryHighs = [];
  const secondaryLows = [];

  for (let i = 2; i < aligned.length - 2; i++) {
    const a = aligned[i];

    // Swing high primary
    if (a.primary.high > aligned[i - 1].primary.high && a.primary.high > aligned[i + 1].primary.high &&
        a.primary.high > aligned[i - 2].primary.high && a.primary.high > aligned[i + 2].primary.high) {
      primaryHighs.push({ idx: i, level: a.primary.high, time: a.time });
    }
    if (a.primary.low < aligned[i - 1].primary.low && a.primary.low < aligned[i + 1].primary.low &&
        a.primary.low < aligned[i - 2].primary.low && a.primary.low < aligned[i + 2].primary.low) {
      primaryLows.push({ idx: i, level: a.primary.low, time: a.time });
    }

    // Swing secondary
    if (a.secondary.high > aligned[i - 1].secondary.high && a.secondary.high > aligned[i + 1].secondary.high) {
      secondaryHighs.push({ idx: i, level: a.secondary.high, time: a.time });
    }
    if (a.secondary.low < aligned[i - 1].secondary.low && a.secondary.low < aligned[i + 1].secondary.low) {
      secondaryLows.push({ idx: i, level: a.secondary.low, time: a.time });
    }
  }

  // Compare last 2 swing highs
  let result = null;

  if (primaryHighs.length >= 2 && secondaryHighs.length >= 2) {
    const p1 = primaryHighs[primaryHighs.length - 2].level;
    const p2 = primaryHighs[primaryHighs.length - 1].level;
    const s1 = secondaryHighs[secondaryHighs.length - 2].level;
    const s2 = secondaryHighs[secondaryHighs.length - 1].level;

    const primaryHigherHigh = p2 > p1;
    const secondaryHigherHigh = s2 > s1;

    // Jika expected positive & primary bikin HH tapi secondary tidak → bearish SMT (primary lemah)
    // Jika expected negative & primary bikin HH tapi secondary juga HH → no SMT
    if (primaryHigherHigh && !secondaryHigherHigh && expected === 'POSITIVE') {
      result = {
        type: 'BEARISH_SMT',
        description: `Primary higher high, secondary gagal higher high`,
        primaryLevel: p2,
        secondaryLevel: s2,
        strength: ((p2 - p1) / p1) * 100,
        significance: Math.abs(((s2 - s1) / s1) * 100),
      };
    } else if (!primaryHigherHigh && secondaryHigherHigh && expected === 'POSITIVE') {
      result = {
        type: 'BULLISH_SMT',
        description: `Secondary higher high (yang seharusnya searah primary)`,
        primaryLevel: p2,
        secondaryLevel: s2,
        strength: ((s2 - s1) / s1) * 100,
        significance: Math.abs(((p2 - p1) / p1) * 100),
      };
    }
  }

  // Compare last 2 swing lows
  if (!result && primaryLows.length >= 2 && secondaryLows.length >= 2) {
    const p1 = primaryLows[primaryLows.length - 2].level;
    const p2 = primaryLows[primaryLows.length - 1].level;
    const s1 = secondaryLows[secondaryLows.length - 2].level;
    const s2 = secondaryLows[secondaryLows.length - 1].level;

    const primaryLowerLow = p2 < p1;
    const secondaryLowerLow = s2 < s1;

    if (primaryLowerLow && !secondaryLowerLow && expected === 'POSITIVE') {
      result = {
        type: 'BULLISH_SMT',
        description: `Primary lower low, secondary gagal lower low (rejection)`,
        primaryLevel: p2,
        secondaryLevel: s2,
        strength: ((p1 - p2) / p2) * 100,
        significance: Math.abs(((s1 - s2) / s2) * 100),
      };
    } else if (!primaryLowerLow && secondaryLowerLow && expected === 'POSITIVE') {
      result = {
        type: 'BEARISH_SMT',
        description: `Secondary lower low (primary seharusnya ikut)`,
        primaryLevel: p2,
        secondaryLevel: s2,
        strength: ((s1 - s2) / s2) * 100,
        significance: Math.abs(((p1 - p2) / p2) * 100),
      };
    }
  }

  return result;
}

// ======================================================
//  DXY CORRELATION CHECK
// ======================================================
//  Gold/DXY = inverse. Kalau DXY turun, gold naik.
//  Kalau gold & DXY searah (gold naik, DXY naik) → DIVERGENCE = bearish untuk gold (karena DXY harusnya weak)
async function checkDXYCorrelation(primaryPair, primaryData, tf) {
  const dxyData = await candles.getCandles('dxy', tf, 50);

  const aligned = alignCandles(primaryData, dxyData, 20);

  // Calculate % change in last 5 candles
  const pChange5 = ((aligned[aligned.length - 1].primary.close - aligned[aligned.length - 5].primary.close) / aligned[aligned.length - 5].primary.close) * 100;
  const dChange5 = ((aligned[aligned.length - 1].secondary.close - aligned[aligned.length - 5].secondary.close) / aligned[aligned.length - 5].secondary.close) * 100;

  const dxyCurrent = aligned[aligned.length - 1].secondary.close;
  const dxyPrev5 = aligned[aligned.length - 5].secondary.close;
  const dxyTrend = dChange5 > 0 ? 'UP' : 'DOWN';

  // Untuk gold: idealnya inverse
  // Kalau gold UP dan DXY DOWN → aligned (correct correlation)
  // Kalau gold UP dan DXY UP → DIVERGENCE (bullish DXY = bearish gold signal)
  let divergence = null;

  if (primaryPair === 'xauusd') {
    if (pChange5 > 0 && dChange5 > 0.5) {
      divergence = {
        type: 'BEARISH_DIVERGENCE',
        description: 'Gold NAIK tapi DXY juga NAIK (harusnya DXY turun)',
        implication: 'Gold berpotensi reversal bearish karena DXY bullish',
        severity: Math.min(100, Math.abs(dChange5) * 20),
      };
    } else if (pChange5 < 0 && dChange5 < -0.5) {
      divergence = {
        type: 'BULLISH_DIVERGENCE',
        description: 'Gold TURUN tapi DXY juga TURUN (harusnya DXY naik)',
        implication: 'Gold berpotensi reversal bullish karena DXY bearish',
        severity: Math.min(100, Math.abs(dChange5) * 20),
      };
    }
  }

  // Correlation strength (-1 = inverse, +1 = aligned, 0 = no correlation)
  // Simple Pearson-like calculation
  const n = Math.min(aligned.length, 10);
  const pCloses = aligned.slice(-n).map(a => a.primary.close);
  const dCloses = aligned.slice(-n).map(a => a.secondary.close);

  const pMean = pCloses.reduce((s, v) => s + v, 0) / n;
  const dMean = dCloses.reduce((s, v) => s + v, 0) / n;
  let num = 0, pDen = 0, dDen = 0;
  for (let i = 0; i < n; i++) {
    const pd = pCloses[i] - pMean;
    const dd = dCloses[i] - dMean;
    num += pd * dd;
    pDen += pd * pd;
    dDen += dd * dd;
  }
  const correlation = pDen > 0 && dDen > 0 ? num / Math.sqrt(pDen * dDen) : 0;

  return {
    dxyCurrent,
    dxyTrend,
    dxyChange5: dChange5,
    primaryChange5: pChange5,
    correlation: Math.round(correlation * 100) / 100,
    divergence,
    aligned: aligned.slice(-10),
  };
}

// ======================================================
//  MAIN: analyzeWithDXY
// ======================================================
async function analyzeWithDXY(primaryPair, timeframe = '15m') {
  const cacheKey = `smt_${primaryPair}_${timeframe}_${Math.floor(Date.now() / 120000)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const primaryData = await candles.getCandles(primaryPair, timeframe, 200);
    const dxyAnalysis = await checkDXYCorrelation(primaryPair, primaryData, timeframe);

    // SMT dengan correlated pairs
    const correlationMap = CORRELATIONS[primaryPair] || { correlated: [], dxy: null };
    const smtResults = [];

    if (correlationMap.correlated) {
      for (const corr of correlationMap.correlated) {
        try {
          const secondaryData = await candles.getCandles(corr.pair, timeframe, 200);
          const aligned = alignCandles(primaryData, secondaryData, 20);
          const divergence = detectDivergence(aligned, corr.expected);
          if (divergence) {
            smtResults.push({
              ...divergence,
              correlatedPair: corr.pair,
              expected: corr.expected,
              pairStrength: corr.strength,
            });
          }
        } catch (e) {
          logger.warn(`SMT check ${primaryPair} vs ${corr.pair} failed: ${e.message}`);
        }
      }
    }

    // Recommendation: gabungkan SMT + DXY
    let recommendation = 'NEUTRAL';
    let confidence = 50;

    const dxyDiv = dxyAnalysis.divergence;
    const smtBullish = smtResults.some(r => r.type === 'BULLISH_SMT');
    const smtBearish = smtResults.some(r => r.type === 'BEARISH_SMT');

    if (dxyDiv?.type === 'BEARISH_DIVERGENCE' || smtBearish) {
      recommendation = 'SELL';
      confidence = 65 + (dxyDiv?.severity ? dxyDiv.severity * 0.3 : 0);
    } else if (dxyDiv?.type === 'BULLISH_DIVERGENCE' || smtBullish) {
      recommendation = 'BUY';
      confidence = 65 + (dxyDiv?.severity ? dxyDiv.severity * 0.3 : 0);
    } else if (dxyAnalysis.dxyTrend === 'DOWN' && primaryPair === 'xauusd') {
      recommendation = 'BUY';
      confidence = 60;  // Gold bias bullish kalau DXY turun
    } else if (dxyAnalysis.dxyTrend === 'UP' && primaryPair === 'xauusd') {
      recommendation = 'SELL';
      confidence = 55;
    }

    const result = {
      primaryPair,
      primaryPrice: primaryData[primaryData.length - 1].close,
      timeframe,
      dxy: dxyAnalysis,
      smtDivergences: smtResults,
      recommendation,
      confidence: Math.min(100, Math.round(confidence)),
    };

    cache.set(cacheKey, result);
    return result;
  } catch (e) {
    logger.error(`analyzeWithDXY error: ${e.message}`);
    throw e;
  }
}

module.exports = {
  analyzeWithDXY,
  alignCandles,
  detectDivergence,
  checkDXYCorrelation,
  CORRELATIONS,
};