/**
 * A Tape Network node's mesh Iroh endpoint (same framed protocol as Tape Hub's mesh node).
 *
 * Wire: one bidirectional stream per session, frames = 4-byte big-endian length + JSON.
 * Requests (one reply frame each, up to MAX_REQUESTS_PER_SESSION per session):
 *   ["EVENT", event]                → ["OK", id, ok, reason, reply?]
 *   ["REQ", sub, filter]            → ["EVENTS", sub, events] | ["CLOSED", sub, reason]
 *   ["HEALTH", nonce, relayUrl]     → ["HEALTH", sig]
 * REQ is limited to public relay offers, opt-in discovery listings and exact presence
 * lookups (locator + author).
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  MESH_KIND_DISCOVERY_LISTING,
  MESH_KIND_HUB_PRESENCE,
  MESH_KIND_RELAY_OFFER,
  MESH_MAX_EVENT_BYTES,
  irohEndpointIdToHex,
  normalizeMeshUrl,
  signMeshHealthChallenge,
  type NostrEvent,
} from '../protocol/mesh.js';
import type { MeshNostrRelay, NostrFilter } from './store.js';

export const MESH_NODE_KEY_FILE = 'mesh-iroh-key.bin';
export const DEFAULT_MESH_UDP_PORT = 42426;
const MAX_FRAME_BYTES = MESH_MAX_EVENT_BYTES + 1024;
const MAX_REPLY_BYTES = 512 * 1024;
const MAX_REQUESTS_PER_SESSION = 16;
const SESSIONS_PER_MINUTE_PER_PEER = 60;
const MAX_TRACKED_PEERS = 4096;
const MAX_CONCURRENT_SESSIONS = 64;
const SESSION_TIMEOUT_MS = 15_000;
const CLIENT_TIMEOUT_MS = 10_000;

type NativeStream = { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
type NativeSession = {
  remoteId?: { toString(): string } | string;
  close?: (info?: { closeCode: number; reason: string }) => void;
  incomingBidirectionalStreams?: ReadableStream<NativeStream>;
  createBidirectionalStream?: () => Promise<NativeStream>;
};
export type MeshIrohNode = {
  publicKey: { toString(): string; bytes?: Uint8Array };
  addr(): Promise<{ id: string; addrs: string[] }>;
  dial(nodeId: string, options?: { directAddrs?: string[]; relayUrl?: string }): Promise<NativeSession>;
  incoming(): AsyncIterable<unknown>;
  close(): Promise<void>;
};
export type MeshIrohNodeFactory = (options: Record<string, unknown>) => Promise<MeshIrohNode>;

export function loadOrCreateMeshNodeKey(dataDir: string): Uint8Array {
  const path = join(dataDir, MESH_NODE_KEY_FILE);
  if (existsSync(path)) {
    const bytes = readFileSync(path);
    if (bytes.byteLength === 32) return new Uint8Array(bytes);
  }
  const key = randomBytes(32);
  writeFileSync(path, key, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort on Windows */
  }
  return new Uint8Array(key);
}

/** Frame reader over one stream: next() returns the next frame or null at end/oversize. */
export function createFrameReader(stream: ReadableStream<Uint8Array>, maxFrame = MAX_FRAME_BYTES) {
  const reader = stream.getReader();
  let buffer = new Uint8Array(0);
  const append = (chunk: Uint8Array) => {
    const next = new Uint8Array(buffer.byteLength + chunk.byteLength);
    next.set(buffer);
    next.set(chunk, buffer.byteLength);
    buffer = next;
  };
  return {
    async next(): Promise<Uint8Array | null> {
      while (buffer.byteLength < 4) {
        const { value, done } = await reader.read();
        if (done || !value) return null;
        append(value);
      }
      const length = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0, false);
      if (length === 0 || length > maxFrame) return null;
      while (buffer.byteLength < 4 + length) {
        const { value, done } = await reader.read();
        if (done || !value) return null;
        append(value);
      }
      const frame = buffer.slice(4, 4 + length);
      buffer = buffer.slice(4 + length);
      return frame;
    },
    cancel(): void {
      void reader.cancel().catch(() => undefined);
    },
  };
}

export async function writeFrame(writer: WritableStreamDefaultWriter<Uint8Array>, message: unknown): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(message));
  const frame = new Uint8Array(4 + bytes.byteLength);
  new DataView(frame.buffer).setUint32(0, bytes.byteLength, false);
  frame.set(bytes, 4);
  await writer.write(frame);
}

function parseFrame(frame: Uint8Array): unknown[] | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(frame)) as unknown;
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export type MeshNodeOptions = {
  dataDir: string;
  bindHost: string;
  udpPort: number;
  relay: MeshNostrRelay;
  nostrSecretKey: () => Uint8Array;
  /** Accepted events from a peer (base32 endpoint id, authenticated); may return a reply event. */
  onEvent?: (event: NostrEvent, peer: string) => Promise<NostrEvent | null>;
  createNode?: MeshIrohNodeFactory;
};

export class MeshNode {
  private node: MeshIrohNode | null = null;
  private readonly rate = new Map<string, { windowStart: number; count: number }>();
  private activeSessions = 0;
  private stopped = false;

  constructor(private readonly options: MeshNodeOptions) {}

  endpointIdHex(): string | null {
    if (!this.node) return null;
    const bytes = this.node.publicKey.bytes;
    if (bytes) return Buffer.from(bytes).toString('hex');
    return irohEndpointIdToHex(this.node.publicKey.toString(), 'base32');
  }

  /** Bound UDP port (the configured one, or the ephemeral one picked by the OS for port 0). */
  async boundPort(): Promise<number | null> {
    const addrs = (await this.node?.addr().catch(() => null))?.addrs ?? [];
    for (const addr of addrs) {
      const match = /:(\d+)$/.exec(addr);
      if (match) return Number(match[1]);
    }
    return null;
  }

  async start(relaySet: string[]): Promise<void> {
    this.stopped = false;
    const createNode = this.options.createNode
      ?? ((await import('@momics/iroh-http-node')) as unknown as { createNode: MeshIrohNodeFactory }).createNode;
    const node = await createNode({
      key: loadOrCreateMeshNodeKey(this.options.dataDir),
      relay: relaySet.length > 0 ? { urls: relaySet } : { mode: 'disabled' },
      // No n0 DNS; LAN discovery is not used by the mesh.
      discovery: { dns: false, mdns: false },
      bindAddr: `${this.options.bindHost}:${this.options.udpPort}`,
    });
    this.node = node;
    void this.acceptLoop(node);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const node = this.node;
    this.node = null;
    await node?.close().catch(() => undefined);
  }

  async restart(relaySet: string[]): Promise<void> {
    await this.stop();
    await this.start(relaySet);
  }

  private allow(peer: string): boolean {
    const now = Date.now();
    const entry = this.rate.get(peer);
    if (!entry || now - entry.windowStart > 60_000) {
      if (this.rate.size >= MAX_TRACKED_PEERS) this.rate.clear();
      this.rate.set(peer, { windowStart: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= SESSIONS_PER_MINUTE_PER_PEER;
  }

  private async acceptLoop(node: MeshIrohNode): Promise<void> {
    try {
      for await (const raw of node.incoming()) {
        if (this.stopped) break;
        const session = raw as NativeSession;
        const peer = String(session.remoteId ?? '');
        if (!peer || this.activeSessions >= MAX_CONCURRENT_SESSIONS || !this.allow(peer)) {
          session.close?.({ closeCode: 1, reason: 'busy or rate limited' });
          continue;
        }
        this.activeSessions += 1;
        void this.serveSession(session, peer).finally(() => {
          this.activeSessions -= 1;
        });
      }
    } catch {
      /* node closed */
    }
  }

  private async serveSession(session: NativeSession, peer: string): Promise<void> {
    const streams = session.incomingBidirectionalStreams?.getReader();
    const timer = setTimeout(() => session.close?.({ closeCode: 1, reason: 'timeout' }), SESSION_TIMEOUT_MS);
    try {
      const { value: stream } = (await streams?.read()) ?? {};
      if (!stream) return;
      const frames = createFrameReader(stream.readable);
      const writer = stream.writable.getWriter();
      for (let i = 0; i < MAX_REQUESTS_PER_SESSION; i += 1) {
        const frame = await frames.next();
        if (!frame) break;
        await writeFrame(writer, await this.answer(parseFrame(frame), peer));
      }
      frames.cancel();
      await writer.close().catch(() => undefined);
    } catch {
      /* malformed or closed */
    } finally {
      clearTimeout(timer);
      session.close?.({ closeCode: 0, reason: 'done' });
    }
  }

  private async answer(message: unknown[] | null, peer: string): Promise<unknown[]> {
    if (!message || typeof message[0] !== 'string') return ['NOTICE', 'invalid: expected a NIP-01 message'];
    if (message[0] === 'EVENT') {
      const result = this.options.relay.publishLocal(message[1]);
      const id = result.event?.id ?? '';
      if (!result.ok || !result.event || !this.options.onEvent) return ['OK', id, result.ok, result.reason];
      const reply = await this.options.onEvent(result.event, peer).catch(() => null);
      return reply ? ['OK', id, true, result.reason, reply] : ['OK', id, true, result.reason];
    }
    if (message[0] === 'REQ') {
      const sub = typeof message[1] === 'string' && message[1].length <= 64 ? message[1] : '';
      const filters = this.options.relay.sanitizeFilters(message.slice(2, 3));
      const filter = filters?.[0];
      if (!sub || !filter?.kinds) return ['CLOSED', sub, 'invalid: filter'];
      const offersOnly = filter.kinds.every((kind) => kind === MESH_KIND_RELAY_OFFER || kind === MESH_KIND_DISCOVERY_LISTING);
      const exactPresence = filter.kinds.every((kind) => kind === MESH_KIND_HUB_PRESENCE)
        && Boolean(filter['#d']?.length && filter['#d'].length <= 4 && filter.authors?.length && filter.authors.length <= 4);
      if (!offersOnly && !exactPresence) return ['CLOSED', sub, 'blocked: public offers/listings or exact presence lookups only'];
      const limited: NostrFilter = { ...filter, limit: Math.min(filter.limit ?? 100, exactPresence ? 5 : 100) };
      let size = 0;
      const events = this.options.relay.query([limited]).filter((event) => (size += JSON.stringify(event).length) <= MAX_REPLY_BYTES);
      return ['EVENTS', sub, events];
    }
    if (message[0] === 'HEALTH') {
      const nonce = typeof message[1] === 'string' ? message[1] : '';
      const target = normalizeMeshUrl(message[2], ['http:', 'https:']);
      if (!/^[0-9a-f]{32}$/.test(nonce) || !target) return ['NOTICE', 'invalid: health'];
      return ['HEALTH', signMeshHealthChallenge(target, nonce, this.options.nostrSecretKey())];
    }
    return ['NOTICE', `unsupported: ${String(message[0]).slice(0, 16)}`];
  }

  /** Send framed requests to another mesh node and collect one reply per request. */
  async request(
    endpointIdBase32: string,
    messages: unknown[][],
    route: { directAddrs?: string[]; relayUrl?: string | null },
  ): Promise<unknown[][]> {
    const node = this.node;
    if (!node) throw new Error('mesh node not running');
    const session = await withTimeout(
      node.dial(endpointIdBase32, { directAddrs: route.directAddrs, relayUrl: route.relayUrl ?? undefined }),
      CLIENT_TIMEOUT_MS,
    );
    try {
      const stream = await withTimeout(session.createBidirectionalStream!(), CLIENT_TIMEOUT_MS);
      const writer = stream.writable.getWriter();
      const frames = createFrameReader(stream.readable, MAX_REPLY_BYTES + 1024);
      const replies: unknown[][] = [];
      for (const message of messages.slice(0, MAX_REQUESTS_PER_SESSION)) {
        await writeFrame(writer, message);
        const frame = await withTimeout(frames.next(), CLIENT_TIMEOUT_MS);
        const reply = frame ? parseFrame(frame) : null;
        if (!reply) break;
        replies.push(reply);
      }
      await writer.close().catch(() => undefined);
      return replies;
    } finally {
      session.close?.({ closeCode: 0, reason: 'done' });
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('mesh request timed out')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
