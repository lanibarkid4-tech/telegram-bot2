// LIVE TEST — koneksi real ke Finnhub + semua analisa
require('dotenv').config();
const candles = require('./candles');
const xauusdTA = require('./xauusd-ta');
const mtf = require('./timeframe');
const fundamental = require('./fundamental');
const ict = require('./ict-structures');
const smt = require('./smt-analysis');

const ok = [], bad = [];
async function step(name, fn) {
  try { const r = await fn(); ok.push(name); console.log('PASS ' + name + ' -> ' + r); }
  catch (e) { bad.push(name + ': ' + e.message); console.log('FAIL ' + name + ' -> ' + e.message); }
}

(async () => {
  console.log('Key terdeteksi: ' + (process.env.FINNHUB_API_KEY || '(KOSONG)').slice(0, 6) + '...\n');

  await step('candles: XAU/USD 1H (live)', async () => {
    const c = await candles.getCandles('xauusd', '1h', 50);
    if (!c.length) throw new Error('kosong');
    return c.length + ' candle, close terakhir ' + c[c.length - 1].close + ' @ ' + new Date(c[c.length - 1].openTime).toISOString();
  });

  await step('candles: EUR/USD D1 (live)', async () => {
    const c = await candles.getCandles('eurusd', '1day', 10);
    if (!c.length) throw new Error('kosong');
    return c.length + ' candle, close terakhir ' + c[c.length - 1].close;
  });

  await step('candles: BTC/USD 1H (live)', async () => {
    const c = await candles.getCandles('btcusd', '1h', 10);
    if (!c.length) throw new Error('kosong');
    return c.length + ' candle, close terakhir ' + c[c.length - 1].close;
  });

  await step('xauusd-ta: analisa teknikal penuh (live)', async () => {
    const r = await xauusdTA.analyze(true);
    const t = xauusdTA.formatMessage(r);
    if (t.length < 50) throw new Error('pesan aneh');
    return 'RSI ' + (r.indicators?.rsi ?? 'n/a') + ', pesan ' + t.length + ' karakter';
  });

  await step('timeframe: MTF 5 TF (live)', async () => {
    const r = await mtf.analyzeMTF('xauusd');
    const tfOk = Object.entries(r.analysis).filter(([, v]) => !v.error && v.trend !== 'UNKNOWN').map(([k]) => k);
    return 'confluence ' + r.confluence.bias + ' (' + r.confluence.score + '%), TF valid: ' + (tfOk.join(',') || 'tidak ada');
  });

  await step('ict: struktur ICT pada candle live', async () => {
    const c = await candles.getCandles('xauusd', '1h', 100);
    const r = ict.analyze(c);
    return 'OB=' + r.orderBlocks.length + ' FVG=' + r.fvgs.length + ' CISD=' + r.cisds.length + ' sweep=' + r.sweeps.length;
  });

  await step('smt: SMT divergence vs DXY (live)', async () => {
    const r = await smt.analyzeWithDXY('xauusd', '1h');
    return 'REC ' + r.recommendation + ' (' + r.confidence + '%), DXY ' + r.dxy.dxyCurrent;
  });

  await step('fundamental: currency strength (live)', async () => {
    const c = await candles.getCandles('xauusd', '1day', 30);
    const closes = c.map(x => x.close);
    const r = await fundamental.analyzeFundamental({ symbol: 'XAU/USD', base: 'XAU', quote: 'USD' }, closes);
    const s = Object.entries(r.strength).map(([k, v]) => k + (v >= 0 ? '+' : '') + v.toFixed(1)).join(' ');
    return 'bias ' + r.bias + ', regime ' + r.regime + ', strength [' + s + ']';
  });

  console.log('\n========== RINGKASAN ==========');
  console.log('PASS: ' + ok.length + '  |  FAIL: ' + bad.length);
  bad.forEach(b => console.log('  gagal: ' + b));
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
