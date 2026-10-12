/**
 * A Tape Network node: joins the mesh (same protocol as Tape Hub), optionally publishes a
 * discovery listing, finds peers from verified listings, answers approved peers from its
 * catalog and runs search (with consensus) and recommendations locally.
 */
import {
  MESH_KIND_DISCOVERY_LISTING,
  MESH_KIND_RELAY_OFFER,
  buildMeshEvent,
  checkMeshEvent,
  irohEndpointIdFromHex,
  meshBindingMessage,
  meshBindingTag,
  normalizeMeshSocketAddr,
  nostrPublicKey,
  parseMeshDiscoveryListing,
  signNostrEvent,
  verifyMeshBinding,
  type MeshDiscoveryListing,
  type NostrEvent,
} from '../protocol/mesh.js';
import type { LookupQuery, RecommendSeed } from '../protocol/lookup.js';
import type { CatalogSource } from '../catalog/catalog.js';
import { buildConsensus, type ConsensusTrack } from '../consensus/consensus.js';
import { mergeCandidates, rankRecommendations, type RankingAlgorithm, type Ranked } from '../recommend/algorithms.js';
import { LookupEndpoint, type LookupPeer } from './lookup.js';
import { MeshNode } from './mesh.js';
import { MeshNostrRelay } from './store.js';
import { NodeState } from './state.js';

export type DiscoveredPeer = LookupPeer & {
  hubId: string;
  capabilities: string[];
  approved: boolean;
  blocked: boolean;
};

export type TapeNetworkNodeOptions = {
  home?: string;
  catalog?: CatalogSource | null;
  /** Private/loopback addresses allowed (tests, LAN-only meshes). */
  allowPrivateAddrs?: boolean;
};

function isPublicHost(addr: string): boolean {
  const host = addr.startsWith('[') ? addr.slice(1, addr.indexOf(']')) : addr.slice(0, addr.lastIndexOf(':'));
  if (/^(10|127|0)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return false;
  if (host === '::1' || /^f[cd]/i.test(host) || /^fe[89ab]/i.test(host)) return false;
  return true;
}

export class TapeNetworkNode {
  readonly state: NodeState;
  private catalog: CatalogSource | null;
  private readonly store = new MeshNostrRelay();
  private mesh: MeshNode | null = null;
  readonly lookup: LookupEndpoint;
  private readonly listings = new Map<string, { listing: MeshDiscoveryListing; hubId: string; createdAt: number }>();
  private readonly allowPrivate: boolean;

  constructor(options: TapeNetworkNodeOptions = {}) {
    this.state = new NodeState(options.home);
    this.catalog = options.catalog ?? null;
    this.allowPrivate = options.allowPrivateAddrs ?? false;
    this.lookup = new LookupEndpoint({
      catalog: () => this.catalog,
      hubName: () => this.state.config.name ?? `Tape Network ${this.state.identity().hubId.slice(-8)}`,
      isApproved: (peer) => this.state.config.approvedPeers.includes(peer),
      isBlocked: (peer) => this.state.config.blockedPeers.includes(peer),
    });
  }

  setCatalog(catalog: CatalogSource | null): void {
    this.catalog = catalog;
  }

  async start(): Promise<void> {
    const config = this.state.config;
    const network = {
      relay: config.relayUrls.length ? { urls: config.relayUrls } : { mode: 'disabled' },
      // Sovereign by default: no n0 DNS, no LAN broadcast.
      discovery: { dns: false, mdns: false },
    };
    await this.lookup.start({ key: this.state.lookupIrohKey(), ...network, bindAddr: `${config.bindHost}:${config.lookupUdpPort}` });
    this.mesh = new MeshNode({
      dataDir: this.state.home,
      bindHost: config.bindHost,
      udpPort: config.meshUdpPort,
      relay: this.store,
      nostrSecretKey: () => this.state.nostrSecretKey(),
      onEvent: async (event) => {
        this.ingest(event);
        return null;
      },
    });
    await this.mesh.start(config.relayUrls);
  }

  async stop(): Promise<void> {
    await this.mesh?.stop();
    await this.lookup.stop();
    this.store.close();
  }

  /** Mesh address to share with others: "<hex endpoint id>@<ip:port>". */
  async meshAddress(): Promise<string | null> {
    const id = this.mesh?.endpointIdHex();
    const port = await this.mesh?.boundPort();
    if (!id || !port) return null;
    const host = this.state.config.advertiseAddrs[0]?.replace(/:\d+$/, '') ?? '127.0.0.1';
    return `${id}@${host}:${port}`;
  }

  private ingest(event: NostrEvent): void {
    if (event.kind !== MESH_KIND_DISCOVERY_LISTING) return;
    const listing = parseMeshDiscoveryListing(event);
    const binding = listing ? verifyMeshBinding(event) : null;
    if (!listing || !binding || event.pubkey === nostrPublicKey(this.state.nostrSecretKey())) return;
    if (!this.allowPrivate && !listing.addrs.every(isPublicHost)) return;
    const previous = this.listings.get(event.pubkey);
    if (previous && previous.createdAt >= event.created_at) return;
    if (!previous && this.listings.size >= 1024) return;
    this.listings.set(event.pubkey, { listing, hubId: binding.hubId, createdAt: event.created_at });
  }

  /** Lookup addresses to advertise: configured ones, else what the endpoint bound (public only unless allowed). */
  private async lookupAddrs(): Promise<string[]> {
    const configured = this.state.config.advertiseAddrs;
    const raw = configured.length ? configured : await this.lookup.addrs();
    return raw
      .map((addr) => normalizeMeshSocketAddr(addr))
      .filter((addr): addr is string => Boolean(addr) && (this.allowPrivate || isPublicHost(addr!)))
      .slice(0, 4);
  }

  private async listingEvent(): Promise<NostrEvent | null> {
    const endpointId = this.lookup.peerIdHex();
    if (!endpointId) return null;
    const sk = this.state.nostrSecretKey();
    const { hubId, publicKey } = this.state.identity();
    const pubkey = nostrPublicKey(sk);
    const binding = meshBindingTag({ hubId, hubPublicKey: publicKey, signature: this.state.signWithIdentity(meshBindingMessage(hubId, pubkey)) });
    const config = this.state.config;
    return signNostrEvent(buildMeshEvent({
      kind: MESH_KIND_DISCOVERY_LISTING,
      tags: [['d', 'tape-discovery'], binding],
      content: JSON.stringify({
        v: 1,
        service: 'tape-discovery',
        endpointId,
        addrs: await this.lookupAddrs(),
        relayUrls: config.relayUrls.slice(0, 3),
        capabilities: ['metadata-search-v1', 'recommendations-v1'],
        name: config.name,
      }),
    }), sk);
  }

  private bootstrapPeers(): Array<{ id: string; addr: string }> {
    return this.state.config.bootstrapPeers.flatMap((raw) => {
      const match = /^([0-9a-f]{64})@(.+)$/.exec(raw.trim().toLowerCase());
      const addr = match ? normalizeMeshSocketAddr(match[2]) : null;
      const id = match ? irohEndpointIdFromHex(match[1], 'base32') : null;
      return id && addr ? [{ id, addr }] : [];
    });
  }

  /** Publish (if enabled) and pull listings from every bootstrap mesh peer. */
  async refresh(): Promise<void> {
    if (!this.mesh) throw new Error('node not started');
    const event = this.state.config.publishListing ? await this.listingEvent() : null;
    if (event) this.store.publishLocal(event);
    for (const peer of this.bootstrapPeers()) {
      try {
        const requests: unknown[][] = [];
        if (event) requests.push(['EVENT', event]);
        requests.push(['REQ', 'l', { kinds: [MESH_KIND_DISCOVERY_LISTING, MESH_KIND_RELAY_OFFER], limit: 200 }]);
        const replies = await this.mesh.request(peer.id, requests, { directAddrs: [peer.addr] });
        const events = replies.find((r) => r[0] === 'EVENTS')?.[2];
        for (const raw of Array.isArray(events) ? events : []) {
          const check = checkMeshEvent(raw);
          if (check.ok) this.ingest(check.event);
        }
      } catch {
        /* peer offline: try the next one */
      }
    }
  }

  peers(): DiscoveredPeer[] {
    const config = this.state.config;
    return [...this.listings.values()].flatMap(({ listing, hubId }) => {
      const peerId = irohEndpointIdFromHex(listing.endpointId, 'base32');
      if (!peerId) return [];
      return [{
        peerId,
        hubId,
        hubName: listing.name ?? `Hub ${hubId.slice(-8)}`,
        directAddrs: listing.addrs,
        relayUrl: listing.relayUrls[0],
        capabilities: listing.capabilities,
        approved: config.approvedPeers.includes(peerId),
        blocked: config.blockedPeers.includes(peerId),
      }];
    });
  }

  setPeerApproval(peerId: string, approved: boolean): void {
    const set = new Set(this.state.config.approvedPeers);
    if (approved) set.add(peerId); else set.delete(peerId);
    this.state.config.approvedPeers = [...set].sort();
    this.state.saveConfig();
  }

  private usablePeers(capability: string): DiscoveredPeer[] {
    return this.peers().filter((p) => p.approved && !p.blocked && p.capabilities.includes(capability)).slice(0, 16);
  }

  /** Metadata search across approved peers, merged by per-field consensus. */
  async search(query: LookupQuery): Promise<{ searchedPeers: number; tracks: ConsensusTrack[] }> {
    const peers = this.usablePeers('metadata-search-v1');
    const answers = await Promise.allSettled(peers.map((peer) => this.lookup.lookup(peer, query)));
    const matches = answers.flatMap((a, i) => (a.status === 'fulfilled'
      ? a.value.matches.slice(0, 8).map((m) => ({ ...m, peerId: peers[i].peerId }))
      : []));
    return { searchedPeers: peers.length, tracks: buildConsensus(query, matches, this.state.config.trust) };
  }

  /** Recommendations for a seed: peers propose, this machine ranks; only what the catalog lacks. */
  async recommend(seed: RecommendSeed, options: { algorithms?: Array<{ algorithm: RankingAlgorithm; weight: number }>; limit?: number } = {}): Promise<Ranked[]> {
    const peers = this.usablePeers('recommendations-v1');
    const answers = await Promise.allSettled(peers.map((peer) => this.lookup.recommend(peer, seed)));
    const candidates = mergeCandidates(answers.flatMap((a, i) => (a.status === 'fulfilled' ? [{ peerId: peers[i].peerId, tracks: a.value.tracks }] : [])));
    return rankRecommendations(seed, candidates, {
      algorithms: options.algorithms,
      limit: options.limit,
      isOwned: (c) => this.catalog?.has(c) ?? false,
    });
  }
}
