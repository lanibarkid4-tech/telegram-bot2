// ======================================================
//  📊 ICT/SMC STRUCTURE DETECTOR
// ======================================================
//  Mendeteksi struktur Smart Money Concepts / ICT:
//    - Order Block (OB)         : area institusi entry
//    - Fair Value Gap (FVG)     : imbalance area
//    - Inverted FVG (IFVG)      : FVG yang sudah invalid jadi support/resistance
//    - Breaker Block            : OB yang sudah broken jadi reversal zone
//    - CISD (Change in State of Delivery) : shift momentum
//    - Mitigation Block         : area yang sudah terisi (ter-absorb)
//    - Premium/Discount Zone    : 50% equilibrium
//    - Liquidity Sweep          : stop hunt
//
//  USAGE:
//    const ict = require('./ict-structures');
//    const structures = ict.analyze(candles);
//    // Returns: { orderBlocks, fvgs, ifvgs, breakerBlocks, cisds, sweeps, premiumDiscount }
// ======================================================

const { Logger } = require('./utils');
const logger = new Logger('[ict]', 'info');

// ======================================================
//  ORDER BLOCK (OB)
// ======================================================
//  Definisi ICT klasik:
//  - Bullish OB: candle bearish terakhir sebelum impulse bullish kuat
//  - Bearish OB: candle bullish terakhir sebelum impulse bearish kuat
//  - Validasi: OB belum di-mitigate (belum ditembus close)
function detectOrderBlocks(candles, lookback = 50) {
  const obs = [];
  const data = candles.slice(-lookback);

  for (let i = 1; i < data.length - 2; i++) {
    const prev = data[i - 1];
    const curr = data[i];
    const next = data[i + 1];
    const next2 = data[i + 2];

    if (!prev || !curr || !next || !next2) continue;

    // === Bullish OB ===
    // candle bearish, diikuti impulse bullish (2 candle berikutnya strong up)
    const isBearish = curr.close < curr.open;
    const impulseUp = (next.close - next.open) > 0
      && (next2.close - next2.open) > 0
      && (next2.close > next.high - (next2.high - next2.low) * 0.3);

    // Body size minimal
    const bodySize = Math.abs(curr.close - curr.open);
    const range = curr.high - curr.low;
    const isBigBody = range > 0 && bodySize / range > 0.4;

    if (isBearish && impulseUp && isBigBody) {
      // Cek belum mitigated (close candle berikutnya tidak tembus low OB)
      const isMitigated = data.slice(i + 1).some(c => c.low < curr.low);
      if (!isMitigated) {
        obs.push({
          type: 'BULLISH_OB',
          index: i,
          time: curr.openTime,
          high: curr.high,
          low: curr.low,
          open: curr.open,
          close: curr.close,
          midpoint: (curr.high + curr.low) / 2,
          mitigated: false,
          strength: Math.abs(next2.close - curr.low) / curr.low * 100,
          impulsePct: ((next2.close - next.open) / next.open) * 100,
        });
      }
    }

    // === Bearish OB ===
    const isBullish = curr.close > curr.open;
    const impulseDown = (next.open - next.close) > 0
      && (next2.open - next2.close) > 0
      && (next2.close < next2.low + (next2.high - next2.low) * 0.3);

    if (isBullish && impulseDown && isBigBody) {
      const isMitigated = data.slice(i + 1).some(c => c.high > curr.high);
      if (!isMitigated) {
        obs.push({
          type: 'BEARISH_OB',
          index: i,
          time: curr.openTime,
          high: curr.high,
          low: curr.low,
          open: curr.open,
          close: curr.close,
          midpoint: (curr.high + curr.low) / 2,
          mitigated: false,
          strength: Math.abs(curr.high - next2.close) / curr.high * 100,
          impulsePct: ((next.open - next2.close) / next.open) * 100,
        });
      }
    }
  }

  return obs.sort((a, b) => b.time - a.time).slice(0, 10);
}

// ======================================================
//  FAIR VALUE GAP (FVG)
// ======================================================
//  3 candle, middle candle body > gap (high candle1 < low candle3) = bullish FVG
//  Untuk bearish FVG: low candle1 > high candle3
function detectFVGs(candles, lookback = 50) {
  const fvgs = [];
  const data = candles.slice(-lookback);

  for (let i = 1; i < data.length - 1; i++) {
    const c1 = data[i - 1];
    const c2 = data[i];
    const c3 = data[i + 1];
    if (!c1 || !c2 || !c3) continue;

    // Bullish FVG: gap antara high c1 dan low c3
    if (c3.low > c1.high) {
      const gapSize = c3.low - c1.high;
      const gapPct = (gapSize / c2.close) * 100;
      // Cek belum di-fill (tidak ada candle yang close di dalam gap)
      const isFilled = data.slice(i + 1).some(c => c.low < c3.low && c.high > c1.high);
      if (!isFilled && gapPct > 0.05) { // minimal gap 0.05%
        fvgs.push({
          type: 'BULLISH_FVG',
          index: i,
          time: c2.openTime,
          high: c3.low,   // top of gap
          low: c1.high,   // bottom of gap
          midpoint: (c3.low + c1.high) / 2,
          gapPct,
          filled: false,
        });
      }
    }

    // Bearish FVG: gap antara low c1 dan high c3
    if (c1.low > c3.high) {
      const gapSize = c1.low - c3.high;
      const gapPct = (gapSize / c2.close) * 100;
      const isFilled = data.slice(i + 1).some(c => c.low < c3.high && c.high > c1.low);
      if (!isFilled && gapPct > 0.05) {
        fvgs.push({
          type: 'BEARISH_FVG',
          index: i,
          time: c2.openTime,
          high: c1.low,   // top of gap
          low: c3.high,   // bottom of gap
          midpoint: (c1.low + c3.high) / 2,
          gapPct,
          filled: false,
        });
      }
    }
  }

  return fvgs.sort((a, b) => b.time - a.time).slice(0, 10);
}

// ======================================================
//  INVERTED FVG (IFVG) — FVG yang sudah di-break jadi S/R
// ======================================================
function detectInvertedFVGs(candles, lookback = 80) {
  const ifvgs = [];
  const data = candles.slice(-lookback);

  // Cari FVG yang sudah "inverted": close tembus level FVG dari arah berlawanan
  // Bullish IFVG: harga close di bawah low FVG bullish (sebelumnya support jadi resistance)
  // Bearish IFVG: harga close di atas high FVG bearish (sebelumnya resistance jadi support)

  // Walk through candles dan track FVG history
  const fvgHistory = [];

  for (let i = 1; i < data.length - 1; i++) {
    const c1 = data[i - 1];
    const c2 = data[i];
    const c3 = data[i + 1];
    if (!c1 || !c2 || !c3) continue;

    // Detect FVG baru dan simpan
    if (c3.low > c1.high) {
      fvgHistory.push({ type: 'BULLISH_FVG', high: c3.low, low: c1.high, time: c2.openTime, inverted: false });
    }
    if (c1.low > c3.high) {
      fvgHistory.push({ type: 'BEARISH_FVG', high: c1.low, low: c3.high, time: c2.openTime, inverted: false });
    }

    // Cek apakah ada FVG yang baru ter-invert
    for (const fvg of fvgHistory) {
      if (fvg.inverted) continue;
      if (fvg.type === 'BULLISH_FVG' && data[i].close < fvg.low) {
        // Bullish FVG tertembus ke bawah → jadi Bearish IFVG (resistance)
        ifvgs.push({
          type: 'BEARISH_IFVG',
          time: fvg.time,
          high: fvg.high,
          low: fvg.low,
          midpoint: (fvg.high + fvg.low) / 2,
          originalType: 'BULLISH_FVG',
          invertedAt: data[i].closeTime,
        });
        fvg.inverted = true;
      } else if (fvg.type === 'BEARISH_FVG' && data[i].close > fvg.high) {
        ifvgs.push({
          type: 'BULLISH_IFVG',
          time: fvg.time,
          high: fvg.high,
          low: fvg.low,
          midpoint: (fvg.high + fvg.low) / 2,
          originalType: 'BEARISH_FVG',
          invertedAt: data[i].closeTime,
        });
        fvg.inverted = true;
      }
    }
  }

  return ifvgs.sort((a, b) => b.invertedAt - a.invertedAt).slice(0, 5);
}

// ======================================================
//  BREAKER BLOCK — OB yang sudah broken jadi reversal
// ======================================================
function detectBreakerBlocks(candles, obs, lookback = 80) {
  const breakers = [];
  const data = candles.slice(-lookback);

  // OB bullish yang sudah di-mitigate (close tembus low) → jadi Bearish Breaker
  // OB bearish yang sudah di-mitigate → jadi Bullish Breaker
  for (const ob of obs) {
    const obCandle = data.find(c => c.openTime === ob.time);
    if (!obCandle) continue;

    for (let i = ob.index + 1; i < data.length; i++) {
      const c = data[i];
      let broken = false;

      if (ob.type === 'BULLISH_OB' && c.close < ob.low) {
        broken = true;
        breakers.push({
          type: 'BEARISH_BREAKER',
          originalType: 'BULLISH_OB',
          high: ob.high,
          low: ob.low,
          midpoint: ob.midpoint,
          brokenAt: c.openTime,
          breakCandle: c.close,
          strength: ((ob.midpoint - c.close) / c.close) * 100,
        });
        break;
      } else if (ob.type === 'BEARISH_OB' && c.close > ob.high) {
        broken = true;
        breakers.push({
          type: 'BULLISH_BREAKER',
          originalType: 'BEARISH_OB',
          high: ob.high,
          low: ob.low,
          midpoint: ob.midpoint,
          brokenAt: c.openTime,
          breakCandle: c.close,
          strength: ((c.close - ob.midpoint) / c.close) * 100,
        });
        break;
      }

      if (broken) break;
    }
  }

  return breakers.sort((a, b) => b.brokenAt - a.brokenAt).slice(0, 5);
}

// ======================================================
//  CISD — Change in State of Delivery
// ======================================================
//  Mendeteksi perubahan delivery: candle terakhir close di atas high candle sebelumnya (bullish shift)
//  atau close di bawah low candle sebelumnya (bearish shift)
function detectCISDs(candles, lookback = 30) {
  const cisds = [];
  const data = candles.slice(-lookback);

  for (let i = 2; i < data.length; i++) {
    const prev = data[i - 2];
    const curr = data[i - 1];
    const latest = data[i];

    // Bullish CISD: latest close > curr high (setelah minimal 1 candle bearish)
    if (curr.close < curr.open && latest.close > curr.high) {
      cisds.push({
        type: 'BULLISH_CISD',
        time: latest.openTime,
        triggerCandle: curr,
        breakLevel: curr.high,
        closePrice: latest.close,
        strength: ((latest.close - curr.high) / curr.high) * 100,
      });
    }

    // Bearish CISD: latest close < curr low (setelah minimal 1 candle bullish)
    if (curr.close > curr.open && latest.close < curr.low) {
      cisds.push({
        type: 'BEARISH_CISD',
        time: latest.openTime,
        triggerCandle: curr,
        breakLevel: curr.low,
        closePrice: latest.close,
        strength: ((curr.low - latest.close) / latest.close) * 100,
      });
    }
  }

  return cisds.sort((a, b) => b.time - a.time).slice(0, 5);
}

// ======================================================
//  LIQUIDITY SWEEP — Stop hunt detection
// ======================================================
function detectLiquiditySweeps(candles, lookback = 30) {
  const sweeps = [];
  const data = candles.slice(-lookback);

  // Cari swing highs/lows di lookback window
  const swingHighs = [];
  const swingLows = [];

  for (let i = 2; i < data.length - 2; i++) {
    if (data[i].high > data[i - 1].high && data[i].high > data[i + 1].high &&
        data[i].high > data[i - 2].high && data[i].high > data[i + 2].high) {
      swingHighs.push({ time: data[i].openTime, level: data[i].high });
    }
    if (data[i].low < data[i - 1].low && data[i].low < data[i + 1].low &&
        data[i].low < data[i - 2].low && data[i].low < data[i + 2].low) {
      swingLows.push({ time: data[i].openTime, level: data[i].low });
    }
  }

  // Sweep: harga tembus level tapi close di sebaliknya (rejection)
  for (let i = 1; i < data.length; i++) {
    const c = data[i];

    // Bullish sweep: high tembus swing high, close di bawahnya
    for (const sh of swingHighs) {
      if (c.high > sh.level && c.close < sh.level && c.openTime > sh.time) {
        sweeps.push({
          type: 'BULLISH_SWEEP',  // sweep di atas = indikasi reversal ke bawah (jebakan)
          // Actually: sweep high = stop hunt di atas = sell pressure. TAPI rejection artinya reversal ke bawah.
          // Mari kita kategorikan sweep buy-side liquidity = bearish signal (smart money ambil buy stops)
          direction: 'BEARISH',
          level: sh.level,
          time: c.openTime,
          wick: c.high - sh.level,
          closeVsLevel: sh.level - c.close,
          rejected: c.close < sh.level,
        });
        break; // 1 sweep per candle cukup
      }
    }

    // Bearish sweep: low tembus swing low, close di atasnya
    for (const sl of swingLows) {
      if (c.low < sl.level && c.close > sl.level && c.openTime > sl.time) {
        sweeps.push({
          type: 'BEARISH_SWEEP',  // sweep sell-side = bullish reversal
          direction: 'BULLISH',
          level: sl.level,
          time: c.openTime,
          wick: sl.level - c.low,
          closeVsLevel: c.close - sl.level,
          rejected: c.close > sl.level,
        });
        break;
      }
    }
  }

  return sweeps.sort((a, b) => b.time - a.time).slice(0, 5);
}

// ======================================================
//  PREMIUM / DISCOUNT ZONE (50% Equilibrium)
// ======================================================
function calculatePremiumDiscount(candles, lookback = 50) {
  const data = candles.slice(-lookback);
  if (data.length === 0) return null;

  const high = Math.max(...data.map(c => c.high));
  const low = Math.min(...data.map(c => c.low));
  const equilibrium = (high + low) / 2;
  const lastClose = data[data.length - 1].close;
  const oTE_optimal_buy = low + (high - low) * 0.62;  // 62% level (optimal trade entry buy)
  const oTE_optimal_sell = low + (high - low) * 0.79;  // 79% level (optimal trade entry sell)

  const isPremium = lastClose > equilibrium;
  const distanceFromEQ = ((lastClose - equilibrium) / equilibrium) * 100;

  return {
    swingHigh: high,
    swingLow: low,
    range: high - low,
    equilibrium,
    oTE_buy: oTE_optimal_buy,
    oTE_sell: oTE_optimal_sell,
    currentPrice: lastClose,
    zone: isPremium ? 'PREMIUM' : 'DISCOUNT',
    distanceFromEQ,
    bias: isPremium ? 'BEARISH (sell di premium)' : 'BULLISH (buy di discount)',
  };
}

// ======================================================
//  TREND BIAS (Higher High Higher Low / Lower High Lower Low)
// ======================================================
function detectTrend(candles, lookback = 20) {
  const data = candles.slice(-lookback);
  if (data.length < 5) return { trend: 'UNKNOWN', strength: 0 };

  const swingHighs = [];
  const swingLows = [];

  for (let i = 2; i < data.length - 2; i++) {
    if (data[i].high > data[i - 1].high && data[i].high > data[i + 1].high &&
        data[i].high > data[i - 2].high && data[i].high > data[i + 2].high) {
      swingHighs.push(data[i].high);
    }
    if (data[i].low < data[i - 1].low && data[i].low < data[i + 1].low &&
        data[i].low < data[i - 2].low && data[i].low < data[i + 2].low) {
      swingLows.push(data[i].low);
    }
  }

  // HH/HL = uptrend, LH/LL = downtrend
  let higherHighs = 0, lowerHighs = 0;
  let higherLows = 0, lowerLows = 0;

  for (let i = 1; i < swingHighs.length; i++) {
    if (swingHighs[i] > swingHighs[i - 1]) higherHighs++;
    else lowerHighs++;
  }
  for (let i = 1; i < swingLows.length; i++) {
    if (swingLows[i] > swingLows[i - 1]) higherLows++;
    else lowerLows++;
  }

  const bullScore = higherHighs + higherLows;
  const bearScore = lowerHighs + lowerLows;

  let trend = 'NEUTRAL';
  let strength = 0;
  if (bullScore > bearScore) {
    trend = 'BULLISH';
    strength = (bullScore / Math.max(1, bullScore + bearScore)) * 100;
  } else if (bearScore > bullScore) {
    trend = 'BEARISH';
    strength = (bearScore / Math.max(1, bullScore + bearScore)) * 100;
  }

  return {
    trend,
    strength: Math.round(strength),
    higherHighs,
    higherLows,
    lowerHighs,
    lowerLows,
    lastHigh: swingHighs[swingHighs.length - 1],
    lastLow: swingLows[swingLows.length - 1],
  };
}

// ======================================================
//  MARKET STRUCTURE (BOS / MSS)
// ======================================================
function detectStructure(candles, lookback = 30) {
  const data = candles.slice(-lookback);
  if (data.length < 5) return { bos: null, mss: null };

  const trend = detectTrend(candles, lookback);

  // BOS (Break of Structure): close tembus swing high/low searah trend
  // MSS (Market Structure Shift): close tembus swing high/low BERLAWANAN trend
  let bos = null;
  let mss = null;

  const lastCandle = data[data.length - 1];
  if (trend.lastHigh && lastCandle.close > trend.lastHigh) {
    if (trend.trend === 'BULLISH') {
      bos = { type: 'BULLISH_BOS', level: trend.lastHigh, time: lastCandle.openTime };
    } else {
      mss = { type: 'BULLISH_MSS', level: trend.lastHigh, time: lastCandle.openTime, strength: ((lastCandle.close - trend.lastHigh) / trend.lastHigh) * 100 };
    }
  }
  if (trend.lastLow && lastCandle.close < trend.lastLow) {
    if (trend.trend === 'BEARISH') {
      bos = { type: 'BEARISH_BOS', level: trend.lastLow, time: lastCandle.openTime };
    } else {
      mss = { type: 'BEARISH_MSS', level: trend.lastLow, time: lastCandle.openTime, strength: ((trend.lastLow - lastCandle.close) / lastCandle.close) * 100 };
    }
  }

  return { trend, bos, mss };
}

// ======================================================
//  MAIN: analyze all ICT structures
// ======================================================
function analyze(candles, config = {}) {
  const lookback = config.lookback || 50;

  if (!candles || candles.length < 10) {
    return {
      error: 'Insufficient candle data (need at least 10 candles)',
      orderBlocks: [],
      fvgs: [],
      ifvgs: [],
      breakerBlocks: [],
      cisds: [],
      sweeps: [],
      premiumDiscount: null,
      structure: null,
      trend: null,
    };
  }

  const orderBlocks = detectOrderBlocks(candles, lookback);
  const fvgs = detectFVGs(candles, lookback);
  const ifvgs = detectInvertedFVGs(candles, lookback * 2);
  const obsForBreaker = detectOrderBlocks(candles, lookback);
  const breakerBlocks = detectBreakerBlocks(candles, obsForBreaker, lookback * 2);
  const cisds = detectCISDs(candles, lookback);
  const sweeps = detectLiquiditySweeps(candles, lookback);
  const premiumDiscount = calculatePremiumDiscount(candles, lookback);
  const structure = detectStructure(candles, lookback);
  const trend = structure.trend;

  return {
    timestamp: Date.now(),
    lastPrice: candles[candles.length - 1].close,
    orderBlocks,
    fvgs,
    ifvgs,
    breakerBlocks,
    cisds,
    sweeps,
    premiumDiscount,
    structure,
    trend,
  };
}

module.exports = {
  analyze,
  detectOrderBlocks,
  detectFVGs,
  detectInvertedFVGs,
  detectBreakerBlocks,
  detectCISDs,
  detectLiquiditySweeps,
  calculatePremiumDiscount,
  detectTrend,
  detectStructure,
};