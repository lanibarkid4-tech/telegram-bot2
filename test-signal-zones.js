// Test via getSignalForPair (public API)
const forex = require('./forex');

(async () => {
  console.log('=== TEST: XAU/USD, scalping ===');
  const r = await forex.getSignalForPair('XAUUSD', 'scalping');
  if (r.success) {
    const lines = r.message.split('\n');
    // Cari baris ZONE TRADING dan sekitarnya
    const idx = lines.findIndex(l => l.includes('ZONE TRADING'));
    if (idx >= 0) console.log(lines.slice(idx, idx + 15).join('\n'));
  } else {
    console.log('ERROR:', r.message);
  }
})();