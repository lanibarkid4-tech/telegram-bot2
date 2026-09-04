// SMOKE TEST — semua modul (ringkas)
let pass = 0, fail = 0; const R = [];
const check = (n, f) => Promise.resolve().then(f)
  .then(() => { R.push('  PASS  ' + n); pass++; })
  .catch(e => { R.push('  FAIL  ' + n + ' -> ' + e.message); fail++; });
const A = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const gc = (n, d) => { const o = []; let p = 2000;
  for (let i = 0; i < n; i++) { const op = p; p += d + Math.sin(i / 3) * 2;
    o.push({ openTime: Date.now() - (n - i) * 36e5, open: op, high: Math.max(op, p) + 1, low: Math.min(op, p) - 1, close: p, volume: 1000 }); }
  return o; };
const gp = n => gc(n, 0.5).map(c => c.close);
const uc = require('./utils');
const candles = require('./candles');
const xauusdTA = require('./xauusd-ta');
const mtf = require('./timeframe');

(async () => {
  await check('utils: SimpleCache set/get/evict/delete', () => {
    const c = new uc.SimpleCache(60, 2);
    c.set('a', 1); c.set('b', 2);
    A(c.get('a') === 1);
    c.set('c', 3); A(c.get('a') === null, 'evict');
    c.set('b', 9); c.delete('b'); A(c.get('b') === null, 'delete');
  });
  await check('utils: SimpleCache TTL expiry', () => {
    const c = new uc.SimpleCache(1, 10); c.set('x', 'v');
    return new Promise(r => setTimeout(() => { A(c.get('x') === null, 'expired'); r(); }, 1200));
  });
  await check('utils: RateLimiter + reset', () => {
    const rl = new uc.RateLimiter({ '/t': 2 }, 60);
    A(rl.checkLimit('/t') && rl.checkLimit('/t'));
    A(!rl.checkLimit('/t'), 'blok call-3');
    A(rl.getRemainingCalls('/t') === 0);
    rl.reset('/t'); A(rl.checkLimit('/t'), 'lolos setelah reset');
  });
  await check('utils: Logger semua level', () => {
    const l = new uc.Logger('[tes]', 'debug');
    l.debug('d'); l.info('i'); l.warn('w'); l.error('e');
  });
  await check('utils: BatchProcessor add', () => {
    const bp = new uc.BatchProcessor(5, 1000); bp.add({ id: 1 }); bp.add({ id: 2 });
  });
  await check('utils: retryWithBackoff sukses-ke-2', async () => {
    let n = 0;
    const v = await uc.retryWithBackoff(async () => { n++; if (n < 2) throw new Error('gagal'); return 'ok'; }, 3, 10);
    A(v === 'ok' && n === 2);
  });
  await check('utils: retryWithBackoff habis-retry', async () => {
    let err = null;
    try { await uc.retryWithBackoff(async () => { throw new Error('selalu gagal'); }, 2, 10); }
    catch (e) { err = e; }
    A(err && err.message === 'selalu gagal');
  });
  await check('utils: GracefulShutdown register', () => {
    const g = new uc.GracefulShutdown(); g.register('d', () => Promise.resolve());
    A(g.handlers.length === 1);
  });

  await check('candles: resolveSymbol mapping Finnhub', () => {
    A(candles.resolveSymbol('xauusd') === 'OANDA:XAU_USD');
    A(candles.resolveSymbol('gold') === 'OANDA:XAU_USD');
    A(candles.resolveSymbol('eurusd') === 'OANDA:EUR_USD');
    A(candles.resolveSymbol('gbpjpy') === 'OANDA:GBP_JPY');
    A(candles.resolveSymbol('btcusd') === 'BINANCE:BTCUSDT');
    A(candles.resolveSymbol('ethusd') === 'BINANCE:ETHUSDT');
    A(candles.resolveSymbol('nasdaq') === 'US_NDX');
    A(candles.resolveSymbol('spx') === 'US_SPX');
    A(candles.resolveSymbol('dxy') === 'ICE_DX_Y');
    A(candles.resolveSymbol('abc') === 'ABC', 'passthrough');
  });
  await check('candles: getCandles tanpa key -> error FINNHUB', async () => {
    let err = null;
    try { await candles.getCandles('xauusd', '1h', 10); } catch (e) { err = e; }
    A(err && err.message.includes('FINNHUB_API_KEY'), 'dapat: ' + (err && err.message));
  });
  await check('xauusd-ta: analyze tanpa key -> error FINNHUB', async () => {
    let err = null;
    try { await xauusdTA.analyze(true); } catch (e) { err = e; }
    A(err && err.message.includes('FINNHUB_API_KEY'));
  });

  await check('timeframe: analyzeTrend bullish', () => {
    const r = mtf.analyzeTrend(gc(40, 1.0));
    A(r.trend === 'BULLISH', 'dapat ' + r.trend);
    A(typeof r.sma7 === 'number' && typeof r.rsi === 'number');
  });
  await check('timeframe: analyzeTrend data kurang -> UNKNOWN', () => {
    A(mtf.analyzeTrend(gc(5, 1)).trend === 'UNKNOWN');
  });
  await check('timeframe: calculateConfluence', () => {
    const c = mtf.calculateConfluence({ D1: { trend: 'BULLISH' }, H4: { trend: 'BULLISH' }, H1: { trend: 'BEARISH' }, M30: { trend: 'UNKNOWN', error: 'x' } });
    A(c.bias === 'BULLISH' && c.total === 3, JSON.stringify(c));
  });
  await check('timeframe: formatMTFMessage', () => {
    const msg = mtf.formatMTFMessage('xauusd', { analysis: { D1: { trend: 'BULLISH', strength: 1.2, label: 'Daily', bars: 100 } }, confluence: { bias: 'BULLISH', score: 100, aligned: 1, total: 1 } });
    A(typeof msg === 'string' && msg.length > 10);
  });
  await check('timeframe: analyzeMTF tanpa key -> confluence tetap', async () => {
    const r = await mtf.analyzeMTF('xauusd');
    A(r.confluence && typeof r.confluence.score === 'number');
    A(Object.keys(r.analysis).length === 5);
  });

  const fundamental = require('./fundamental');
  const ict = require('./ict-structures');
  const smt = require('./smt-analysis');
  const fastbull = require('./fastbull');

  await check('fundamental: determineRegime valid', () => {
    A(['TRENDING_UP', 'TRENDING_DOWN', 'RANGING', 'TRANSITION'].includes(fundamental.determineRegime(gp(30))));
  });
  await check('fundamental: determineRegime kurang -> UNKNOWN', () => {
    A(fundamental.determineRegime(gp(5)) === 'UNKNOWN');
  });
  await check('fundamental: calculateVolatility', () => {
    const v = fundamental.calculateVolatility(gp(30));
    A(typeof v.annualized === 'number' && ['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN'].includes(v.level));
  });
  await check('fundamental: getPairCurrencyStrength XAU/USD', () => {
    const r = fundamental.getPairCurrencyStrength({ symbol: 'XAU/USD' }, { USD: 1.0 });
    A(r.quote === -0.7, JSON.stringify(r));
  });
  await check('fundamental: analyzeFundamental fallback netral', async () => {
    const r = await fundamental.analyzeFundamental({ symbol: 'XAU/USD', base: 'XAU', quote: 'USD' }, gp(30));
    A(['BULLISH', 'BEARISH', 'NEUTRAL'].includes(r.bias));
    A(r.regime && r.volatility);
  });

  await check('ict: analyze struktur lengkap', () => {
    const r = ict.analyze(gc(60, 0.8));
    A(Array.isArray(r.orderBlocks) && Array.isArray(r.fvgs) && Array.isArray(r.cisds) && Array.isArray(r.sweeps));
    A(r.premiumDiscount !== undefined && r.structure !== undefined);
    A(typeof r.lastPrice === 'number');
  });
  await check('ict: analyze data kurang -> handled', () => {
    A(ict.analyze(gc(5, 0.5)).error.includes('Insufficient'));
  });
  await check('ict: fungsi standalone', () => {
    const c = gc(60, 0.7);
    A(Array.isArray(ict.detectFVGs(c, 50)));
    A(Array.isArray(ict.detectLiquiditySweeps(c, 50)));
    A(ict.detectTrend(c, 50) !== undefined);
  });

  await check('smt: alignCandles by timestamp', () => {
    const al = smt.alignCandles(gc(30, 0.5), gc(30, 0.3), 20);
    A(Array.isArray(al) && al.length > 0 && al[0].primary && al[0].secondary);
  });
  await check('smt: detectDivergence kosong -> null', () => {
    A(smt.detectDivergence([]) === null);
  });
  await check('smt: CORRELATIONS map', () => {
    A(smt.CORRELATIONS.xauusd.dxy.pair === 'dxy');
    A(Array.isArray(smt.CORRELATIONS.xauusd.correlated));
  });
  await check('smt: analyzeWithDXY tanpa key -> error', async () => {
    let err = null;
    try { await smt.analyzeWithDXY('xauusd', '1h'); } catch (e) { err = e; }
    A(!!err, 'harus error tanpa key');
  });

  await check('fastbull: start + getNews (scraping live)', async () => {
    await fastbull.start();
    try { A(Array.isArray(await fastbull.getNews(5))); } finally { fastbull.stop(); }
  });
  await check('fastbull: getCalendar (scraping live)', async () => {
    A(Array.isArray(await fastbull.getCalendar(24)));
  });
  await check('fastbull: formatNewsMessage dummy', () => {
    const t = fastbull.formatNewsMessage([{ title: 'Tes', time: '10:00', impact: 'high', url: 'https://x.com' }], 5);
    A(typeof t === 'string' && t.length > 0);
  });

  console.log('\n========== HASIL SMOKE TEST ==========');
  R.forEach(r => console.log(r));
  console.log('======================================');
  console.log('TOTAL: ' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
