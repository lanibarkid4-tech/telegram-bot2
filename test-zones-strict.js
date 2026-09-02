// Test calculateZones dengan aturan ketat
const forex = require('./forex');

const pair = { symbol: 'XAUUSD', base: 'XAU', quote: 'USD', display: 'XAU/USD (Gold Spot)' };
const currentPrice = 4300.0;

console.log('=== TEST: BUY signal, scalping ===');
const buyZones = forex.calculateZones('BUY', currentPrice, null, 'scalping', null, pair);
console.log(JSON.stringify(buyZones, null, 2));

console.log('\n=== TEST: SELL signal, intraday ===');
const sellZones = forex.calculateZones('SELL', currentPrice, null, 'intraday', null, pair);
console.log(JSON.stringify(sellZones, null, 2));

console.log('\n=== VALIDASI BUY ===');
console.log('SL < Konservatif:', parseFloat(buyZones.stopLoss) < parseFloat(buyZones.entry.conservative));
console.log('Konservatif < Ideal:', parseFloat(buyZones.entry.conservative) < parseFloat(buyZones.entry.ideal));
console.log('Ideal < Agresif:', parseFloat(buyZones.entry.ideal) < parseFloat(buyZones.entry.aggressive));
console.log('Agresif < TP1:', parseFloat(buyZones.entry.aggressive) < parseFloat(buyZones.takeProfit[0].price));
console.log('TP1 < TP2:', parseFloat(buyZones.takeProfit[0].price) < parseFloat(buyZones.takeProfit[1].price));
console.log('TP2 < TP3:', parseFloat(buyZones.takeProfit[1].price) < parseFloat(buyZones.takeProfit[2].price));
console.log('Validation OK:', buyZones.validation.ok);

console.log('\n=== VALIDASI SELL ===');
console.log('SL > Konservatif:', parseFloat(sellZones.stopLoss) > parseFloat(sellZones.entry.conservative));
console.log('Konservatif > Ideal:', parseFloat(sellZones.entry.conservative) > parseFloat(sellZones.entry.ideal));
console.log('Ideal > Agresif:', parseFloat(sellZones.entry.ideal) > parseFloat(sellZones.entry.aggressive));
console.log('Agresif > TP1:', parseFloat(sellZones.entry.aggressive) > parseFloat(sellZones.takeProfit[0].price));
console.log('TP1 > TP2:', parseFloat(sellZones.takeProfit[0].price) > parseFloat(sellZones.takeProfit[1].price));
console.log('TP2 > TP3:', parseFloat(sellZones.takeProfit[1].price) > parseFloat(sellZones.takeProfit[2].price));
console.log('Validation OK:', sellZones.validation.ok);