import { add, Point } from "./app";

/** Doubles a value through add. */
export function double(value: number): number {
  return add(value, value);
}

/** Measures a point through its length method. */
export function measure(point: Point): number {
  return point.length();
}
