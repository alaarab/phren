import { bridgeRoot, type Provider } from "./protocol.js";

type PaneIdentity = { server: string; pane: string; terminal?: string };
type Origin = PaneIdentity & { workspace: string; tab: string; terminal: string; agent: Provider };
type Alias = { from: PaneIdentity; to: Origin };
type Pending = { root: string; aliases: Alias[] };
const pending = new Set<Pending>();
const samePane = (left: PaneIdentity, right: PaneIdentity) => left.server === right.server && left.pane === right.pane && (left.terminal === undefined || left.terminal === right.terminal);

export interface DispatchOriginWindow {
  rewrite(origin: Origin | undefined): Origin | undefined;
  finish(): void;
}

/** Register before a dispatch's first await; only these live operations can
 * inherit a hand-over alias. A later dispatch starts with no aliases. */
export function trackDispatchOrigin(): DispatchOriginWindow {
  const entry: Pending = { root: bridgeRoot(), aliases: [] };
  pending.add(entry);
  return {
    rewrite: origin => origin && (entry.aliases.find(alias => samePane(alias.from, origin))?.to ?? origin),
    finish: () => { pending.delete(entry); entry.aliases = []; },
  };
}

/** Prepare while holding the receipt lock, then seal only after role commit.
 * Keep prior chains in this snapshot because the role write invalidates them.
 * Operations started during the commit are included; later ones never are. */
export function prepareDispatchOriginHandover(from: PaneIdentity, to: Origin): () => void {
  const root = bridgeRoot();
  const before = new Map([...pending].filter(entry => entry.root === root).map(entry => [entry, entry.aliases]));
  return () => {
    for (const entry of pending) {
      if (entry.root !== root) continue;
      entry.aliases = (before.get(entry) ?? entry.aliases)
        .filter(alias => !samePane(alias.from, to) && !samePane(alias.from, from))
        .map(alias => samePane(alias.to, from) ? { ...alias, to } : alias);
      entry.aliases.push({ from, to });
    }
  };
}

/** Called after every successful role write, without acquiring another lock.
 * A stop or reassignment must not let an earlier move redirect late workers
 * away from the newly chosen conductor. No aliases survive a Hook restart. */
export function conductorOriginChanged(conductor: (PaneIdentity & { source?: Provider; workspace?: string; tab?: string }) | null | undefined): void {
  const root = bridgeRoot();
  for (const entry of pending) {
    if (entry.root !== root) continue;
    entry.aliases = entry.aliases.filter(alias => conductor && samePane(alias.to, conductor)
      && (conductor.source === undefined || alias.to.agent === conductor.source)
      && (conductor.workspace === undefined || alias.to.workspace === conductor.workspace)
      && (conductor.tab === undefined || alias.to.tab === conductor.tab));
  }
}
