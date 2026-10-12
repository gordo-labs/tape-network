/**
 * Lookup endpoint: iroh-http on its own Iroh identity. `Peer-Id` is injected by
 * iroh-http from the authenticated QUIC peer (client values are stripped), so access
 * control is a local decision on an authenticated identity: deny by default, approved
 * peers only, per-peer rate limit, nonce replay window, bounded bodies and answers.
 */
import { randomUUID } from 'node:crypto';
import {
  LOOKUP_PATH,
  MAX_MATCHES,
  MAX_PACKET_BYTES,
  MAX_RECOMMEND_PACKET_BYTES,
  PROTOCOL_VERSION,
  RECOMMEND_PATH,
  SOURCE_PLUGIN_ID,
  isPeerId,
  parseLookupRequest,
  parseLookupResponse,
  parseRecommendRequest,
  parseRecommendResponse,
  publicTrackId,
  type LookupMatch,
  type LookupQuery,
  type MetadataPacket,
  type RecommendSeed,
} from '../protocol/lookup.js';
import type { CatalogSource, CatalogTrack } from '../catalog/catalog.js';

type IrohNode = {
  publicKey: { toString(): string; bytes?: Uint8Array };
  addr(): Promise<{ id: string; addrs: string[] }>;
  fetch(input: string, init?: RequestInit & { directAddrs?: string[]; relayUrl?: string; requestTimeout?: number; maxResponseBodyBytes?: number }): Promise<Response>;
  serve(options: Record<string, unknown>, handler: (request: Request) => Response | Promise<Response>): { close(): Promise<void> };
  close(): Promise<void>;
};

export type LookupPeer = { peerId: string; hubName?: string; directAddrs?: string[]; relayUrl?: string };

const REQUESTS_PER_MINUTE = 30;
const REPLAY_WINDOW_MS = 5 * 60_000;
const TIMEOUT_MS = 5_000;

function packetFor(track: CatalogTrack, peerId: string, hubName: string): MetadataPacket {
  const identities = track.identities.slice(0, 3);
  return {
    trackId: publicTrackId(identities, peerId),
    identities,
    title: track.title,
    artist: track.artist,
    album: track.album ?? null,
    albumArtist: track.albumArtist ?? null,
    year: track.year ?? null,
    genre: track.genre ?? null,
    bpm: track.bpm ?? null,
    musicalKey: track.musicalKey ?? null,
    label: track.label ?? null,
    duration: track.duration ?? null,
    format: track.format ?? null,
    source: { hubId: peerId, hubName, pluginId: SOURCE_PLUGIN_ID },
  };
}

async function readBoundedJson(body: ReadableStream<Uint8Array> | null, max: number): Promise<unknown> {
  if (!body) throw new Error('empty body');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error('too large');
    }
    chunks.push(value);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

export type LookupEndpointOptions = {
  catalog: () => CatalogSource | null;
  hubName: () => string;
  isApproved: (peerId: string) => boolean;
  isBlocked: (peerId: string) => boolean;
};

export class LookupEndpoint {
  private node: IrohNode | null = null;
  private server: { close(): Promise<void> } | null = null;
  private readonly counts = new Map<string, { count: number; resetAt: number }>();
  private readonly nonces = new Map<string, Map<string, number>>();

  constructor(private readonly options: LookupEndpointOptions) {}

  peerId(): string | null {
    return this.node ? String(this.node.publicKey) : null;
  }

  peerIdHex(): string | null {
    const bytes = this.node?.publicKey.bytes;
    return bytes ? Buffer.from(bytes).toString('hex') : null;
  }

  async addrs(): Promise<string[]> {
    return (await this.node?.addr().catch(() => null))?.addrs ?? [];
  }

  async start(nodeOptions: Record<string, unknown>): Promise<void> {
    const { createNode } = (await import('@momics/iroh-http-node')) as unknown as {
      createNode(options: Record<string, unknown>): Promise<IrohNode>;
    };
    this.node = await createNode(nodeOptions);
    this.server = this.node.serve({
      maxConcurrency: 8,
      maxConnectionsPerPeer: 2,
      requestTimeout: TIMEOUT_MS,
      maxRequestBodyWireBytes: MAX_PACKET_BYTES,
      maxRequestBodyDecodedBytes: MAX_PACKET_BYTES,
      maxTotalConnections: 32,
      loadShed: true,
    }, (request) => this.handle(request));
  }

  async stop(): Promise<void> {
    await this.server?.close().catch(() => undefined);
    await this.node?.close().catch(() => undefined);
    this.server = null;
    this.node = null;
  }

  private allow(peer: string): boolean {
    const now = Date.now();
    const entry = this.counts.get(peer);
    if (!entry || entry.resetAt <= now) {
      if (this.counts.size > 1024) this.counts.clear();
      this.counts.set(peer, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    return ++entry.count <= REQUESTS_PER_MINUTE;
  }

  private fresh(peer: string, nonce: string | undefined): boolean {
    if (!nonce) return true;
    const now = Date.now();
    const seen = this.nonces.get(peer) ?? new Map<string, number>();
    for (const [n, exp] of seen) if (exp <= now) seen.delete(n);
    if (seen.has(nonce) || seen.size >= 64) return false;
    seen.set(nonce, now + REPLAY_WINDOW_MS);
    this.nonces.set(peer, seen);
    return true;
  }

  private async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST' || (path !== LOOKUP_PATH && path !== RECOMMEND_PATH)) return Response.json({ error: 'not_found' }, { status: 404 });
    const peer = request.headers.get('Peer-Id') ?? '';
    if (!isPeerId(peer) || this.options.isBlocked(peer) || !this.options.isApproved(peer)) return Response.json({ error: 'peer_not_approved' }, { status: 403 });
    if (!this.allow(peer)) return Response.json({ error: 'rate_limited' }, { status: 429 });
    const catalog = this.options.catalog();
    const self = this.peerId() ?? 'local';
    const hubName = this.options.hubName().slice(0, 128) || 'Tape Network node';
    try {
      const body = await readBoundedJson(request.body, path === RECOMMEND_PATH ? MAX_RECOMMEND_PACKET_BYTES : MAX_PACKET_BYTES);
      if (path === LOOKUP_PATH) {
        const req = parseLookupRequest(body);
        if (!this.fresh(peer, req.nonce)) return Response.json({ error: 'replayed_request' }, { status: 409 });
        const tracks = catalog?.lookup(req.query, MAX_MATCHES) ?? [];
        const matches: LookupMatch[] = tracks.map((track) => ({
          peerId: self,
          confidence: req.query.identity || req.query.isrc || req.query.recordingId ? 1 : 0.6,
          matchedBy: req.query.identity ? ['canonical-identity'] : ['title', 'artist'],
          metadata: packetFor(track, self, hubName),
        }));
        return Response.json({ version: PROTOCOL_VERSION, ...(req.nonce ? { nonce: req.nonce } : {}), peerId: self, hubName, matches });
      }
      const req = parseRecommendRequest(body);
      if (!this.fresh(peer, req.nonce)) return Response.json({ error: 'replayed_request' }, { status: 409 });
      const tracks = (catalog?.related(req.seed, req.limit ?? 25) ?? []).slice(0, req.limit ?? 25);
      return Response.json({ version: PROTOCOL_VERSION, nonce: req.nonce, peerId: self, hubName, tracks: tracks.map((t) => packetFor(t, self, hubName)) });
    } catch {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
  }

  private async post(peer: LookupPeer, path: string, body: unknown, maxBytes: number): Promise<unknown> {
    if (!this.node) throw new Error('lookup endpoint not running');
    if (!isPeerId(peer.peerId)) throw new Error('invalid peer');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await this.node.fetch(`httpi://${peer.peerId}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        directAddrs: peer.directAddrs?.length ? peer.directAddrs : undefined,
        relayUrl: peer.relayUrl,
        requestTimeout: TIMEOUT_MS,
        maxResponseBodyBytes: maxBytes,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`peer returned ${response.status}`);
      return await readBoundedJson(response.body, maxBytes);
    } finally {
      clearTimeout(timer);
    }
  }

  async lookup(peer: LookupPeer, query: LookupQuery) {
    const nonce = randomUUID();
    return parseLookupResponse(await this.post(peer, LOOKUP_PATH, { version: PROTOCOL_VERSION, nonce, query }, MAX_PACKET_BYTES), peer.peerId, nonce);
  }

  async recommend(peer: LookupPeer, seed: RecommendSeed, limit = 25) {
    const nonce = randomUUID();
    return parseRecommendResponse(
      await this.post(peer, RECOMMEND_PATH, { version: PROTOCOL_VERSION, nonce, seed, limit }, MAX_RECOMMEND_PACKET_BYTES),
      peer.peerId,
      nonce,
    );
  }
}
