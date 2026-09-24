import { describe as vitestDescribe, it as vitestIt } from "vitest";

// A test file whose cases each start real processes runs as several files, so
// vitest spreads it over workers. Each entry file calls `useShard(index, count)`
// and then imports the suite. The suite registers through `shard()`: every
// count-th unit is kept, where a unit is a case or a whole `describe` group
// directly inside a container (`describeAll`, present in every shard) or at the
// top of the file. A group is never split, so its shared setup and case order
// stay together, and no shard is left with an empty group.

let current = { index: 0, count: 1 };

/** Picks the shard the next imported suite registers. */
export function useShard(index: number, count: number): void {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index) || index < 0 || index >= count) throw new Error(`Invalid shard ${index}/${count}`);
  current = { index, count };
}

type Registrar = (...args: unknown[]) => unknown;
const FACTORIES = new Set(["each", "for", "skipIf", "runIf"]);

export function shard(): { it: typeof vitestIt; describe: typeof vitestDescribe; describeAll: typeof vitestDescribe } {
  const { index, count } = current;
  let seen = 0, insideUnit = 0;
  const keep = () => insideUnit > 0 || seen++ % count === index;
  // A group's body, and the bodies of groups declared in it (vitest runs those
  // later), register their cases without the gate.
  const whole = (args: unknown[]) => args.map(arg => typeof arg !== "function" ? arg : (...inner: unknown[]) => {
    insideUnit++;
    try { return (arg as Registrar)(...inner); } finally { insideUnit--; }
  });
  const gated = <T extends Registrar>(base: T, group: boolean): T => {
    const register = (target: Registrar, args: unknown[]) => {
      if (!keep()) return undefined;
      return target(...(group ? whole(args) : args));
    };
    return new Proxy(base, {
      apply: (target, _self, args: unknown[]) => register(target as Registrar, args),
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== "function") return value;
        const bound = (value as Registrar).bind(target);
        return FACTORIES.has(String(property))
          ? (...args: unknown[]) => { const made = bound(...args) as Registrar; return (...inner: unknown[]) => register(made, inner); }
          : (...args: unknown[]) => register(bound, args);
      },
    }) as T;
  };
  return { it: gated(vitestIt, false), describe: gated(vitestDescribe, true), describeAll: vitestDescribe };
}
