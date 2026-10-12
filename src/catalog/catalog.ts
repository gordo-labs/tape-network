/**
 * A catalog is what a node serves to the network: public catalogue facts only.
 * Adapters (JSON file, MusicBrainz dump, beets, Navidrome, a Tape Hub…) implement
 * `CatalogSource`; the node never sees file paths or audio.
 */
import { readFileSync } from 'node:fs';
import type { LookupQuery, RecommendSeed, TrackIdentity } from '../protocol/lookup.js';

export type CatalogTrack = {
  identities: TrackIdentity[];
  title: string;
  artist: string;
  album?: string | null;
  albumArtist?: string | null;
  year?: number | null;
  genre?: string | null;
  bpm?: number | null;
  musicalKey?: string | null;
  label?: string | null;
  duration?: number | null;
  format?: string | null;
};

export interface CatalogSource {
  /** Tracks matching a lookup (canonical identity first, else exact title + artist). */
  lookup(query: LookupQuery, limit: number): CatalogTrack[];
  /** Candidate tracks related to a seed (same artist/label/genre…), before ranking. */
  related(seed: RecommendSeed, limit: number): CatalogTrack[];
  /** Whether the catalog already holds this track (novelty filter). */
  has(track: Pick<CatalogTrack, 'identities' | 'title' | 'artist'>): boolean;
  size(): number;
}

const norm = (value: string | null | undefined) => (value ?? '').trim().toLocaleLowerCase();

export function trackKey(track: Pick<CatalogTrack, 'identities' | 'title' | 'artist'>): string {
  const mbid = track.identities.find((id) => id.type === 'musicbrainz-recording');
  const first = mbid ?? track.identities[0];
  return first ? `${first.type}:${first.value.toLowerCase()}` : `text:${norm(track.artist)}|${norm(track.title)}`;
}

function sanitize(raw: unknown): CatalogTrack | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const text = (v: unknown, max = 256) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const title = text(t.title);
  const artist = text(t.artist);
  if (!title || !artist) return null;
  const identities = (Array.isArray(t.identities) ? t.identities : [])
    .filter((id): id is TrackIdentity => Boolean(id) && typeof id === 'object'
      && ['canonical-recording', 'musicbrainz-recording', 'isrc'].includes((id as TrackIdentity).type)
      && typeof (id as TrackIdentity).value === 'string' && (id as TrackIdentity).value.length <= 128)
    .slice(0, 3);
  return {
    identities,
    title,
    artist,
    album: text(t.album),
    albumArtist: text(t.albumArtist),
    year: num(t.year),
    genre: text(t.genre),
    bpm: num(t.bpm),
    musicalKey: text(t.musicalKey),
    label: text(t.label),
    duration: num(t.duration),
    format: text(t.format, 64),
  };
}

/** In-memory catalog with simple indexes; the base for every adapter. */
export class MemoryCatalog implements CatalogSource {
  private readonly tracks: CatalogTrack[];
  private readonly byKey = new Map<string, CatalogTrack>();
  private readonly byIdentity = new Map<string, CatalogTrack[]>();

  constructor(tracks: unknown[]) {
    this.tracks = tracks.map(sanitize).filter((t): t is CatalogTrack => Boolean(t));
    for (const track of this.tracks) {
      this.byKey.set(trackKey(track), track);
      this.byKey.set(`text:${norm(track.artist)}|${norm(track.title)}`, track);
      for (const id of track.identities) {
        const key = `${id.type}:${id.value.toLowerCase()}`;
        this.byIdentity.set(key, [...(this.byIdentity.get(key) ?? []), track]);
      }
    }
  }

  size(): number {
    return this.tracks.length;
  }

  lookup(query: LookupQuery, limit: number): CatalogTrack[] {
    const identity = query.identity
      ?? (query.isrc ? { type: 'isrc' as const, value: query.isrc } : undefined)
      ?? (query.recordingId ? { type: 'canonical-recording' as const, value: query.recordingId } : undefined);
    if (identity) return (this.byIdentity.get(`${identity.type}:${identity.value.toLowerCase()}`) ?? []).slice(0, limit);
    if (query.title && query.artist) {
      return this.tracks.filter((t) => norm(t.title) === norm(query.title) && norm(t.artist) === norm(query.artist)).slice(0, limit);
    }
    return [];
  }

  related(seed: RecommendSeed, limit: number): CatalogTrack[] {
    const out: CatalogTrack[] = [];
    for (const track of this.tracks) {
      if (seed.identity && track.identities.some((id) => id.type === seed.identity!.type && id.value.toLowerCase() === seed.identity!.value.toLowerCase())) continue;
      const related = (seed.artist && norm(track.artist) === norm(seed.artist))
        || (seed.label && norm(track.label) === norm(seed.label))
        || (seed.genre && norm(track.genre) === norm(seed.genre));
      if (related) out.push(track);
      if (out.length >= limit * 4) break;
    }
    return out;
  }

  has(track: Pick<CatalogTrack, 'identities' | 'title' | 'artist'>): boolean {
    if (track.identities.some((id) => this.byIdentity.has(`${id.type}:${id.value.toLowerCase()}`))) return true;
    return this.byKey.has(`text:${norm(track.artist)}|${norm(track.title)}`);
  }
}

/** JSON file: `[{ title, artist, identities: [{type, value}], album, year, genre, bpm, musicalKey, label }]`. */
export function loadJsonCatalog(path: string): MemoryCatalog {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(raw)) throw new Error('catalog file must be a JSON array of tracks');
  return new MemoryCatalog(raw);
}
