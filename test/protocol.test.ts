import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  MESH_KIND_DISCOVERY_LISTING,
  buildMeshEvent,
  checkMeshEvent,
  generateNostrSecretKey,
  irohEndpointIdFromHex,
  irohEndpointIdToHex,
  meshHexToBytes,
  nip44ConversationKey,
  nip44Decrypt,
  nip44Encrypt,
  nip44PaddedLength,
  nostrPublicKey,
  signNostrEvent,
  verifyNostrEvent,
} from '../src/protocol/mesh.js';

// Official NIP-44 v2 vectors (https://github.com/paulmillr/nip44, MIT).
const vectors = JSON.parse(readFileSync(new URL('./fixtures/nip44.vectors.json', import.meta.url), 'utf8')).v2;

test('NIP-44 conversation keys, padding and encryption match the official vectors', () => {
  for (const v of vectors.valid.get_conversation_key) {
    assert.equal(Buffer.from(nip44ConversationKey(meshHexToBytes(v.sec1), v.pub2)).toString('hex'), v.conversation_key);
  }
  for (const [length, padded] of vectors.valid.calc_padded_len) assert.equal(nip44PaddedLength(length), padded);
  for (const v of vectors.valid.encrypt_decrypt) {
    const key = nip44ConversationKey(meshHexToBytes(v.sec1), nostrPublicKey(meshHexToBytes(v.sec2)));
    assert.equal(nip44Encrypt(v.plaintext, key, meshHexToBytes(v.nonce)), v.payload);
    assert.equal(nip44Decrypt(v.payload, key), v.plaintext);
  }
  for (const v of vectors.invalid.decrypt) {
    assert.throws(() => nip44Decrypt(v.payload, meshHexToBytes(v.conversation_key)), Error, v.note);
  }
});

test('NIP-01 events sign and verify; tampering is rejected', () => {
  const sk = generateNostrSecretKey();
  const event = signNostrEvent(buildMeshEvent({ kind: MESH_KIND_DISCOVERY_LISTING, tags: [['d', 'tape-discovery']], content: '{}' }), sk);
  assert.equal(verifyNostrEvent(event), true);
  assert.equal(checkMeshEvent(event).ok, true);
  assert.equal(verifyNostrEvent({ ...event, content: '{"x":1}' }), false);
  assert.equal(checkMeshEvent({ ...event, kind: 1 }).ok, false);
});

test('endpoint id encodings round-trip', () => {
  const hex = 'ab'.repeat(32);
  for (const encoding of ['base32', 'z32'] as const) {
    const encoded = irohEndpointIdFromHex(hex, encoding);
    assert.ok(encoded);
    assert.equal(irohEndpointIdToHex(encoded!, encoding), hex);
  }
  assert.equal(irohEndpointIdFromHex('zz', 'base32'), null);
});
