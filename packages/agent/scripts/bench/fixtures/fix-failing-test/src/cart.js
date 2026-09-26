// Shopping cart totals.

export function lineTotal(item) {
  return item.price * item.qty;
}

export function subtotal(items) {
  let total = 0;
  for (let i = 1; i < items.length; i++) {
    total += lineTotal(items[i]);
  }
  return total;
}

export function applyDiscount(amount, percent) {
  if (percent < 0 || percent > 100) throw new RangeError("percent must be between 0 and 100");
  return Math.round(amount * (100 - percent)) / 100;
}
