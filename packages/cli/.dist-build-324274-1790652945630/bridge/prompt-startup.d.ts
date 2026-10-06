/** Only agent_not_ready guarantees that no text reached the terminal. A
 * freshly dispatched agent can report its session before Herdr registers it
 * as active. Revalidate that exact target before every retry, and never
 * retry a timeout, lost reply, or other potentially delivered write. */
export declare function promptWithStartupRetry<T>(send: () => Promise<T>, revalidate: () => Promise<void>, waitMs?: number): Promise<T>;
