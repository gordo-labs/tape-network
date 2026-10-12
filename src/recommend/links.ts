/**
 * Where to find, buy or hear a recommendation — URLs built locally from the
 * recommendation alone: no network call, no credentials, nothing tracked.
 * Canonical pages when an id exists; search pages otherwise (Bandcamp has no public API).
 */
import type { TrackIdentity } from '../protocol/lookup.js';

export type PurchaseLink = { kind: 'canonical' | 'search'; service: string; url: string };

export function purchaseLinks(rec: { title: string; artist: string; album?: string | null; identities?: TrackIdentity[] }): PurchaseLink[] {
  const links: PurchaseLink[] = [];
  for (const id of rec.identities ?? []) {
    if (id.type === 'musicbrainz-recording' && /^[0-9a-f-]{36}$/i.test(id.value)) {
      links.push({ kind: 'canonical', service: 'MusicBrainz', url: `https://musicbrainz.org/recording/${id.value.toLowerCase()}` });
    }
    if (id.type === 'isrc' && /^[A-Z0-9]{12}$/i.test(id.value)) {
      links.push({ kind: 'canonical', service: 'MusicBrainz (ISRC)', url: `https://musicbrainz.org/isrc/${id.value.toUpperCase()}` });
    }
  }
  const phrase = `${rec.artist} ${rec.title}`.trim();
  const q = encodeURIComponent(phrase);
  links.push(
    { kind: 'search', service: 'Bandcamp', url: `https://bandcamp.com/search?q=${q}` },
    { kind: 'search', service: 'Discogs', url: `https://www.discogs.com/search/?q=${q}&type=all` },
    { kind: 'search', service: 'MusicBrainz', url: `https://musicbrainz.org/search?query=${q}&type=recording` },
    { kind: 'search', service: 'Qobuz', url: `https://www.qobuz.com/search?q=${q}` },
    { kind: 'search', service: 'Beatport', url: `https://www.beatport.com/search?q=${q}` },
    { kind: 'search', service: 'Juno', url: `https://www.juno.co.uk/search/?q%5Ball%5D%5B%5D=${q}` },
  );
  return links;
}
