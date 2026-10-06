/** Adds two numbers. */
export function add(a: number, b: number): number {
  return a + b;
}

/** A point in the plane. */
export class Point {
  constructor(public x: number, public y: number) {}

  /** Distance from the origin. */
  length(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }
}

export interface Named {
  name: string;
}

export type Coordinate = number;

export enum Axis {
  X,
  Y,
}
