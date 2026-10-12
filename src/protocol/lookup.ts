/**
 * Tape Network metadata protocol v1 (iroh-http on the node's lookup endpoint).
 *
 *   POST /music-hub/network/metadata/1/lookup     metadata for one track identity (Tape Hub compatible)
 *   POST /tape-network/recommend/1                 tracks a peer relates to a seed (capability recommendations-v1)
 *
 * Both are metadata only. Every packet is schema-checked with an allowlist of keys and
 * size bounds; anything else is rejected. A peer's local track ids are never sent.
 */

export const LOOKUP_PATH = '/music-hub/network/metadata/1/lookup';
export const RECOMMEND_PATH = '/tape-network/recommend/1';
export const PROTOCOL_VERSION = 1;
/** Kept for wire compatibility with Tape Hub's add-on. */
export const SOURCE_PLUGIN_ID = 'music-hub-network';
export const MAX_PACKET_BYTES = 16_384;
export const MAX_RECOMMEND_PACKET_BYTES = 64 * 1024;
export const MAX_MATCHES = 8;
export const MAX_RECOMMENDATIONS = 25;

export type TrackIdentityType = 'canonical-recording' | 'musicbrainz-recording' | 'isrc';
export type TrackIdentity = { type: TrackIdentityType; value: string };

export type LookupQuery = {
  recordingId?: string;
  isrc?: string;
  fingerprint?: string;
  identity?: TrackIdentity;
  title?: string;
  artist?: string;
  album?: string;
};

export type MetadataPacket = {
  trackId: string;
  identities?: TrackIdentity[];
  title: string;
  artist: string;
  album: string | null;
  albumArtist: string | null;
  year: number | null;
  genre: string | null;
  bpm: number | null;
  musicalKey: string | null;
  label: string | null;
  duration: number | null;
  format: string | null;
  source: { hubId: string; hubName: string; pluginId: string };
};

export type LookupMatch = { peerId: string; confidence: number; metadata: MetadataPacket; matchedBy: string[] };
export type LookupRequest = { version: 1; nonce?: string; query: LookupQuery };
export type LookupResponse = { version: 1; nonce?: string; peerId: string; hubName: string; matches: LookupMatch[] };

/** Seed facts for recommendations: only public catalogue facts, never the asker's library. */
export type RecommendSeed = {
  identity?: TrackIdentity;
  title?: string;
  artist?: string;
  label?: string;
  genre?: string;
  year?: number;
  bpm?: number;
  musicalKey?: string;
};
export type RecommendRequest = { version: 1; nonce: string; seed: RecommendSeed; limit?: number };
export type RecommendResponse = { version: 1; nonce: string; peerId: string; hubName: string; tracks: MetadataPacket[] };

const IDENTITY_TYPES = new Set(['canonical-recording', 'musicbrainz-recording', 'isrc']);
const METADATA_KEYS = ['trackId', 'identities', 'title', 'artist', 'album', 'albumArtist', 'year', 'genre', 'bpm', 'musicalKey', 'label', 'duration', 'format', 'source'];

export class ProtocolError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function str(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && value.trim().length > 0;
}

function nullableStr(value: unknown, max: number): boolean {
  return value === null || value === undefined || str(value, max);
}

function nullableNum(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

export function isPeerId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{20,256}$/.test(value);
}

export function isNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{16,128}$/.test(value);
}

export function isTrackIdentity(value: unknown): value is TrackIdentity {
  return isRecord(value) && onlyKeys(value, ['type', 'value']) && IDENTITY_TYPES.has(String(value.type)) && str(value.value, 128);
}

export function isLookupQuery(value: unknown): value is LookupQuery {
  if (!isRecord(value) || !onlyKeys(value, ['recordingId', 'isrc', 'fingerprint', 'identity', 'title', 'artist', 'album'])) return false;
  for (const field of ['recordingId', 'isrc', 'fingerprint', 'title', 'artist', 'album']) {
    if (value[field] !== undefined && !str(value[field], 256)) return false;
  }
  if (value.identity !== undefined && !isTrackIdentity(value.identity)) return false;
  return Boolean(value.identity || value.recordingId || value.isrc || value.fingerprint || (value.title && value.artist));
}

export function parseLookupRequest(value: unknown): LookupRequest {
  if (!isRecord(value) || !onlyKeys(value, ['version', 'nonce', 'query']) || value.version !== PROTOCOL_VERSION) throw new ProtocolError('invalid request');
  if (value.nonce !== undefined && !isNonce(value.nonce)) throw new ProtocolError('invalid nonce');
  if (!isLookupQuery(value.query)) throw new ProtocolError('invalid query');
  return { version: 1, nonce: value.nonce as string | undefined, query: value.query };
}

export function parseMetadataPacket(value: unknown): MetadataPacket {
  if (!isRecord(value) || !onlyKeys(value, METADATA_KEYS) || !str(value.trackId, 256) || !str(value.title, 256) || !str(value.artist, 256)) {
    throw new ProtocolError('invalid metadata');
  }
  if (value.identities !== undefined && (!Array.isArray(value.identities) || value.identities.length > 3 || !value.identities.every(isTrackIdentity))) {
    throw new ProtocolError('invalid identities');
  }
  for (const [field, max] of [['album', 256], ['albumArtist', 256], ['genre', 256], ['musicalKey', 256], ['label', 256], ['format', 64]] as const) {
    if (!nullableStr(value[field], max)) throw new ProtocolError(`invalid ${field}`);
  }
  for (const field of ['year', 'bpm', 'duration']) if (!nullableNum(value[field])) throw new ProtocolError(`invalid ${field}`);
  const source = value.source;
  if (!isRecord(source) || !onlyKeys(source, ['hubId', 'hubName', 'pluginId']) || !str(source.hubId, 256) || !str(source.hubName, 128) || source.pluginId !== SOURCE_PLUGIN_ID) {
    throw new ProtocolError('invalid source');
  }
  return {
    trackId: value.trackId,
    identities: value.identities as TrackIdentity[] | undefined,
    title: value.title,
    artist: value.artist,
    album: (value.album as string | null | undefined) ?? null,
    albumArtist: (value.albumArtist as string | null | undefined) ?? null,
    year: (value.year as number | null | undefined) ?? null,
    genre: (value.genre as string | null | undefined) ?? null,
    bpm: (value.bpm as number | null | undefined) ?? null,
    musicalKey: (value.musicalKey as string | null | undefined) ?? null,
    label: (value.label as string | null | undefined) ?? null,
    duration: (value.duration as number | null | undefined) ?? null,
    format: (value.format as string | null | undefined) ?? null,
    source: { hubId: source.hubId, hubName: source.hubName, pluginId: SOURCE_PLUGIN_ID },
  };
}

export function parseLookupResponse(value: unknown, expectedPeerId: string, expectedNonce: string): LookupResponse {
  if (!isRecord(value) || !onlyKeys(value, ['version', 'nonce', 'peerId', 'hubName', 'matches']) || value.version !== PROTOCOL_VERSION) {
    throw new ProtocolError('invalid response');
  }
  if (value.peerId !== expectedPeerId) throw new ProtocolError('response identity mismatch');
  if (value.nonce !== expectedNonce) throw new ProtocolError('response nonce mismatch');
  if (!str(value.hubName, 128) || !Array.isArray(value.matches) || value.matches.length > MAX_MATCHES) throw new ProtocolError('invalid result');
  return {
    version: 1,
    nonce: expectedNonce,
    peerId: expectedPeerId,
    hubName: value.hubName,
    matches: value.matches.map((raw) => {
      if (!isRecord(raw) || !onlyKeys(raw, ['peerId', 'confidence', 'metadata', 'matchedBy'])) throw new ProtocolError('invalid match');
      if (!isPeerId(raw.peerId) || typeof raw.confidence !== 'number' || !(raw.confidence >= 0 && raw.confidence <= 1)) throw new ProtocolError('invalid match values');
      if (!Array.isArray(raw.matchedBy) || raw.matchedBy.length > 8 || !raw.matchedBy.every((m) => str(m, 64))) throw new ProtocolError('invalid evidence');
      return { peerId: raw.peerId, confidence: raw.confidence, metadata: parseMetadataPacket(raw.metadata), matchedBy: [...raw.matchedBy] as string[] };
    }),
  };
}

export function isRecommendSeed(value: unknown): value is RecommendSeed {
  if (!isRecord(value) || !onlyKeys(value, ['identity', 'title', 'artist', 'label', 'genre', 'year', 'bpm', 'musicalKey'])) return false;
  for (const field of ['title', 'artist', 'label', 'genre', 'musicalKey']) if (value[field] !== undefined && !str(value[field], 256)) return false;
  for (const field of ['year', 'bpm']) if (value[field] !== undefined && !(typeof value[field] === 'number' && Number.isFinite(value[field]))) return false;
  if (value.identity !== undefined && !isTrackIdentity(value.identity)) return false;
  return Boolean(value.identity || value.artist || value.label || value.genre);
}

export function parseRecommendRequest(value: unknown): RecommendRequest {
  if (!isRecord(value) || !onlyKeys(value, ['version', 'nonce', 'seed', 'limit']) || value.version !== PROTOCOL_VERSION) throw new ProtocolError('invalid request');
  if (!isNonce(value.nonce) || !isRecommendSeed(value.seed)) throw new ProtocolError('invalid seed');
  const limit = value.limit === undefined ? MAX_RECOMMENDATIONS : Number(value.limit);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new ProtocolError('invalid limit');
  return { version: 1, nonce: value.nonce, seed: value.seed, limit: Math.min(limit, MAX_RECOMMENDATIONS) };
}

export function parseRecommendResponse(value: unknown, expectedPeerId: string, expectedNonce: string): RecommendResponse {
  if (!isRecord(value) || !onlyKeys(value, ['version', 'nonce', 'peerId', 'hubName', 'tracks']) || value.version !== PROTOCOL_VERSION) {
    throw new ProtocolError('invalid response');
  }
  if (value.peerId !== expectedPeerId || value.nonce !== expectedNonce) throw new ProtocolError('response mismatch');
  if (!str(value.hubName, 128) || !Array.isArray(value.tracks) || value.tracks.length > MAX_RECOMMENDATIONS) throw new ProtocolError('invalid tracks');
  return { version: 1, nonce: expectedNonce, peerId: expectedPeerId, hubName: value.hubName, tracks: value.tracks.map(parseMetadataPacket) };
}

/** Public id for a packet: first canonical identity, never a local id. */
export function publicTrackId(identities: TrackIdentity[] | undefined, peerId: string): string {
  const first = identities?.[0];
  return first ? `${first.type}:${first.value}` : `peer:${peerId}`;
}
