import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryCatalog, trackKey } from '../src/catalog/catalog.js';
import { buildConsensus, verifiedMatchConfidence } from '../src/consensus/consensus.js';
import { SOURCE_PLUGIN_ID, type LookupMatch, type MetadataPacket } from '../src/protocol/lookup.js';
import { mergeCandidates, rankRecommendations, type RankingAlgorithm } from '../src/recommend/algorithms.js';
import { purchaseLinks } from '../src/recommend/links.js';

const MBID = '0f6cd1a6-6b6c-4d0b-9a3e-4f6a8e0b1c2d';
const meta = (over: Partial<MetadataPacket> = {}): MetadataPacket => ({
  trackId: `musicbrainz-recording:${MBID}`, identities: [{ type: 'musicbrainz-recording', value: MBID }],
  title: 'Song', artist: 'Artist', album: 'Album', albumArtist: null, year: 2001, genre: 'House', bpm: 124,
  musicalKey: 'Am', label: 'Label', duration: 300, format: null,
  source: { hubId: 'hub', hubName: 'Node', pluginId: SOURCE_PLUGIN_ID }, ...over,
});
const match = (peerId: string, over: Partial<MetadataPacket> = {}, confidence = 1): LookupMatch => ({ peerId, confidence, matchedBy: ['identity'], metadata: meta(over) });

test('a peer cannot claim more confidence than this node can verify', () => {
  assert.equal(verifiedMatchConfidence({ identity: { type: 'musicbrainz-recording', value: MBID } }, meta()), 1);
  assert.equal(verifiedMatchConfidence({ title: 'song', artist: 'ARTIST' }, meta()), 0.6);
  assert.equal(verifiedMatchConfidence({ isrc: 'USRC17607839' }, meta()), 0.3);
});

test('consensus: one vote per peer, majority per field, local trust breaks ties', () => {
  const query = { identity: { type: 'musicbrainz-recording' as const, value: MBID } };
  const [track] = buildConsensus(query, [
    match('peer-a', { album: 'Album' }),
    match('peer-a', { album: 'Spam' }, 0.1),
    match('peer-b', { album: 'Album' }),
    match('peer-c', { album: 'Wrong' }),
  ]);
  assert.equal(track.matchedPeers, 3);
  assert.equal(track.metadata.album, 'Album');
  assert.equal(track.consensus.album.agreeingPeers, 2);
  const [trusted] = buildConsensus(query, [match('peer-b', { year: 2001 }), match('mb-ref', { year: 2002 })], { 'mb-ref': 3 });
  assert.equal(trusted.metadata.year, 2002);
});

test('catalog lookup, related and novelty', () => {
  const catalog = new MemoryCatalog([
    { title: 'Song', artist: 'Artist', label: 'Label', genre: 'House', identities: [{ type: 'musicbrainz-recording', value: MBID }] },
    { title: 'Other', artist: 'Artist', genre: 'House', identities: [] },
    { title: '', artist: 'dropped' },
    { title: 'Bad id', artist: 'X', identities: [{ type: 'local', value: '/home/me' }] },
  ]);
  assert.equal(catalog.size(), 3);
  assert.equal(catalog.lookup({ identity: { type: 'musicbrainz-recording', value: MBID.toUpperCase() } }, 8).length, 1);
  assert.equal(catalog.lookup({ title: 'other', artist: 'artist' }, 8)[0].title, 'Other');
  assert.equal(catalog.lookup({ title: 'Other' }, 8).length, 0);
  assert.deepEqual(catalog.related({ artist: 'Artist', identity: { type: 'musicbrainz-recording', value: MBID } }, 5).map((t) => t.title), ['Other']);
  assert.equal(catalog.has({ identities: [], title: 'OTHER', artist: 'artist' }), true);
  assert.equal(trackKey({ identities: [], title: 'A', artist: 'B' }), 'text:b|a');
});

test('recommendations: merged per recording, novelty filtered, ranked locally, with links', () => {
  const candidates = mergeCandidates([
    { peerId: 'p1', tracks: [meta(), meta({ identities: [], title: 'Owned', trackId: 'x' }), meta({ identities: [], title: 'Far', artist: 'Else', label: null, genre: 'Jazz', year: 1960, bpm: 90, musicalKey: null, trackId: 'y' })] },
    { peerId: 'p2', tracks: [meta()] },
  ]);
  assert.equal(candidates.find((c) => c.title === 'Song')?.sources.length, 2);
  const ranked = rankRecommendations({ artist: 'Artist', genre: 'House' }, candidates, { isOwned: (c) => c.title === 'Owned' });
  assert.deepEqual(ranked.map((r) => r.title), ['Song']);
  assert.ok(ranked[0].reasons.includes('2 peers agree'));
  assert.ok(ranked[0].links.some((l) => l.url === `https://musicbrainz.org/recording/${MBID}`));
  const jazzLover: RankingAlgorithm = { id: 'jazz', score: (_s, c) => ({ score: c.genre === 'Jazz' ? 10 : 0, reasons: ['jazz'] }) };
  assert.equal(rankRecommendations({ artist: 'Artist' }, candidates, { algorithms: [{ algorithm: jazzLover, weight: 1 }] })[0].title, 'Far');
});

test('purchase links are built locally and encoded', () => {
  const links = purchaseLinks({ title: 'A&B', artist: 'C D', identities: [{ type: 'isrc', value: 'usrc17607839' }] });
  assert.ok(links.some((l) => l.service === 'Bandcamp' && l.url === 'https://bandcamp.com/search?q=C%20D%20A%26B'));
  assert.ok(links.some((l) => l.url === 'https://musicbrainz.org/isrc/USRC17607839'));
  assert.ok(links.every((l) => l.url.startsWith('https://')));
});
