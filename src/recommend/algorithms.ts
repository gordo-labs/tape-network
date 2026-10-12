/**
 * Recommendation ranking runs on the user's machine. A node gathers candidates
 * (from its own catalog and from approved peers' `recommend` answers), drops what
 * the user already has (novelty filter), then ranks them with a local algorithm the
 * user chooses or writes. Nothing about the ranking leaves the machine.
 */
import type { MetadataPacket, RecommendSeed, TrackIdentity } from '../protocol/lookup.js';
import { purchaseLinks, type PurchaseLink } from './links.js';

export type Candidate = {
  identities: TrackIdentity[];
  title: string;
  artist: string;
  album: string | null;
  year: number | null;
  genre: string | null;
  bpm: number | null;
  musicalKey: string | null;
  label: string | null;
  /** Peers that proposed this candidate (one entry per peer). */
  sources: string[];
};

export type Ranked = Candidate & { score: number; reasons: string[]; links: PurchaseLink[] };

export interface RankingAlgorithm {
  readonly id: string;
  score(seed: RecommendSeed, candidate: Candidate): { score: number; reasons: string[] };
}

const norm = (v: string | null | undefined) => (v ?? '').trim().toLocaleLowerCase();

/** Camelot-ish compatibility: same key, or relative major/minor written as e.g. "Am"/"C". */
function keysCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return norm(a) === norm(b);
}

/** Layer A: transparent metadata affinity (artist, label, genre, era, tempo, key, network agreement). */
export const metadataAffinity: RankingAlgorithm = {
  id: 'metadata-affinity',
  score(seed, c) {
    let score = 0;
    const reasons: string[] = [];
    if (seed.artist && norm(c.artist) === norm(seed.artist)) { score += 3; reasons.push('same artist'); }
    if (seed.label && norm(c.label) === norm(seed.label)) { score += 2.5; reasons.push('same label'); }
    if (seed.genre && norm(c.genre) === norm(seed.genre)) { score += 2; reasons.push('same genre'); }
    if (seed.year && c.year && Math.abs(seed.year - c.year) <= 3) { score += 1; reasons.push('same era'); }
    if (seed.bpm && c.bpm && Math.abs(seed.bpm - c.bpm) <= Math.max(3, seed.bpm * 0.04)) { score += 1; reasons.push('similar tempo'); }
    if (keysCompatible(seed.musicalKey, c.musicalKey)) { score += 0.5; reasons.push('same key'); }
    if (c.sources.length > 1) { score += Math.min(2, 0.5 * (c.sources.length - 1)); reasons.push(`${c.sources.length} peers agree`); }
    return { score, reasons };
  },
};

export const builtinAlgorithms: Record<string, RankingAlgorithm> = { [metadataAffinity.id]: metadataAffinity };

function candidateKey(c: Pick<Candidate, 'identities' | 'title' | 'artist'>): string {
  const mbid = c.identities.find((id) => id.type === 'musicbrainz-recording') ?? c.identities[0];
  return mbid ? `${mbid.type}:${mbid.value.toLowerCase()}` : `text:${norm(c.artist)}|${norm(c.title)}`;
}

/** Merge peer answers into candidates: one entry per recording, one vote per peer. */
export function mergeCandidates(answers: Array<{ peerId: string; tracks: MetadataPacket[] }>): Candidate[] {
  const out = new Map<string, Candidate>();
  for (const { peerId, tracks } of answers) {
    for (const t of tracks) {
      const identities = t.identities ?? [];
      const key = candidateKey({ identities, title: t.title, artist: t.artist });
      const existing = out.get(key);
      if (existing) {
        if (!existing.sources.includes(peerId)) existing.sources.push(peerId);
        continue;
      }
      out.set(key, {
        identities, title: t.title, artist: t.artist, album: t.album, year: t.year, genre: t.genre,
        bpm: t.bpm, musicalKey: t.musicalKey, label: t.label, sources: [peerId],
      });
    }
  }
  return [...out.values()];
}

export function rankRecommendations(
  seed: RecommendSeed,
  candidates: Candidate[],
  options: { algorithms?: Array<{ algorithm: RankingAlgorithm; weight: number }>; isOwned?: (c: Candidate) => boolean; limit?: number } = {},
): Ranked[] {
  const algorithms = options.algorithms ?? [{ algorithm: metadataAffinity, weight: 1 }];
  return candidates
    .filter((c) => !options.isOwned?.(c))
    .filter((c) => !(seed.identity && c.identities.some((id) => id.type === seed.identity!.type && id.value.toLowerCase() === seed.identity!.value.toLowerCase())))
    .map((c) => {
      let score = 0;
      const reasons: string[] = [];
      for (const { algorithm, weight } of algorithms) {
        const result = algorithm.score(seed, c);
        score += result.score * weight;
        reasons.push(...result.reasons);
      }
      return { ...c, score, reasons: [...new Set(reasons)], links: purchaseLinks(c) };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title))
    .slice(0, options.limit ?? 25);
}
