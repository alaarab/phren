// Vite bundles a worker only for the literal `new Worker(new URL(...), ...)`
// pattern; this stand-in records the bundled URL without starting anything.
export class Worker {
  constructor(public url: string | URL, public options?: WorkerOptions) {}
}
