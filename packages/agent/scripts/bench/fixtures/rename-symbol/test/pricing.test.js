import { test } from "node:test";
import assert from "node:assert/strict";
import * as pricing from "../src/pricing.js";
import { invoiceLine } from "../src/invoice.js";
import { summary } from "../src/report.js";

const order = { id: "A1", lines: [{ cents: 250, qty: 2 }, { cents: 99, qty: 1 }] };

test("computeTotal is exported and calcTotal is gone", () => {
  assert.equal(typeof pricing.computeTotal, "function");
  assert.equal(pricing.calcTotal, undefined);
  assert.equal(pricing.computeTotal(order), 599);
});

test("callers still work", () => {
  assert.equal(invoiceLine(order), "A1: 5.99");
  assert.deepEqual(summary([order, order]), { count: 2, grand: 1198 });
  assert.equal(pricing.isFree({ lines: [] }), true);
});
