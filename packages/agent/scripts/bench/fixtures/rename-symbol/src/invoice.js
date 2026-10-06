import { calcTotal } from "./pricing.js";

export function invoiceLine(order) {
  const total = calcTotal(order);
  return `${order.id}: ${(total / 100).toFixed(2)}`;
}
