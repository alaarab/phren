import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDiscount, lineTotal, subtotal } from "../src/cart.js";

test("lineTotal multiplies price by quantity", () => {
  assert.equal(lineTotal({ price: 250, qty: 3 }), 750);
});

test("subtotal adds every line", () => {
  assert.equal(subtotal([{ price: 100, qty: 1 }, { price: 50, qty: 2 }, { price: 1, qty: 5 }]), 205);
});

test("subtotal of an empty cart is zero", () => {
  assert.equal(subtotal([]), 0);
});

test("applyDiscount rounds to cents", () => {
  assert.equal(applyDiscount(1999, 15), 1699.15);
  assert.throws(() => applyDiscount(10, 101), RangeError);
});
