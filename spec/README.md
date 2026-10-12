# Tape Network protocol v1

| Document | Covers |
| --- | --- |
| [mesh.md](mesh.md) | Transport, framing, Nostr event rules, mesh kinds, the discovery listing, identity binding |
| [lookup.md](lookup.md) | Metadata search: request, metadata packet, response, verification, consensus |
| [recommend.md](recommend.md) | Recommendations: seed, response, local ranking, purchase links |
| [privacy.md](privacy.md) | What may and may not cross the wire; approval; trust lists |

Conformance words (MUST, SHOULD, MAY) follow RFC 2119. Tape Hub (with the Tape Network module) and this
repository implement the same v1 wire format; the reference validators live in `src/protocol/`.

## Identities

| Identity | Key | Encoding | Use |
| --- | --- | --- | --- |
| Node identity | Ed25519 | `hubId` = hex of first 16 bytes of sha256(raw public key); public key as base64url | Binds a Nostr key to a node (same as a Tape Hub's Sovereign identity) |
| Nostr key | secp256k1 (BIP-340 Schnorr) | 32-byte x-only hex | Signs mesh events |
| Mesh endpoint | Iroh (Ed25519) | hex on the mesh wire; RFC 4648 base32 (lowercase, no padding) for `httpi://` | Mesh node |
| Lookup endpoint | Iroh (Ed25519) | hex in listings; base32 as the **peer id** users approve | Search and recommend |

Nodes SHOULD keep the mesh and lookup endpoint keys separate, so approving a lookup peer reveals nothing about mesh routing.
