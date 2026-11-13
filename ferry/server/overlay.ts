// A chain store that keeps writes in memory: previews and plans settle a chain exactly as a move would, without
// leaving files behind.

import type { Chain, NumberedItem } from "../shared/model";
import type { ChainStore } from "./chain-store";

export function overlayStore(base: ChainStore): ChainStore {
  const chains = new Map<string, Chain>();
  const snapshots = new Map<string, NumberedItem[]>();
  const records = new Map<string, string>();
  const index = new Map<string, string>();
  const overlay: ChainStore = {
    dir: base.dir,
    ready: () => base.ready(),
    chainOf: (agentId) => index.get(agentId) ?? base.chainOf(agentId),
    async read(chainId) {
      const chain = chains.get(chainId);
      return chain ? structuredClone(chain) : base.read(chainId);
    },
    async write(chain) {
      chains.set(chain.id, structuredClone(chain));
      for (const visit of chain.visits) index.set(visit.agentId, chain.id);
    },
    async writeSnapshot(chainId, visit, items) {
      snapshots.set(`${chainId}/${visit}`, [...items]);
    },
    async readSnapshot(chainId, visit) {
      return snapshots.get(`${chainId}/${visit}`) ?? base.readSnapshot(chainId, visit);
    },
    async history(chain) {
      const closed = chain.visits.filter((visit) => visit.closedAt && visit.itemCount > 0);
      const parts = await Promise.all(closed.map((visit) => overlay.readSnapshot(chain.id, visit.n)));
      return parts.flat().sort((a, b) => a.n - b.n);
    },
    recordPath: (chainId, deliveryId) => base.recordPath(chainId, deliveryId),
    async writeRecord(chainId, deliveryId, text) {
      records.set(`${chainId}/${deliveryId}`, text);
      return base.recordPath(chainId, deliveryId);
    },
    async readRecord(chainId, deliveryId) {
      return records.get(`${chainId}/${deliveryId}`) ?? base.readRecord(chainId, deliveryId);
    },
    async writeSent(chainId, deliveryId, text) {
      records.set(`sent:${chainId}/${deliveryId}`, text);
    },
    async readSent(chainId, deliveryId) {
      return records.get(`sent:${chainId}/${deliveryId}`) ?? base.readSent(chainId, deliveryId);
    },
    withLock: (_chainId, task) => task(),
    forget: async () => 0,
    sweep: async () => 0,
  };
  return overlay;
}
