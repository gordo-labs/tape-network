import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProtocolError,
  SOURCE_PLUGIN_ID,
  parseLookupRequest,
  parseLookupResponse,
  parseMetadataPacket,
  parseRecommendRequest,
  parseRecommendResponse,
} from '../src/protocol/lookup.js';

const PEER = 'a'.repeat(52);
const NONCE = '0123456789abcdef-nonce';
const packet = (extra: Record<string, unknown> = {}) => ({
  trackId: 'musicbrainz-recording:1', title: 'Song', artist: 'Artist', album: null, albumArtist: null, year: 1999,
  genre: 'House', bpm: 124, musicalKey: 'Am', label: null, duration: 300, format: 'flac',
  source: { hubId: 'hub_1', hubName: 'Node', pluginId: SOURCE_PLUGIN_ID }, ...extra,
});

test('lookup requests accept identities or exact title + artist only', () => {
  assert.deepEqual(parseLookupRequest({ version: 1, nonce: NONCE, query: { isrc: 'USRC17607839' } }).query, { isrc: 'USRC17607839' });
  assert.ok(parseLookupRequest({ version: 1, query: { title: 'Song', artist: 'Artist' } }));
  assert.throws(() => parseLookupRequest({ version: 1, query: { title: 'Song' } }), ProtocolError);
  assert.throws(() => parseLookupRequest({ version: 1, query: { isrc: 'x' }, extra: true }), ProtocolError);
  assert.throws(() => parseLookupRequest({ version: 2, query: { isrc: 'x' } }), ProtocolError);
  assert.throws(() => parseLookupRequest({ version: 1, query: { isrc: 'x'.repeat(300) } }), ProtocolError);
});

test('metadata packets are allowlisted and bounded', () => {
  assert.equal(parseMetadataPacket(packet()).title, 'Song');
  assert.throws(() => parseMetadataPacket(packet({ path: '/home/me/song.flac' })), ProtocolError);
  assert.throws(() => parseMetadataPacket(packet({ source: { hubId: 'h', hubName: 'n', pluginId: 'other' } })), ProtocolError);
  assert.throws(() => parseMetadataPacket(packet({ year: 'nineteen' })), ProtocolError);
  assert.throws(() => parseMetadataPacket(packet({ identities: [{ type: 'spotify', value: 'x' }] })), ProtocolError);
});

test('responses must echo the dialed peer and nonce', () => {
  const response = { version: 1, nonce: NONCE, peerId: PEER, hubName: 'Node', matches: [{ peerId: PEER, confidence: 1, matchedBy: ['isrc'], metadata: packet() }] };
  assert.equal(parseLookupResponse(response, PEER, NONCE).matches.length, 1);
  assert.throws(() => parseLookupResponse(response, 'b'.repeat(52), NONCE), /identity mismatch/);
  assert.throws(() => parseLookupResponse(response, PEER, 'another-nonce-123456'), /nonce mismatch/);
  assert.throws(() => parseLookupResponse({ ...response, matches: Array(9).fill(response.matches[0]) }, PEER, NONCE), ProtocolError);
});

test('recommend requests need a public seed and cap the limit', () => {
  assert.equal(parseRecommendRequest({ version: 1, nonce: NONCE, seed: { artist: 'Artist' }, limit: 500 }).limit, 25);
  assert.throws(() => parseRecommendRequest({ version: 1, nonce: NONCE, seed: { title: 'Only title' } }), ProtocolError);
  assert.throws(() => parseRecommendRequest({ version: 1, seed: { artist: 'A' } }), ProtocolError);
  const response = { version: 1, nonce: NONCE, peerId: PEER, hubName: 'Node', tracks: [packet()] };
  assert.equal(parseRecommendResponse(response, PEER, NONCE).tracks.length, 1);
  assert.throws(() => parseRecommendResponse({ ...response, tracks: Array(26).fill(packet()) }, PEER, NONCE), ProtocolError);
});
