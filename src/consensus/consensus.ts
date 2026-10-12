/**
 * Per-field consensus over peer answers. One vote per peer per identity; a peer's
 * claimed confidence is capped by what this node can verify against its own query;
 * local trust lists (e.g. "MusicBrainz reference node") add weight — a local choice,
 * never a global reputation.
 */
import type { LookupMatch, LookupQuery, MetadataPacket, TrackIdentity } from '../protocol/lookup.js';

export const CONSENSUS_FIELDS = ['title', 'artist', 'album', 'albumArtist', 'year', 'genre', 'bpm', 'musicalKey', 'label', 'duration', 'format'] as const;
export type ConsensusField = (typeof CONSENSUS_FIELDS)[number];
type Value = string | number | null;

export type FieldConsensus = {
  value: Value;
  agreeingPeers: number;
  contributingPeers: number;
  confidence: number;
  alternatives: Array<{ value: Value; peerCount: number; confidence: number; peerIds: string[] }>;
};

export type ConsensusTrack = {
  identity: TrackIdentity | null;
  matchedPeers: number;
  metadata: Record<ConsensusField, Value>;
  consensus: Record<ConsensusField, FieldConsensus>;
  contributors: Array<{ peerId: string; hubName: string; weight: number }>;
};

/** Trust multipliers by peer id (default 1). Values are clamped to [0, 3]. */
export type TrustList = Record<string, number>;

export function requestedIdentity(query: LookupQuery): TrackIdentity | null {
  if (query.identity?.value.trim()) return query.identity;
  if (query.isrc?.trim()) return { type: 'isrc', value: query.isrc };
  if (query.recordingId?.trim()) return { type: 'canonical-recording', value: query.recordingId };
  return null;
}

const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string'
  && a.trim().length > 0 && a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/** 1 when a requested canonical identity is echoed back, 0.6 for exact title + artist, else 0.3. */
export function verifiedMatchConfidence(query: LookupQuery, metadata: MetadataPacket): number {
  const requested = requestedIdentity(query);
  if (requested && metadata.identities?.some((id) => id.type === requested.type && id.value.toLowerCase() === requested.value.toLowerCase())) return 1;
  if (same(query.title, metadata.title) && same(query.artist, metadata.artist)) return 0.6;
  return 0.3;
}

function normalized(value: Value): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return String(value);
  const trimmed = value.trim();
  return trimmed ? trimmed.toLocaleLowerCase() : null;
}

function identityFor(metadata: MetadataPacket, query: LookupQuery): TrackIdentity | null {
  const requested = requestedIdentity(query);
  if (requested) return metadata.identities?.find((id) => id.type === requested.type && id.value.toLowerCase() === requested.value.toLowerCase()) ?? null;
  return metadata.identities?.[0] ?? null;
}

export function buildConsensus(query: LookupQuery, matches: LookupMatch[], trust: TrustList = {}): ConsensusTrack[] {
  const groups = new Map<string, { identity: TrackIdentity | null; byPeer: Map<string, { match: LookupMatch; weight: number }> }>();
  for (const match of matches) {
    const identity = identityFor(match.metadata, query);
    const key = identity ? `${identity.type}:${identity.value.toLowerCase()}` : `text:${normalized(match.metadata.artist)}|${normalized(match.metadata.title)}`;
    const weight = Math.min(match.confidence, verifiedMatchConfidence(query, match.metadata))
      * Math.max(0, Math.min(3, trust[match.peerId] ?? 1));
    const group = groups.get(key) ?? { identity, byPeer: new Map() };
    const existing = group.byPeer.get(match.peerId);
    if (!existing || weight > existing.weight) group.byPeer.set(match.peerId, { match, weight });
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const votesByPeer = [...group.byPeer.values()];
    const metadata = {} as Record<ConsensusField, Value>;
    const consensus = {} as Record<ConsensusField, FieldConsensus>;
    for (const field of CONSENSUS_FIELDS) {
      const votes = new Map<string, { value: Value; weight: number; peerIds: string[] }>();
      let total = 0;
      for (const { match, weight } of votesByPeer) {
        const value = (match.metadata[field] ?? null) as Value;
        const key = normalized(value);
        if (key === null) continue;
        const vote = votes.get(key) ?? { value, weight: 0, peerIds: [] };
        vote.weight += weight;
        vote.peerIds.push(match.peerId);
        votes.set(key, vote);
        total += weight;
      }
      const alternatives = [...votes.values()]
        .sort((a, b) => b.weight - a.weight || String(a.value).localeCompare(String(b.value)))
        .map((vote) => ({ value: vote.value, peerCount: vote.peerIds.length, confidence: total > 0 ? vote.weight / total : 0, peerIds: vote.peerIds.sort() }));
      const winner = alternatives[0];
      metadata[field] = winner?.value ?? null;
      consensus[field] = {
        value: winner?.value ?? null,
        agreeingPeers: winner?.peerCount ?? 0,
        contributingPeers: alternatives.reduce((n, a) => n + a.peerCount, 0),
        confidence: winner?.confidence ?? 0,
        alternatives,
      };
    }
    return {
      identity: group.identity,
      matchedPeers: votesByPeer.length,
      metadata,
      consensus,
      contributors: votesByPeer
        .map(({ match, weight }) => ({ peerId: match.peerId, hubName: match.metadata.source.hubName, weight }))
        .sort((a, b) => b.weight - a.weight || a.peerId.localeCompare(b.peerId)),
    };
  }).sort((a, b) => b.matchedPeers - a.matchedPeers);
}
