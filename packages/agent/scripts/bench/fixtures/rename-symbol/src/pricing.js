/** Total price of an order in cents, after quantity. */
export function calcTotal(order) {
  return order.lines.reduce((sum, line) => sum + line.cents * line.qty, 0);
}

export function isFree(order) {
  return calcTotal(order) === 0;
}
