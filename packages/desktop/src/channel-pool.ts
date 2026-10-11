// A per-computer pool of at most 4 OpenSSH ControlMaster slots, each carrying
// at most 8 concurrent channels. sshd's default MaxSessions is 10 per
// connection, so the pool keeps the desktop under that with headroom for the
// master's own session. Pure logic: it never touches ssh.

const MAX_SLOTS = 4;
const MAX_CHANNELS = 8;

export interface AcquiredChannel {
  /** Master slot (0..3) the channel was assigned to. */
  slot: number;
  /** Return the channel to the pool. Idempotent. */
  release(): void;
}

export interface ChannelPoolStats {
  /** Channels in use per master slot; index is the slot number. */
  slots: number[];
  /** Acquires queued because every slot was full. */
  waiting: number;
}

export interface ChannelPool {
  acquire(computerName: string): Promise<AcquiredChannel>;
  stats(computerName: string): ChannelPoolStats;
}

interface Waiter {
  resolve(channel: AcquiredChannel): void;
}

interface ComputerSlots {
  inUse: number[];
  waiters: Waiter[];
}

export function createChannelPool(maxSlots = MAX_SLOTS, maxChannels = MAX_CHANNELS): ChannelPool {
  const pools = new Map<string, ComputerSlots>();

  const firstFree = (pool: ComputerSlots): number => pool.inUse.findIndex(count => count < maxChannels);

  const take = (pool: ComputerSlots, slot: number): AcquiredChannel => {
    pool.inUse[slot] += 1;
    let released = false;
    return {
      slot,
      release(): void {
        if (released) return;
        released = true;
        pool.inUse[slot] -= 1;
        drain(pool);
      },
    };
  };

  const drain = (pool: ComputerSlots): void => {
    while (pool.waiters.length > 0) {
      const slot = firstFree(pool);
      if (slot === -1) return;
      pool.waiters.shift()!.resolve(take(pool, slot));
    }
  };

  const forName = (name: string): ComputerSlots => {
    let pool = pools.get(name);
    if (!pool) {
      pool = { inUse: new Array(maxSlots).fill(0), waiters: [] };
      pools.set(name, pool);
    }
    return pool;
  };

  return {
    acquire(computerName: string): Promise<AcquiredChannel> {
      const pool = forName(computerName);
      const slot = firstFree(pool);
      if (slot !== -1) return Promise.resolve(take(pool, slot));
      return new Promise(resolve => { pool.waiters.push({ resolve }); });
    },
    stats(computerName: string): ChannelPoolStats {
      const pool = pools.get(computerName);
      return {
        slots: pool ? [...pool.inUse] : new Array(maxSlots).fill(0),
        waiting: pool ? pool.waiters.length : 0,
      };
    },
  };
}

/** The process-wide pool: one set of master slots per computer. */
export const channelPool = createChannelPool();
