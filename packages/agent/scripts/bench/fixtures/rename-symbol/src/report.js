import * as pricing from "./pricing.js";

export function summary(orders) {
  const grand = orders.map((o) => pricing.calcTotal(o)).reduce((a, b) => a + b, 0);
  return { count: orders.length, grand };
}
