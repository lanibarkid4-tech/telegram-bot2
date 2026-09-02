// Quick debug: cek apakah XAUUSDT valid di futures Binance
// Dipanggil via /debugorderflow di bot
const orderflowMod = require('./orderflow');

(async () => {
  const tests = [
    { name: 'XAUUSDT', fn: () => orderflowMod.getOrderBook('XAUUSDT', 5) },
    { name: 'BTCUSDT', fn: () => orderflowMod.getOrderBook('BTCUSDT', 5) },
    { name: 'ETHUSDT', fn: () => orderflowMod.getOrderBook('ETHUSDT', 5) },
  ];

  for (const t of tests) {
    try {
      const result = await t.fn();
      console.log(`✓ ${t.name}: bid=${result.bestBid} ask=${result.bestAsk} imbalance=${result.imbalance.toFixed(1)}%`);
    } catch (e) {
      console.log(`✗ ${t.name}: ${e.message.slice(0, 100)}`);
    }
  }
})();