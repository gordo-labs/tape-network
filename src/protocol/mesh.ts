/**
 * Tape Network / Hub Mesh wire format (shared with Tape Hub, kept byte-compatible).
 *
 * Hubs are the only relays and presence servers. Each Hub runs:
 * - an `iroh-relay` (packets stay end-to-end encrypted by Iroh QUIC), and
 * - a small Nostr relay for mesh control events.
 *
 * This module is pure (no I/O) and shared verbatim by desktop and mobile:
 * NIP-01 events (BIP-340 Schnorr over secp256k1), NIP-44 v2 payload encryption,
 * the Music Hub ↔ Nostr key binding and every mesh event schema.
 *
 * Security rules encoded here:
 * - every event is size-bounded, schema-checked and signature-verified;
 * - every mesh event carries a NIP-40 expiration no further than its kind allows;
 * - private payloads (presence, relay grants) are NIP-44 encrypted;
 * - nothing in an event grants access by itself: the Hub/relay decides locally.
 */

import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { ed25519 } from '@noble/curves/ed25519';
import { chacha20 } from '@noble/ciphers/chacha';
import { equalBytes } from '@noble/ciphers/utils';
import { extract as hkdfExtract, expand as hkdfExpand } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils';

// ---------------------------------------------------------------------------
// Kinds and limits
// ---------------------------------------------------------------------------

/** Addressable (NIP-01 30000–39999): public relay offer of a Relay Hub. */
export const MESH_KIND_RELAY_OFFER = 30561;
/** Addressable: encrypted signed Sovereign presence for the Hub's own devices/peers. */
export const MESH_KIND_HUB_PRESENCE = 30562;
/** Addressable: opt-in public listing of a Hub's Tape Discovery service (metadata search). */
export const MESH_KIND_DISCOVERY_LISTING = 30563;
/** Ephemeral (20000–29999): encrypted relay grant request to a Relay Hub. */
export const MESH_KIND_RELAY_GRANT_REQUEST = 25561;
/** Ephemeral: encrypted relay grant response from a Relay Hub. */
export const MESH_KIND_RELAY_GRANT_RESPONSE = 25562;
/** Ephemeral: ask a Relay Hub to probe the requester's public mesh URL. */
export const MESH_KIND_REACHABILITY_PROBE_REQUEST = 25563;
/** Ephemeral: probe result. */
export const MESH_KIND_REACHABILITY_PROBE_RESPONSE = 25564;

export const MESH_KINDS = [
  MESH_KIND_RELAY_OFFER,
  MESH_KIND_HUB_PRESENCE,
  MESH_KIND_DISCOVERY_LISTING,
  MESH_KIND_RELAY_GRANT_REQUEST,
  MESH_KIND_RELAY_GRANT_RESPONSE,
  MESH_KIND_REACHABILITY_PROBE_REQUEST,
  MESH_KIND_REACHABILITY_PROBE_RESPONSE,
] as const;

export type MeshKind = (typeof MESH_KINDS)[number];

/** Maximum lifetime (seconds) of each kind; events must expire within it. */
export const MESH_KIND_MAX_TTL_SECONDS: Record<MeshKind, number> = {
  [MESH_KIND_RELAY_OFFER]: 6 * 60 * 60,
  [MESH_KIND_HUB_PRESENCE]: 15 * 60,
  [MESH_KIND_DISCOVERY_LISTING]: 60 * 60,
  [MESH_KIND_RELAY_GRANT_REQUEST]: 120,
  [MESH_KIND_RELAY_GRANT_RESPONSE]: 120,
  [MESH_KIND_REACHABILITY_PROBE_REQUEST]: 60,
  [MESH_KIND_REACHABILITY_PROBE_RESPONSE]: 60,
};

export const MESH_MAX_EVENT_BYTES = 16 * 1024;
export const MESH_MAX_CONTENT_BYTES = 12 * 1024;
export const MESH_MAX_TAGS = 16;
export const MESH_MAX_CLOCK_SKEW_SECONDS = 5 * 60;
export const MESH_MAX_ENDPOINT_IDS_PER_GRANT = 64;
export const MESH_BINDING_DOMAIN = 'tape-hub-mesh-binding/1';
export const MESH_PRESENCE_LOCATOR_DOMAIN = 'tape-hub-mesh-presence-locator/1';
/**
 * The mesh control plane runs only over Iroh (QUIC, peers authenticated by endpoint key):
 * Hubs talk iroh-http to each other's mesh endpoint; mobile uses framed duplex streams.
 * The public TCP port serves only iroh-relay (deny by default) and WHOAMI.
 */
export const MESH_IROH_NOSTR_PATH = '/tape-mesh/1/nostr';
export const MESH_IROH_HEALTH_PATH = '/tape-mesh/1/health';
/** Public TCP: tells a caller the address it connects from (no state, no data). */
export const MESH_WHOAMI_PATH = '/tape-mesh/whoami';
/** iroh-relay's own probe endpoint, used to check a relay URL answers. */
export const IROH_RELAY_PROBE_PATH = '/ping';
export const MESH_MAX_MESH_ADDRS = 4;

// ---------------------------------------------------------------------------
// Encoding helpers (no Buffer: must run on React Native)
// ---------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i += 1) table[B64.charCodeAt(i)] = i;
  return table;
})();

export function meshBytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[n & 63] : '=';
  }
  return out;
}

export function meshBase64ToBytes(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error('invalid base64');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((value.length / 4) * 3 - padding);
  let o = 0;
  for (let i = 0; i < value.length; i += 4) {
    const n =
      (B64_LOOKUP[value.charCodeAt(i)] << 18) |
      (B64_LOOKUP[value.charCodeAt(i + 1)] << 12) |
      ((value[i + 2] === '=' ? 0 : B64_LOOKUP[value.charCodeAt(i + 2)]) << 6) |
      (value[i + 3] === '=' ? 0 : B64_LOOKUP[value.charCodeAt(i + 3)]);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

export function meshBytesToBase64Url(bytes: Uint8Array): string {
  return meshBytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function meshBase64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('invalid base64url');
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return meshBase64ToBytes(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function utf8Decode(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes);
}

function isHex(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && value.length === bytes * 2 && /^[0-9a-f]+$/.test(value);
}

// ---------------------------------------------------------------------------
// NIP-01 events
// ---------------------------------------------------------------------------

export type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

export type UnsignedNostrEvent = Omit<NostrEvent, 'id' | 'pubkey' | 'sig'>;

export function generateNostrSecretKey(): Uint8Array {
  return secp256k1.utils.randomPrivateKey();
}

export function nostrPublicKey(secretKey: Uint8Array): string {
  return bytesToHex(schnorr.getPublicKey(secretKey));
}

export function nostrEventHash(event: Omit<NostrEvent, 'id' | 'sig'>): string {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  return bytesToHex(sha256(utf8ToBytes(serialized)));
}

export function signNostrEvent(unsigned: UnsignedNostrEvent, secretKey: Uint8Array): NostrEvent {
  const pubkey = nostrPublicKey(secretKey);
  const base = { ...unsigned, pubkey };
  const id = nostrEventHash(base);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secretKey));
  return { ...base, id, sig };
}

/** Structural NIP-01 check plus id and signature verification. */
export function verifyNostrEvent(event: unknown): event is NostrEvent {
  if (!event || typeof event !== 'object') return false;
  const e = event as Partial<NostrEvent>;
  if (!isHex(e.id, 32) || !isHex(e.pubkey, 32) || !isHex(e.sig, 64)) return false;
  if (!Number.isSafeInteger(e.created_at) || (e.created_at as number) < 0) return false;
  if (!Number.isSafeInteger(e.kind) || (e.kind as number) < 0 || (e.kind as number) > 65535) return false;
  if (typeof e.content !== 'string') return false;
  if (!Array.isArray(e.tags) || e.tags.length > MESH_MAX_TAGS * 4) return false;
  for (const tag of e.tags) {
    if (!Array.isArray(tag) || tag.length === 0 || tag.some((v) => typeof v !== 'string')) return false;
  }
  try {
    if (nostrEventHash(e as NostrEvent) !== e.id) return false;
    return schnorr.verify(hexToBytes(e.sig as string), hexToBytes(e.id as string), hexToBytes(e.pubkey as string));
  } catch {
    return false;
  }
}

export function eventTag(event: Pick<NostrEvent, 'tags'>, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

export function eventExpiration(event: Pick<NostrEvent, 'tags'>): number | null {
  const value = eventTag(event, 'expiration');
  if (!value || !/^\d{1,12}$/.test(value)) return null;
  return Number(value);
}

export function isAddressableKind(kind: number): boolean {
  return kind >= 30000 && kind < 40000;
}

export function isEphemeralKind(kind: number): boolean {
  return kind >= 20000 && kind < 30000;
}

export function isMeshKind(kind: number): kind is MeshKind {
  return (MESH_KINDS as readonly number[]).includes(kind);
}

export type MeshEventCheck = { ok: true; event: NostrEvent } | { ok: false; reason: string };

/**
 * Full admission check for a mesh event: size, NIP-01 signature, kind, tags,
 * clock skew and mandatory bounded NIP-40 expiration.
 */
export function checkMeshEvent(raw: unknown, nowSeconds = Math.floor(Date.now() / 1000)): MeshEventCheck {
  let size = 0;
  try {
    size = utf8ToBytes(JSON.stringify(raw)).length;
  } catch {
    return { ok: false, reason: 'invalid: not serializable' };
  }
  if (size > MESH_MAX_EVENT_BYTES) return { ok: false, reason: 'invalid: event too large' };
  if (!verifyNostrEvent(raw)) return { ok: false, reason: 'invalid: bad signature or shape' };
  const event = raw;
  if (!isMeshKind(event.kind)) return { ok: false, reason: 'blocked: kind not accepted' };
  if (event.tags.length > MESH_MAX_TAGS) return { ok: false, reason: 'invalid: too many tags' };
  if (utf8ToBytes(event.content).length > MESH_MAX_CONTENT_BYTES) {
    return { ok: false, reason: 'invalid: content too large' };
  }
  if (event.created_at > nowSeconds + MESH_MAX_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'invalid: created_at in the future' };
  }
  const expiration = eventExpiration(event);
  if (expiration === null) return { ok: false, reason: 'invalid: expiration required' };
  if (expiration <= nowSeconds) return { ok: false, reason: 'invalid: expired' };
  if (expiration - event.created_at > MESH_KIND_MAX_TTL_SECONDS[event.kind]) {
    return { ok: false, reason: 'invalid: expiration too far' };
  }
  if (isAddressableKind(event.kind) && !eventTag(event, 'd')) {
    return { ok: false, reason: 'invalid: missing d tag' };
  }
  return { ok: true, event };
}

// ---------------------------------------------------------------------------
// NIP-44 v2
// ---------------------------------------------------------------------------

const NIP44_SALT = utf8ToBytes('nip44-v2');
const NIP44_MAX_PLAINTEXT = 65535;

export function nip44ConversationKey(secretKey: Uint8Array, peerPublicKeyHex: string): Uint8Array {
  const shared = secp256k1.getSharedSecret(secretKey, hexToBytes('02' + peerPublicKeyHex));
  return hkdfExtract(sha256, shared.subarray(1, 33), NIP44_SALT);
}

export function nip44PaddedLength(length: number): number {
  if (!Number.isSafeInteger(length) || length < 1) throw new Error('invalid plaintext length');
  if (length <= 32) return 32;
  const nextPower = 1 << (Math.floor(Math.log2(length - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((length - 1) / chunk) + 1);
}

function nip44MessageKeys(conversationKey: Uint8Array, nonce: Uint8Array) {
  if (conversationKey.length !== 32) throw new Error('invalid conversation key');
  if (nonce.length !== 32) throw new Error('invalid nonce');
  const keys = hkdfExpand(sha256, conversationKey, nonce, 76);
  return {
    chachaKey: keys.subarray(0, 32),
    chachaNonce: keys.subarray(32, 44),
    hmacKey: keys.subarray(44, 76),
  };
}

export function nip44Encrypt(
  plaintext: string,
  conversationKey: Uint8Array,
  nonce: Uint8Array = randomBytes(32),
): string {
  const bytes = utf8ToBytes(plaintext);
  if (bytes.length < 1 || bytes.length > NIP44_MAX_PLAINTEXT) throw new Error('invalid plaintext length');
  const { chachaKey, chachaNonce, hmacKey } = nip44MessageKeys(conversationKey, nonce);
  const padded = new Uint8Array(2 + nip44PaddedLength(bytes.length));
  new DataView(padded.buffer).setUint16(0, bytes.length, false);
  padded.set(bytes, 2);
  const ciphertext = chacha20(chachaKey, chachaNonce, padded);
  const mac = hmac(sha256, hmacKey, concatBytes(nonce, ciphertext));
  return meshBytesToBase64(concatBytes(new Uint8Array([2]), nonce, ciphertext, mac));
}

export function nip44Decrypt(payload: string, conversationKey: Uint8Array): string {
  if (typeof payload !== 'string' || payload.length < 132 || payload.length > 87472) {
    throw new Error('invalid payload length');
  }
  if (payload[0] === '#') throw new Error('unknown encryption version');
  const data = meshBase64ToBytes(payload);
  if (data.length < 99 || data.length > 65603) throw new Error('invalid data length');
  if (data[0] !== 2) throw new Error('unknown encryption version');
  const nonce = data.subarray(1, 33);
  const ciphertext = data.subarray(33, data.length - 32);
  const mac = data.subarray(data.length - 32);
  const { chachaKey, chachaNonce, hmacKey } = nip44MessageKeys(conversationKey, nonce);
  const expected = hmac(sha256, hmacKey, concatBytes(nonce, ciphertext));
  if (!equalBytes(expected, mac)) throw new Error('invalid MAC');
  const padded = chacha20(chachaKey, chachaNonce, ciphertext);
  const length = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint16(0, false);
  if (length < 1 || padded.length !== 2 + nip44PaddedLength(length)) throw new Error('invalid padding');
  return utf8Decode(padded.subarray(2, 2 + length));
}

// ---------------------------------------------------------------------------
// Music Hub ↔ Nostr key binding
// ---------------------------------------------------------------------------

export type MeshHubBinding = {
  hubId: string;
  /** Base64url raw Ed25519 Sovereign hub public key. */
  hubPublicKey: string;
  /** Base64url Ed25519 signature over the binding message. */
  signature: string;
};

export function meshBindingMessage(hubId: string, nostrPubkey: string): Uint8Array {
  return utf8ToBytes(`${MESH_BINDING_DOMAIN}|${hubId.toLowerCase()}|${nostrPubkey.toLowerCase()}`);
}

export function meshBindingTag(binding: MeshHubBinding): string[] {
  return ['tape-hub', binding.hubId, binding.hubPublicKey, binding.signature];
}

/** Hub id derivation must match `deriveSovereignHubId`: first 16 bytes of sha256(publicKey) as hex. */
export function meshHubIdFromPublicKey(hubPublicKey: string): string {
  return bytesToHex(sha256(meshBase64UrlToBytes(hubPublicKey)).subarray(0, 16));
}

/** Verify the `tape-hub` tag binds the event's Nostr pubkey to a Sovereign hub identity. */
export function verifyMeshBinding(event: NostrEvent): MeshHubBinding | null {
  const tag = event.tags.find((entry) => entry[0] === 'tape-hub');
  if (!tag || tag.length !== 4) return null;
  const [, hubId, hubPublicKey, signature] = tag;
  try {
    if (!/^[a-f0-9]{16,64}$/.test(hubId)) return null;
    const publicKey = meshBase64UrlToBytes(hubPublicKey);
    if (publicKey.length !== 32) return null;
    if (meshHubIdFromPublicKey(hubPublicKey) !== hubId) return null;
    const ok = ed25519.verify(meshBase64UrlToBytes(signature), meshBindingMessage(hubId, event.pubkey), publicKey);
    return ok ? { hubId, hubPublicKey, signature } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mesh payloads
// ---------------------------------------------------------------------------

export type MeshRelayScope = 'self' | 'mesh';

/** Public offer of a Relay Hub (content of MESH_KIND_RELAY_OFFER). */
export type MeshRelayOffer = {
  v: 2;
  /** iroh-relay URL served by this Hub. */
  relayUrl: string;
  /** Hex Iroh endpoint id of this Hub's mesh node (control plane). */
  meshEndpointId: string;
  /** Public `ip:port` (UDP) of the mesh node, so peers dial it directly without a relay grant. */
  meshAddrs: string[];
  scopes: MeshRelayScope[];
  maxHubs: number;
  maxDevicesPerHub: number;
  irohRelayVersion: string;
};

/** Content of MESH_KIND_RELAY_GRANT_REQUEST (NIP-44 to the Relay Hub). */
export type MeshRelayGrantRequest = {
  v: 1;
  requestId: string;
  /** Iroh endpoint ids sponsored by the requesting Hub: its own and its paired devices. */
  endpointIds: string[];
};

/** Content of MESH_KIND_RELAY_GRANT_RESPONSE (NIP-44 to the requester). */
export type MeshRelayGrantResponse = {
  v: 1;
  requestId: string;
  ok: boolean;
  reason?: string;
  relayUrl?: string;
  /** Unix seconds; the requester must renew before this. */
  grantExpiresAt?: number;
  acceptedEndpointIds?: number;
};

/** Content of MESH_KIND_REACHABILITY_PROBE_REQUEST. */
export type MeshProbeRequest = {
  v: 2;
  requestId: string;
  /** Requester's iroh-relay URL (checked with GET /ping). */
  relayUrl: string;
  /** Requester's mesh node `ip:port` (dialed directly, must answer as the requester). */
  meshAddr: string;
  nonce: string;
};
/** Content of MESH_KIND_REACHABILITY_PROBE_RESPONSE. */
export type MeshProbeResponse = { v: 1; requestId: string; reachable: boolean; reason?: string };

/** Mesh events carry Iroh endpoint ids as lowercase hex. */
const IROH_ENDPOINT_ID = /^[0-9a-f]{64}$/;

export function isIrohEndpointId(value: unknown): value is string {
  return typeof value === 'string' && IROH_ENDPOINT_ID.test(value);
}

const Z32_ALPHABET = 'ybndrfg8ejkmcpqxot1uwisza345h769';
const RFC4648_BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function decodeBase32Key(value: string, alphabet: string): string | null {
  const id = value.trim().toLowerCase();
  if (id.length !== 52) return null;
  const out = new Uint8Array(32);
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of id) {
    const v = alphabet.indexOf(char);
    if (v < 0) return null;
    buffer = (buffer << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      if (index < 32) out[index] = (buffer >> bits) & 0xff;
      index += 1;
      buffer &= (1 << bits) - 1;
    }
  }
  if (index !== 32 || buffer !== 0) return null;
  return bytesToHex(out);
}

/**
 * Mesh wire format and iroh-relay use hex endpoint ids. Iroh SDKs print other encodings:
 * `@momics/iroh-http-node` uses RFC 4648 base32, Iroh's `to_z32()` (React Native bridge) z-base-32.
 */
export function irohEndpointIdToHex(value: string, encoding: 'hex' | 'base32' | 'z32'): string | null {
  const id = value.trim().toLowerCase();
  if (encoding === 'hex') return /^[0-9a-f]{64}$/.test(id) ? id : null;
  return decodeBase32Key(id, encoding === 'z32' ? Z32_ALPHABET : RFC4648_BASE32_ALPHABET);
}

/** Hex endpoint id → the encoding an Iroh SDK expects (`base32` for iroh-http URLs, `z32` for Iroh's own). */
export function irohEndpointIdFromHex(hex: string, encoding: 'base32' | 'z32'): string | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const alphabet = encoding === 'z32' ? Z32_ALPHABET : RFC4648_BASE32_ALPHABET;
  const bytes = hexToBytes(hex);
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += alphabet[(buffer << (5 - bits)) & 31];
  return out;
}

/** Mesh URLs: https anywhere, plain http only to an IP literal or hostname with explicit port (Hub-served). */
export function normalizeMeshUrl(value: unknown, protocols: Array<'http:' | 'https:' | 'ws:' | 'wss:'>): string | null {
  if (typeof value !== 'string' || value.length > 512) return null;
  try {
    const url = new URL(value.trim());
    if (!(protocols as string[]).includes(url.protocol)) return null;
    if (url.username || url.password || url.hash || url.search) return null;
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** `ip:port` literal (IPv4 or bracketed IPv6) — never a hostname, never a URL. */
export function normalizeMeshSocketAddr(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(value);
  const v6 = /^\[([0-9a-fA-F:]{2,39})\]:(\d{1,5})$/.exec(value);
  const port = Number(v4 ? v4[5] : v6 ? v6[2] : NaN);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (v4) return v4.slice(1, 5).every((part) => Number(part) <= 255) ? value : null;
  return v6 && v6[1].includes(':') ? value.toLowerCase() : null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseMeshRelayOffer(event: NostrEvent): MeshRelayOffer | null {
  if (event.kind !== MESH_KIND_RELAY_OFFER) return null;
  const raw = parseJsonObject(event.content);
  if (!raw || raw.v !== 2) return null;
  const relayUrl = normalizeMeshUrl(raw.relayUrl, ['http:', 'https:']);
  const meshEndpointId = isIrohEndpointId(raw.meshEndpointId) ? raw.meshEndpointId : null;
  const meshAddrs = Array.isArray(raw.meshAddrs)
    ? raw.meshAddrs.map(normalizeMeshSocketAddr).filter((a): a is string => Boolean(a)).slice(0, MESH_MAX_MESH_ADDRS)
    : [];
  if (!relayUrl || !meshEndpointId || meshAddrs.length === 0) return null;
  const scopes = Array.isArray(raw.scopes)
    ? raw.scopes.filter((s): s is MeshRelayScope => s === 'self' || s === 'mesh')
    : [];
  const maxHubs = Number(raw.maxHubs);
  const maxDevicesPerHub = Number(raw.maxDevicesPerHub);
  if (!Number.isSafeInteger(maxHubs) || maxHubs < 0 || maxHubs > 10_000) return null;
  if (!Number.isSafeInteger(maxDevicesPerHub) || maxDevicesPerHub < 0 || maxDevicesPerHub > 256) return null;
  const irohRelayVersion = typeof raw.irohRelayVersion === 'string' ? raw.irohRelayVersion.slice(0, 32) : '';
  return { v: 2, relayUrl, meshEndpointId, meshAddrs, scopes, maxHubs, maxDevicesPerHub, irohRelayVersion };
}

export function parseMeshRelayGrantRequest(text: string): MeshRelayGrantRequest | null {
  const raw = parseJsonObject(text);
  if (!raw || raw.v !== 1 || typeof raw.requestId !== 'string' || raw.requestId.length > 64) return null;
  if (!Array.isArray(raw.endpointIds) || raw.endpointIds.length > MESH_MAX_ENDPOINT_IDS_PER_GRANT) return null;
  if (!raw.endpointIds.every(isIrohEndpointId)) return null;
  return { v: 1, requestId: raw.requestId, endpointIds: [...new Set(raw.endpointIds as string[])] };
}

export function parseMeshRelayGrantResponse(text: string): MeshRelayGrantResponse | null {
  const raw = parseJsonObject(text);
  if (!raw || raw.v !== 1 || typeof raw.requestId !== 'string' || typeof raw.ok !== 'boolean') return null;
  const relayUrl = raw.relayUrl === undefined ? undefined : normalizeMeshUrl(raw.relayUrl, ['http:', 'https:']) ?? undefined;
  return {
    v: 1,
    requestId: raw.requestId.slice(0, 64),
    ok: raw.ok,
    reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 200) : undefined,
    relayUrl,
    grantExpiresAt: Number.isSafeInteger(raw.grantExpiresAt) ? (raw.grantExpiresAt as number) : undefined,
    acceptedEndpointIds: Number.isSafeInteger(raw.acceptedEndpointIds) ? (raw.acceptedEndpointIds as number) : undefined,
  };
}

export function parseMeshProbeRequest(text: string): MeshProbeRequest | null {
  const raw = parseJsonObject(text);
  if (!raw || raw.v !== 2 || typeof raw.requestId !== 'string' || raw.requestId.length > 64) return null;
  const relayUrl = normalizeMeshUrl(raw.relayUrl, ['http:', 'https:']);
  const meshAddr = normalizeMeshSocketAddr(raw.meshAddr);
  if (!relayUrl || !meshAddr || !isHex(raw.nonce, 16)) return null;
  return { v: 2, requestId: raw.requestId, relayUrl, meshAddr, nonce: raw.nonce };
}

export function parseMeshProbeResponse(text: string): MeshProbeResponse | null {
  const raw = parseJsonObject(text);
  if (!raw || raw.v !== 1 || typeof raw.requestId !== 'string' || typeof raw.reachable !== 'boolean') return null;
  return {
    v: 1,
    requestId: raw.requestId.slice(0, 64),
    reachable: raw.reachable,
    reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 200) : undefined,
  };
}

/**
 * Content of MESH_KIND_DISCOVERY_LISTING. Published only while the Hub owner enables Tape
 * Discovery. Lists how to reach the Hub's discovery endpoint; never library data.
 */
export type MeshDiscoveryListing = {
  v: 1;
  service: 'tape-discovery';
  /** Hex Iroh endpoint id of the discovery endpoint (metadata lookups). */
  endpointId: string;
  /** Public `ip:port` candidates (may be empty for Hubs behind NAT). */
  addrs: string[];
  /** Relays where that endpoint is homed. */
  relayUrls: string[];
  capabilities: string[];
  /** Optional display name chosen by the owner. */
  name: string | null;
};

const DISCOVERY_CAPABILITIES = new Set(['metadata-search-v1', 'recommendations-v1']);

export function parseMeshDiscoveryListing(event: NostrEvent): MeshDiscoveryListing | null {
  if (event.kind !== MESH_KIND_DISCOVERY_LISTING || eventTag(event, 'd') !== 'tape-discovery') return null;
  const raw = parseJsonObject(event.content);
  if (!raw || raw.v !== 1 || raw.service !== 'tape-discovery' || !isIrohEndpointId(raw.endpointId)) return null;
  const addrs = (Array.isArray(raw.addrs) ? raw.addrs : [])
    .map(normalizeMeshSocketAddr)
    .filter((a): a is string => Boolean(a))
    .slice(0, MESH_MAX_MESH_ADDRS);
  const relayUrls = (Array.isArray(raw.relayUrls) ? raw.relayUrls : [])
    .map((url) => normalizeMeshUrl(url, ['http:', 'https:']))
    .filter((u): u is string => Boolean(u))
    .slice(0, 3);
  const capabilities = (Array.isArray(raw.capabilities) ? raw.capabilities : [])
    .filter((c): c is string => typeof c === 'string' && DISCOVERY_CAPABILITIES.has(c));
  if (capabilities.length === 0 || (addrs.length === 0 && relayUrls.length === 0)) return null;
  const name = typeof raw.name === 'string' && raw.name.trim()
    ? raw.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64)
    : null;
  return { v: 1, service: 'tape-discovery', endpointId: raw.endpointId, addrs, relayUrls, capabilities, name };
}

/** Message a Hub signs (Schnorr) to answer a reachability probe at MESH_IROH_HEALTH_PATH. */
export function meshHealthChallengeHash(url: string, nonce: string): Uint8Array {
  return sha256(utf8ToBytes(`tape-hub-mesh-health/1|${url}|${nonce}`));
}

export function signMeshHealthChallenge(url: string, nonce: string, secretKey: Uint8Array): string {
  return bytesToHex(schnorr.sign(meshHealthChallengeHash(url, nonce), secretKey));
}

export function verifyMeshHealthChallenge(url: string, nonce: string, pubkey: string, sig: string): boolean {
  try {
    return isHex(sig, 64) && isHex(pubkey, 32)
      && schnorr.verify(hexToBytes(sig), meshHealthChallengeHash(url, nonce), hexToBytes(pubkey));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Encrypted presence (devices and peers that hold the presence key)
// ---------------------------------------------------------------------------

/** Stable, unlinkable locator (`d` tag) for a Hub's presence, derived from the presence key. */
export function meshPresenceLocator(presenceKey: Uint8Array): string {
  if (presenceKey.length !== 32) throw new Error('invalid presence key');
  return bytesToHex(hmac(sha256, presenceKey, utf8ToBytes(MESH_PRESENCE_LOCATOR_DOMAIN)));
}

export function generateMeshPresenceKey(): Uint8Array {
  return randomBytes(32);
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Build an unsigned mesh event with a bounded NIP-40 expiration. */
export function buildMeshEvent(input: {
  kind: MeshKind;
  content: string;
  tags?: string[][];
  ttlSeconds?: number;
  createdAt?: number;
}): UnsignedNostrEvent {
  const createdAt = input.createdAt ?? nowSeconds();
  const maxTtl = MESH_KIND_MAX_TTL_SECONDS[input.kind];
  const ttl = Math.max(1, Math.min(input.ttlSeconds ?? maxTtl, maxTtl));
  return {
    kind: input.kind,
    created_at: createdAt,
    content: input.content,
    tags: [...(input.tags ?? []), ['expiration', String(createdAt + ttl)]],
  };
}

export {
  bytesToHex as meshBytesToHex,
  hexToBytes as meshHexToBytes,
  randomBytes as meshRandomBytes,
};
