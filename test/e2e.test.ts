/**
 * Real Iroh, no relays, loopback only: a reference node, a listener and a stranger.
 * Covers mesh bootstrap + listings, mutual approval, consensus search and recommendations.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MemoryCatalog } from '../src/catalog/catalog.js';
import { TapeNetworkNode } from '../src/node/node.js';

const MBID = '0f6cd1a6-6b6c-4d0b-9a3e-4f6a8e0b1c2d';

function makeNode(name: string, publish: boolean, tracks: unknown[]): TapeNetworkNode {
  const home = mkdtempSync(join(tmpdir(), `tape-network-${name}-`));
  const node = new TapeNetworkNode({ home, allowPrivateAddrs: true, catalog: new MemoryCatalog(tracks) });
  Object.assign(node.state.config, { name, bindHost: '127.0.0.1', publishListing: publish, meshUdpPort: 0, lookupUdpPort: 0 });
  node.state.saveConfig();
  return node;
}

test('two nodes find each other on the mesh, search with consensus and recommend', { timeout: 60_000 }, async (t) => {
  const reference = makeNode('reference', true, [
    { title: 'Song', artist: 'Artist', album: 'Album', label: 'Label', genre: 'House', year: 2001, identities: [{ type: 'musicbrainz-recording', value: MBID }] },
    { title: 'Deep Cut', artist: 'Artist', genre: 'House', identities: [] },
    { title: 'Already Have', artist: 'Artist', identities: [] },
  ]);
  const listener = makeNode('listener', true, [{ title: 'Already Have', artist: 'Artist', identities: [] }]);
  const stranger = makeNode('stranger', false, []);
  const homes = [reference, listener, stranger].map((n) => n.state.home);
  t.after(async () => {
    await Promise.allSettled([reference.stop(), listener.stop(), stranger.stop()]);
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  });

  await reference.start();
  await reference.refresh(); // publishes its own listing locally
  const entry = await reference.meshAddress();
  const offline = reference.state.offlineIds();
  assert.equal(offline.lookupPeerId, reference.lookup.peerId(), 'offline lookup id matches the live endpoint');
  assert.ok(entry?.startsWith(`${offline.meshEndpointHex}@`), 'offline mesh id matches the live endpoint');
  assert.match(entry ?? '', /^[0-9a-f]{64}@127\.0\.0\.1:\d+$/);

  for (const node of [listener, stranger]) {
    node.state.config.bootstrapPeers = [entry!];
    await node.start();
    await node.refresh();
  }

  const found = listener.peers().find((p) => p.hubName === 'reference');
  assert.ok(found, 'listener discovers the reference node from its verified listing');
  assert.deepEqual(found.capabilities.sort(), ['metadata-search-v1', 'recommendations-v1']);
  assert.equal(found.approved, false);

  // Nothing is answered before approval.
  assert.equal((await listener.search({ identity: { type: 'musicbrainz-recording', value: MBID } })).searchedPeers, 0);

  // Mutual approval.
  listener.setPeerApproval(found.peerId, true);
  reference.setPeerApproval(listener.lookup.peerId()!, true);

  const result = await listener.search({ identity: { type: 'musicbrainz-recording', value: MBID } });
  assert.equal(result.searchedPeers, 1);
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].metadata.album, 'Album');
  assert.equal(result.tracks[0].contributors[0].weight, 1);

  const ranked = await listener.recommend({ artist: 'Artist', identity: { type: 'musicbrainz-recording', value: MBID } });
  assert.deepEqual(ranked.map((r) => r.title), ['Deep Cut'], 'seed and owned tracks are filtered out');
  assert.ok(ranked[0].links.some((l) => l.service === 'Bandcamp'));

  // The stranger approved the reference, but the reference never approved the stranger.
  const ref = stranger.peers().find((p) => p.hubName === 'reference');
  assert.ok(ref);
  stranger.setPeerApproval(ref.peerId, true);
  const denied = await stranger.search({ identity: { type: 'musicbrainz-recording', value: MBID } });
  assert.equal(denied.searchedPeers, 1);
  assert.equal(denied.tracks.length, 0);
  // The stranger did not publish a listing, so nobody lists it.
  assert.equal(reference.peers().some((p) => p.hubName === 'stranger'), false);
});
