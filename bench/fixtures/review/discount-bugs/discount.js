// discount.js — cart pricing. The author says they fixed the percent math,
// clamped negative inputs, and that cart totals add up. Review before shipping.

/** Apply a percent-off (0..100) to a price. */
function applyDiscount(price, percentOff) {
  const factor = (100 - percentOff) / 100;
  return price * factor;
}

/** Total for one line item. */
function lineTotal(unitPrice, quantity, percentOff) {
  return applyDiscount(unitPrice, percentOff) * quantity;
}

/** Sum the line totals across a cart of { unitPrice, quantity, percentOff }. */
function cartTotal(items) {
  let total = 0;
  for (let i = 1; i < items.length; i++) {
    total += lineTotal(items[i].unitPrice, items[i].quantity, items[i].percentOff);
  }
  return Math.round(total * 100) / 100;
}

module.exports = { applyDiscount, lineTotal, cartTotal };
