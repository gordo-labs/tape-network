# Tape Network

An open, decentralized network for **music metadata search and discovery**. Run a node on your own computer,
share the catalogue facts you trust (titles, artists, MusicBrainz ids, ISRCs, labels…), ask other nodes what they
know, and get recommendations ranked **on your machine** by algorithms **you** choose.

- **Metadata only.** Never audio, file paths, listening history or your full inventory.
- **Sovereign.** Peers talk over [Iroh](https://iroh.computer) (QUIC, end-to-end encrypted, NAT traversal). No
  central server, no n0 relays or DNS by default; relays are the ones you (or your mesh) run.
- **Consent first.** Nobody can query you until you approve them, and you only query peers you approved.
- **Local judgement.** Answers are merged by per-field consensus with confidence capped by what your node can
  verify. Trust lists ("weigh the MusicBrainz reference node ×3") are yours, never a global reputation.
- **Same protocol as Tape Hub.** A Tape Hub with the Tape Network module joins the same mesh; this repo is the
  standalone, embeddable implementation.

> Status: v0.1 — protocol v1 is stable on the wire (shared with Tape Hub). APIs may change before 1.0.

## Quick start

Requires Node.js 22+.

```sh
npx tape-network init --name "My crate" --catalog ./my-catalog.json
npx tape-network bootstrap add <meshId>@<ip>:<port>   # someone already on the network
npx tape-network serve --publish                       # listed on the mesh, answers approved peers
```

In another terminal:

```sh
npx tape-network peers                                  # nodes discovered through the mesh
npx tape-network peers approve <peerId>                 # both sides approve each other
npx tape-network search --mbid 0f6cd1a6-6b6c-4d0b-9a3e-4f6a8e0b1c2d
npx tape-network search --title "Song" --artist "Artist"
npx tape-network recommend --artist "Artist" --genre House
```

Recommendations come with links to find or buy the music (MusicBrainz canonical pages, plus Bandcamp, Discogs,
Qobuz, Beatport and Juno searches), built locally from the result — no tracking, no API keys.

`tape-network id` prints your ids and the mesh address others can bootstrap from. State (keys `0600`, config) lives
in `$TAPE_NETWORK_HOME`, default `~/.tape-network`.

### Ports

| Port | Use |
| --- | --- |
| UDP 42436 | Mesh node (listings, framed NIP-01 over Iroh) |
| UDP 42437 | Lookup endpoint (metadata search / recommendations over iroh-http) |

Tape Hub uses 42425/tcp and 42426/udp, so a hub and a node can share a machine. Open or forward the UDP ports
for best reachability, or set `relayUrls` in `config.json` to iroh-relays you trust (e.g. a Tape Hub's).

## The catalog

A node serves a `CatalogSource`. The built-in one reads a JSON array:

```json
[{ "title": "Song", "artist": "Artist", "album": "Album", "year": 2001, "genre": "House", "bpm": 124,
   "musicalKey": "Am", "label": "Label",
   "identities": [{ "type": "musicbrainz-recording", "value": "<mbid>" }, { "type": "isrc", "value": "USRC17607839" }] }]
```

See [`examples/catalog.json`](examples/catalog.json). Unknown fields and invalid identities are dropped on load.
Anything can be an adapter — a MusicBrainz dump, beets, Navidrome, a record shop's stock — by implementing
`lookup`, `related`, `has` and `size`.

## Use it as a library

```ts
import { TapeNetworkNode, MemoryCatalog, type RankingAlgorithm } from 'tape-network';

const node = new TapeNetworkNode({ catalog: new MemoryCatalog(myTracks) });
await node.start();
await node.refresh();                       // publish your listing (if enabled) and pull peers
const { tracks } = await node.search({ identity: { type: 'musicbrainz-recording', value: mbid } });

const deepCuts: RankingAlgorithm = {
  id: 'deep-cuts',
  score: (seed, c) => ({ score: c.sources.length === 1 ? 2 : 0, reasons: ['only one peer knows it'] }),
};
const recs = await node.recommend({ artist: 'Artist' }, { algorithms: [{ algorithm: deepCuts, weight: 1 }] });
```

`tape-network/protocol` exports only the wire format (types, validators, Nostr/NIP-44 helpers) for apps that want
to speak the protocol without the node.

## Run a reference node

Third parties — a MusicBrainz mirror, a label, a shop, a radio archive — can run a node that serves their catalogue.
Users decide whether to approve it and how much to trust it. A reference node never gets more weight than each user
gives it, and confidence is always capped by what the asking node verifies against its own query.

## How it works

1. **Mesh.** Nodes and hubs exchange signed Nostr events (NIP-01, Schnorr) over Iroh. A node may publish a
   *discovery listing* (kind 30563) bound to its Ed25519 identity, with its lookup endpoint id and capabilities.
2. **Approval.** You approve peers by lookup peer id. Lookups from anyone else get `403`.
3. **Search.** Approved peers answer `POST /music-hub/network/metadata/1/lookup` with schema-checked metadata
   packets; your node merges them by consensus.
4. **Recommend.** Peers propose related tracks (`POST /tape-network/recommend/1`); your node drops what you already
   have and ranks the rest locally.

Full protocol: [`spec/`](spec/README.md). Security model: [`SECURITY.md`](SECURITY.md).

## Development

```sh
npm install
npm test          # unit tests + a real three-node Iroh e2e on loopback
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed [MIT](LICENSE).
