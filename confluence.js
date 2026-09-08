// ======================================================
//  MULTI-METHOD TECHNICAL CONFLUENCE
//  Candle-derived methods only. No claims of true footprint,
//  exchange volume, or macro correlation without those feeds.
// ======================================================

function finite(value) {
  return Number.isFinite(Number(value));
}

function average(values) {
  const valid = values.filter(finite).map(Number);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function ema(candles, period) {
  if (!candles || candles.length < period) return null;
  const k = 2 / (period + 1);
  let value = Number(candles[0].close);
  for (let i = 1; i < candles.length; i++) value = Number(candles[i].close) * k + value * (1 - k);
  return value;
}

function emaSeries(candles, period) {
  if (!candles || candles.length < period) return [];
  const values = candles.map(c => Number(c.close));
  const result = Array(period - 1).fill(null);
  let value = average(values.slice(0, period));
  result.push(value);
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    value = values[i] * k + value * (1 - k);
    result.push(value);
  }
  return result;
}

function sma(candles, period) {
  if (!candles || candles.length < period) return null;
  return average(candles.slice(-period).map(c => Number(c.close)));
}

function wma(candles, period) {
  if (!candles || candles.length < period) return null;
  const values = candles.slice(-period).map(c => Number(c.close));
  const denominator = period * (period + 1) / 2;
  return values.reduce((sum, value, index) => sum + value * (index + 1), 0) / denominator;
}

function rma(candles, period) {
  if (!candles || candles.length < period) return null;
  const values = candles.map(c => Number(c.close));
  let result = average(values.slice(0, period));
  for (let i = period; i < values.length; i++) result = (result * (period - 1) + values[i]) / period;
  return result;
}

function hma(candles, period = 20) {
  if (!candles || candles.length < period) return null;
  const half = Math.max(2, Math.floor(period / 2));
  const full = wma(candles, period);
  const halfValue = wma(candles, half);
  if (full === null || halfValue === null) return null;
  return 2 * halfValue - full;
}

function dema(candles, period = 21) {
  const firstSeries = emaSeries(candles, period).filter(finite).map(close => ({ close }));
  const first = firstSeries.length ? firstSeries[firstSeries.length - 1].close : null;
  const second = ema(firstSeries, period);
  return first === null || second === null ? null : 2 * first - second;
}

function tema(candles, period = 21) {
  const firstSeries = emaSeries(candles, period).filter(finite).map(close => ({ close }));
  const first = firstSeries.length ? firstSeries[firstSeries.length - 1].close : null;
  const secondSeries = emaSeries(firstSeries, period).filter(finite).map(close => ({ close }));
  const second = secondSeries.length ? secondSeries[secondSeries.length - 1].close : null;
  const third = ema(secondSeries, period);
  return first === null || second === null || third === null ? null : 3 * first - 3 * second + third;
}

function vwma(candles, period = 20) {
  if (!candles || candles.length < period) return null;
  const recent = candles.slice(-period);
  const volume = recent.reduce((sum, c) => sum + (Number(c.volume) || 0), 0);
  if (!volume) return sma(candles, period);
  return recent.reduce((sum, c) => sum + Number(c.close) * (Number(c.volume) || 0), 0) / volume;
}

function kama(candles, period = 10, fast = 2, slow = 30) {
  if (!candles || candles.length < period + 1) return null;
  const values = candles.map(c => Number(c.close));
  let result = values[period - 1];
  for (let i = period; i < values.length; i++) {
    const change = Math.abs(values[i] - values[i - period]);
    let volatility = 0;
    for (let j = i - period + 1; j <= i; j++) volatility += Math.abs(values[j] - values[j - 1]);
    const efficiency = volatility ? change / volatility : 0;
    const fastSc = 2 / (fast + 1);
    const slowSc = 2 / (slow + 1);
    const smoothing = Math.pow(efficiency * (fastSc - slowSc) + slowSc, 2);
    result += smoothing * (values[i] - result);
  }
  return result;
}

function movingAverageMethods(candles) {
  const close = candles && candles.length ? Number(candles[candles.length - 1].close) : null;
  const values = {
    sma21: sma(candles, 21),
    ema21: ema(candles, 21),
    wma21: wma(candles, 21),
    rma21: rma(candles, 21),
    hma21: hma(candles, 21),
    dema21: dema(candles, 21),
    tema21: tema(candles, 21),
    vwma21: vwma(candles, 21),
    kama10: kama(candles, 10)
  };
  const votes = Object.values(values).filter(finite);
  const above = votes.filter(value => close > value).length;
  const below = votes.filter(value => close < value).length;
  return { ...values, direction: above > below ? 'BUY' : below > above ? 'SELL' : 'NEUTRAL' };
}

function movingAverageStructure(candles) {
  if (!candles || candles.length < 200) return { direction: 'UNKNOWN', cross: 'INSUFFICIENT_DATA' };
  const close = Number(candles[candles.length - 1].close);
  const ema50 = ema(candles, 50);
  const ema200 = ema(candles, 200);
  const previous = candles.slice(0, -1);
  const previous50 = ema(previous, 50);
  const previous200 = ema(previous, 200);
  const bullishCross = previous50 <= previous200 && ema50 > ema200;
  const bearishCross = previous50 >= previous200 && ema50 < ema200;
  return {
    ema50,
    ema200,
    cross: bullishCross ? 'GOLDEN_CROSS' : bearishCross ? 'DEATH_CROSS' : 'NONE',
    direction: close > ema50 && ema50 > ema200 ? 'BUY' : close < ema50 && ema50 < ema200 ? 'SELL' : 'MIXED'
  };
}

function movingAverageRibbon(candles) {
  const periods = [8, 13, 21, 34, 55];
  const lines = periods.map(period => ({ period, value: ema(candles, period) }));
  const valid = lines.every(line => line.value !== null);
  if (!valid) return { lines, direction: 'UNKNOWN', alignment: 'INCOMPLETE' };
  const bullish = lines.every((line, index) => index === 0 || lines[index - 1].value > line.value);
  const bearish = lines.every((line, index) => index === 0 || lines[index - 1].value < line.value);
  return { lines, direction: bullish ? 'BUY' : bearish ? 'SELL' : 'MIXED', alignment: bullish ? 'BULLISH' : bearish ? 'BEARISH' : 'MIXED' };
}

function priceBins(candles, bins = 24) {
  const low = Math.min(...candles.map(c => Number(c.low)));
  const high = Math.max(...candles.map(c => Number(c.high)));
  const width = (high - low) / bins || 1;
  const volumes = Array(bins).fill(0);

  for (const candle of candles) {
    const typical = (Number(candle.high) + Number(candle.low) + Number(candle.close)) / 3;
    const index = Math.max(0, Math.min(bins - 1, Math.floor((typical - low) / width)));
    volumes[index] += Number(candle.volume) || 1;
  }

  return { low, high, width, volumes };
}

function volumeProfile(candles) {
  if (!candles || candles.length < 10) return { ok: false };
  const { low, high, width, volumes } = priceBins(candles);
  const ranked = volumes.map((volume, index) => ({
    volume,
    low: low + index * width,
    high: low + (index + 1) * width,
    midpoint: low + (index + 0.5) * width
  })).sort((a, b) => b.volume - a.volume);
  const total = volumes.reduce((sum, value) => sum + value, 0);
  let accumulated = 0;
  const valueBins = [];
  for (const item of ranked) {
    valueBins.push(item);
    accumulated += item.volume;
    if (accumulated >= total * 0.7) break;
  }
  return {
    ok: true,
    vpoc: ranked[0].midpoint,
    highVolumeNode: ranked[0],
    valueAreaHigh: Math.max(...valueBins.map(item => item.high)),
    valueAreaLow: Math.min(...valueBins.map(item => item.low)),
    lowVolumeNode: ranked[ranked.length - 1]
  };
}

function vwapBands(candles) {
  if (!candles || !candles.length) return { ok: false };
  let volumeTotal = 0;
  let weighted = 0;
  for (const candle of candles) {
    const typical = (Number(candle.high) + Number(candle.low) + Number(candle.close)) / 3;
    const volume = Number(candle.volume) || 1;
    weighted += typical * volume;
    volumeTotal += volume;
  }
  const vwap = weighted / volumeTotal;
  const variance = average(candles.map(c => Math.pow(Number(c.close) - vwap, 2))) || 0;
  const deviation = Math.sqrt(variance);
  const close = Number(candles[candles.length - 1].close);
  return { ok: true, vwap, upper: vwap + deviation, lower: vwap - deviation, close };
}

function marketProfile(candles) {
  if (!candles || candles.length < 10) return { ok: false };
  const recent = candles.slice(-24);
  const profile = priceBins(recent, 18);
  const counts = profile.volumes.map((value, index) => ({
    value,
    low: profile.low + index * profile.width,
    high: profile.low + (index + 1) * profile.width
  }));
  const sorted = [...counts].sort((a, b) => b.value - a.value);
  const initial = candles.slice(-Math.min(6, candles.length));
  return {
    ok: true,
    poc: profile.low + (counts.indexOf(sorted[0]) + 0.5) * profile.width,
    initialBalanceHigh: Math.max(...initial.map(c => Number(c.high))),
    initialBalanceLow: Math.min(...initial.map(c => Number(c.low))),
    valueHigh: sorted.slice(0, 5).reduce((high, item) => Math.max(high, item.high), -Infinity),
    valueLow: sorted.slice(0, 5).reduce((low, item) => Math.min(low, item.low), Infinity)
  };
}

function wyckoff(candles) {
  if (!candles || candles.length < 20) return { phase: 'UNKNOWN', event: 'INSUFFICIENT_DATA', volumeConfirmed: false };
  const recent = candles.slice(-20);
  const first = recent[0];
  const last = recent[recent.length - 1];
  const range = Math.max(...recent.map(c => Number(c.high))) - Math.min(...recent.map(c => Number(c.low)));
  const lastRange = Number(last.high) - Number(last.low);
  const volumeAverage = average(recent.slice(0, -3).map(c => Number(c.volume) || 0)) || 0;
  const volumeConfirmed = Number(last.volume || 0) > volumeAverage * 1.25;
  const nearLow = Number(last.low) <= Math.min(...recent.slice(0, -3).map(c => Number(c.low))) + range * 0.08;
  const nearHigh = Number(last.high) >= Math.max(...recent.slice(0, -3).map(c => Number(c.high))) - range * 0.08;
  let event = 'NONE';
  if (nearLow && last.close > last.open && last.close > Number(last.low) + lastRange * 0.6) event = 'SPRING';
  else if (nearHigh && last.close < last.open && last.close < Number(last.high) - lastRange * 0.6) event = 'UPTHRUST';
  const change = Number(last.close) - Number(first.close);
  const phase = Math.abs(change) < range * 0.15 ? 'ACCUMULATION_OR_DISTRIBUTION' : change > 0 ? 'MARKUP' : 'MARKDOWN';
  return { phase, event, volumeConfirmed };
}

function supplyDemand(candles) {
  if (!candles || candles.length < 8) return { type: 'NONE' };
  const recent = candles.slice(-8);
  const base = recent.slice(-4, -2);
  const move = recent.slice(-2);
  const baseRange = average(base.map(c => Number(c.high) - Number(c.low))) || 0;
  const moveChange = Number(move[move.length - 1].close) - Number(move[0].open);
  if (Math.abs(moveChange) > baseRange * 2) {
    const low = Math.min(...base.map(c => Number(c.low)));
    const high = Math.max(...base.map(c => Number(c.high)));
    return { type: moveChange > 0 ? 'DEMAND_BASE_RALLY' : 'SUPPLY_BASE_DROP', low, high, midpoint: (low + high) / 2 };
  }
  return { type: 'NONE' };
}

function harmonic(candles) {
  if (!candles || candles.length < 30) return { pattern: 'NONE', prz: null };
  const data = candles.slice(-30);
  const points = [data[0].low, data[10].high, data[16].low, data[23].high, data[29].close].map(Number);
  const xa = Math.abs(points[1] - points[0]);
  const ab = Math.abs(points[2] - points[1]);
  const bc = Math.abs(points[3] - points[2]);
  const cd = Math.abs(points[4] - points[3]);
  if (!xa || !ab || !bc || !cd) return { pattern: 'NONE', prz: null };
  const ratios = { abXa: ab / xa, bcAb: bc / ab, cdBc: cd / bc };
  const fibLike = ratios.abXa > 0.35 && ratios.abXa < 0.9 && ratios.bcAb > 0.35 && ratios.bcAb < 1.1 && ratios.cdBc > 0.8 && ratios.cdBc < 2.2;
  return fibLike ? { pattern: 'FIBONACCI_PRZ_CANDIDATE', prz: points[4], ratios } : { pattern: 'NONE', prz: null, ratios };
}

function elliott(candles) {
  if (!candles || candles.length < 15) return { phase: 'UNKNOWN' };
  const short = Number(candles[candles.length - 1].close) - Number(candles[candles.length - 6].close);
  const long = Number(candles[candles.length - 1].close) - Number(candles[candles.length - 15].close);
  if (short > 0 && long > 0) return { phase: 'IMPULSE_UP', direction: 'BUY' };
  if (short < 0 && long < 0) return { phase: 'IMPULSE_DOWN', direction: 'SELL' };
  return { phase: 'CORRECTION', direction: long >= 0 ? 'BUY' : 'SELL' };
}

function emaConfluence(timeframes) {
  const result = {};
  for (const [timeframe, candles] of Object.entries(timeframes || {})) {
    const e21 = ema(candles, 21);
    const e50 = ema(candles, 50);
    const e200 = ema(candles, 200);
    const close = candles && candles.length ? Number(candles[candles.length - 1].close) : null;
    result[timeframe] = {
      direction: close && e21 && e50 && e200 ? (close > e21 && e21 > e50 && e50 > e200 ? 'BUY' : close < e21 && e21 < e50 && e50 < e200 ? 'SELL' : 'MIXED') : 'UNKNOWN',
      ema21: e21,
      ema50: e50,
      ema200: e200
    };
  }
  return result;
}

function atr(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const ranges = candles.slice(-period).map((c, index, data) => {
    const previous = candles[candles.length - period + index - 1];
    return Math.max(Number(c.high) - Number(c.low), Math.abs(Number(c.high) - Number(previous.close)), Math.abs(Number(c.low) - Number(previous.close)));
  });
  return average(ranges);
}

function adx(candles, period = 14) {
  if (!candles || candles.length < period + 2) return { value: null, direction: 'UNKNOWN' };
  let up = 0;
  let down = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];
    const upMove = Number(current.high) - Number(previous.high);
    const downMove = Number(previous.low) - Number(current.low);
    if (upMove > downMove && upMove > 0) up += upMove;
    if (downMove > upMove && downMove > 0) down += downMove;
  }
  const value = ((up + down) / Math.max(average(candles.slice(-period).map(c => Number(c.high) - Number(c.low))), 0.00001)) / period * 100;
  return { value, direction: up > down ? 'BUY' : down > up ? 'SELL' : 'MIXED' };
}

function stochastic(candles, period = 14) {
  if (!candles || candles.length < period) return { value: null, direction: 'UNKNOWN' };
  const recent = candles.slice(-period);
  const high = Math.max(...recent.map(c => Number(c.high)));
  const low = Math.min(...recent.map(c => Number(c.low)));
  const value = (Number(recent[recent.length - 1].close) - low) / Math.max(high - low, 0.00001) * 100;
  return { value, direction: value < 25 ? 'BUY' : value > 75 ? 'SELL' : 'NEUTRAL' };
}

function cci(candles, period = 20) {
  if (!candles || candles.length < period) return { value: null, direction: 'UNKNOWN' };
  const recent = candles.slice(-period);
  const typical = recent.map(c => (Number(c.high) + Number(c.low) + Number(c.close)) / 3);
  const mean = average(typical);
  const deviation = average(typical.map(value => Math.abs(value - mean))) || 0.00001;
  const value = (typical[typical.length - 1] - mean) / (0.015 * deviation);
  return { value, direction: value < -100 ? 'BUY' : value > 100 ? 'SELL' : 'NEUTRAL' };
}

function roc(candles, period = 12) {
  if (!candles || candles.length <= period) return { value: null, direction: 'UNKNOWN' };
  const last = Number(candles[candles.length - 1].close);
  const previous = Number(candles[candles.length - 1 - period].close);
  const value = (last - previous) / previous * 100;
  return { value, direction: value > 0 ? 'BUY' : value < 0 ? 'SELL' : 'NEUTRAL' };
}

function momentum(candles, period = 10) {
  const result = roc(candles, period);
  return { value: result.value, direction: result.direction };
}

function donchian(candles, period = 20) {
  if (!candles || candles.length < period) return { direction: 'UNKNOWN' };
  const recent = candles.slice(-period);
  const high = Math.max(...recent.map(c => Number(c.high)));
  const low = Math.min(...recent.map(c => Number(c.low)));
  const close = Number(recent[recent.length - 1].close);
  return { high, low, direction: close >= high ? 'BUY' : close <= low ? 'SELL' : 'NEUTRAL' };
}

function keltner(candles, period = 20) {
  if (!candles || candles.length < period) return { direction: 'UNKNOWN' };
  const middle = ema(candles, period);
  const range = atr(candles, Math.min(14, period));
  const close = Number(candles[candles.length - 1].close);
  return { middle, upper: middle + range * 2, lower: middle - range * 2, direction: close > middle + range * 2 ? 'BUY' : close < middle - range * 2 ? 'SELL' : 'NEUTRAL' };
}

function pivotPoints(candles) {
  if (!candles || candles.length < 2) return { direction: 'UNKNOWN' };
  const candle = candles[candles.length - 2];
  const close = Number(candles[candles.length - 1].close);
  const pivot = (Number(candle.high) + Number(candle.low) + Number(candle.close)) / 3;
  return { pivot, r1: pivot * 2 - candle.low, s1: pivot * 2 - candle.high, direction: close > pivot ? 'BUY' : close < pivot ? 'SELL' : 'NEUTRAL' };
}

function fibonacciLevels(candles) {
  if (!candles || candles.length < 30) return { direction: 'UNKNOWN' };
  const recent = candles.slice(-30);
  const high = Math.max(...recent.map(c => Number(c.high)));
  const low = Math.min(...recent.map(c => Number(c.low)));
  const close = Number(recent[recent.length - 1].close);
  const level618 = high - (high - low) * 0.618;
  return { level618, direction: close > level618 ? 'BUY' : 'SELL' };
}

function candlePattern(candles) {
  if (!candles || candles.length < 2) return { pattern: 'UNKNOWN', direction: 'UNKNOWN' };
  const previous = candles[candles.length - 2];
  const last = candles[candles.length - 1];
  const body = Math.abs(Number(last.close) - Number(last.open));
  const range = Number(last.high) - Number(last.low);
  if (Number(last.close) > Number(last.open) && Number(previous.close) < Number(previous.open) && last.close > previous.open && last.open < previous.close) return { pattern: 'BULLISH_ENGULFING', direction: 'BUY' };
  if (Number(last.close) < Number(last.open) && Number(previous.close) > Number(previous.open) && last.close < previous.open && last.open > previous.close) return { pattern: 'BEARISH_ENGULFING', direction: 'SELL' };
  if (range > 0 && body / range < 0.25) return { pattern: 'INDECISION', direction: 'NEUTRAL' };
  return { pattern: 'NONE', direction: 'NEUTRAL' };
}

function volumeSpike(candles) {
  if (!candles || candles.length < 21) return { value: null, direction: 'UNKNOWN' };
  const current = Number(candles[candles.length - 1].volume || 0);
  const baseline = average(candles.slice(-21, -1).map(c => Number(c.volume || 0))) || 1;
  const direction = current > baseline * 1.5 ? (Number(candles[candles.length - 1].close) >= Number(candles[candles.length - 1].open) ? 'BUY' : 'SELL') : 'NEUTRAL';
  return { value: current / baseline, direction };
}

function obv(candles) {
  if (!candles || candles.length < 2) return { value: null, direction: 'UNKNOWN' };
  let value = 0;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) value += Number(candles[i].volume || 0);
    else if (candles[i].close < candles[i - 1].close) value -= Number(candles[i].volume || 0);
  }
  return { value, direction: value > 0 ? 'BUY' : value < 0 ? 'SELL' : 'NEUTRAL' };
}

function rangeExpansion(candles) {
  if (!candles || candles.length < 21) return { value: null, direction: 'UNKNOWN' };
  const current = Number(candles[candles.length - 1].high) - Number(candles[candles.length - 1].low);
  const baseline = average(candles.slice(-21, -1).map(c => Number(c.high) - Number(c.low))) || 1;
  const candle = candles[candles.length - 1];
  return { value: current / baseline, direction: current > baseline * 1.5 ? (candle.close > candle.open ? 'BUY' : 'SELL') : 'NEUTRAL' };
}

function volatilityRegime(candles) {
  const value = atr(candles, 14);
  const long = atr(candles, Math.min(50, Math.floor((candles || []).length / 2)));
  return { value, direction: value && long ? (value > long * 1.25 ? 'EXPANDING' : value < long * 0.75 ? 'COMPRESSING' : 'NORMAL') : 'UNKNOWN' };
}

function trendSlope(candles, period = 20) {
  if (!candles || candles.length < period) return { value: null, direction: 'UNKNOWN' };
  const first = Number(candles[candles.length - period].close);
  const last = Number(candles[candles.length - 1].close);
  return { value: last - first, direction: last > first ? 'BUY' : last < first ? 'SELL' : 'NEUTRAL' };
}

function supportResistance(candles) {
  if (!candles || candles.length < 10) return { direction: 'UNKNOWN' };
  const recent = candles.slice(-10);
  const high = Math.max(...recent.map(c => Number(c.high)));
  const low = Math.min(...recent.map(c => Number(c.low)));
  const close = Number(recent[recent.length - 1].close);
  return { support: low, resistance: high, direction: close > (high + low) / 2 ? 'BUY' : 'SELL' };
}

function meanReversion(candles) {
  const bands = vwapBands(candles);
  if (!bands.ok) return { direction: 'UNKNOWN' };
  return { direction: bands.close < bands.lower ? 'BUY' : bands.close > bands.upper ? 'SELL' : 'NEUTRAL' };
}

function seasonality(candles) {
  if (!candles || candles.length < 10) return { direction: 'UNKNOWN' };
  const up = candles.slice(-10).filter(c => Number(c.close) > Number(c.open)).length;
  return { value: up / 10, direction: up >= 6 ? 'BUY' : up <= 4 ? 'SELL' : 'NEUTRAL' };
}

function additionalMethods(candles) {
  return {
    atr: { value: atr(candles), direction: 'NEUTRAL' },
    adx: adx(candles),
    stochastic: stochastic(candles),
    cci: cci(candles),
    roc: roc(candles),
    momentum: momentum(candles),
    donchian: donchian(candles),
    keltner: keltner(candles),
    pivotPoints: pivotPoints(candles),
    fibonacci: fibonacciLevels(candles),
    candlePattern: candlePattern(candles),
    volumeSpike: volumeSpike(candles),
    obv: obv(candles),
    rangeExpansion: rangeExpansion(candles),
    volatilityRegime: volatilityRegime(candles),
    trendSlope: trendSlope(candles),
    supportResistance: supportResistance(candles),
    meanReversion: meanReversion(candles),
    seasonality: seasonality(candles),
    priceAction: candlePattern(candles),
    movingAverageFamily: movingAverageMethods(candles),
    movingAverageStructure: movingAverageStructure(candles),
    movingAverageRibbon: movingAverageRibbon(candles)
  };
}

function methodAgreement(methods) {
  const signals = Object.values(methods).map(method => method.direction).filter(direction => direction === 'BUY' || direction === 'SELL');
  const buy = signals.filter(direction => direction === 'BUY').length;
  const sell = signals.filter(direction => direction === 'SELL').length;
  const total = signals.length;
  return { buy, sell, total, direction: buy > sell ? 'BUY' : sell > buy ? 'SELL' : 'MIXED', confidence: total ? Math.round(Math.max(buy, sell) / total * 100) : 0 };
}

function analyzeConfluence({ candles, timeframes, ta, pressure }) {
  const additional = additionalMethods(candles);
  return {
    wyckoff: wyckoff(candles),
    volumeProfile: volumeProfile(candles),
    vwap: vwapBands(candles),
    marketProfile: marketProfile(candles),
    harmonic: harmonic(candles),
    supplyDemand: supplyDemand(candles),
    elliott: elliott(candles),
    emaConfluence: emaConfluence(timeframes),
    macro: { status: 'UNAVAILABLE', note: 'DXY, US10Y, dan real yield belum terhubung' },
    pressure: pressure || null,
    additionalMethods: additional,
    methodAgreement: methodAgreement(additional),
    ta: ta || null
  };
}

module.exports = { analyzeConfluence, volumeProfile, vwapBands, marketProfile, wyckoff, supplyDemand, harmonic, elliott, emaConfluence, additionalMethods, methodAgreement, movingAverageMethods, movingAverageStructure, movingAverageRibbon };
