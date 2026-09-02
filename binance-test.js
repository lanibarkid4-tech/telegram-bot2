// Test Binance endpoints
(async () => {
  const tests = [
    { url: 'https://data-api.binance.vision/api/v3/depth?symbol=XAUUSDT&limit=5', label: 'spot-depth' },
    { url: 'https://data-api.binance.vision/fapi/v1/depth?symbol=XAUUSDT&limit=5', label: 'fapi-depth' },
    { url: 'https://data-api.binance.vision/api/v3/ticker/24hr?symbol=XAUUSDT', label: 'spot-ticker' },
    { url: 'https://data-api.binance.vision/fapi/v1/openInterest?symbol=XAUUSDT', label: 'fapi-oi' },
    { url: 'https://data-api.binance.vision/api/v3/aggTrades?symbol=XAUUSDT&limit=10', label: 'spot-agg' },
  ];

  for (const t of tests) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(t.url, { signal: ctrl.signal });
      clearTimeout(timer);
      const text = await r.text();
      console.log(`${t.label}: status=${r.status} body[0..100]=${text.slice(0, 100)}`);
    } catch (e) {
      console.log(`${t.label}: ERROR ${e.message}`);
    }
  }
})();