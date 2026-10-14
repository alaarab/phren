import { hookGet } from "../../api.js";

/** A card's read lifetime. Cancelled responses cannot publish into a later visit. */
export function createHealthRead(computer, publish) {
  let current = null;
  let loaded = false;
  function cancel() {
    const previous = current;
    current = null;
    previous?.abort();
  }
  return {
    get loading() { return current !== null; },
    get loaded() { return loaded; },
    cancel,
    async load(force = false) {
      if (!force && (current || loaded)) return;
      cancel();
      const controller = new AbortController();
      current = controller;
      let health, error;
      try { health = await hookGet(computer, "/v1/health/details", {}, { signal: controller.signal }); }
      catch (err) { error = err; }
      if (current !== controller) return;
      current = null;
      loaded = true;
      publish(health, error);
    },
  };
}
