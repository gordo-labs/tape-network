# Mesh

## Transport

A mesh node is an Iroh endpoint. Peers dial it by endpoint id with direct addresses (`ip:port`) and/or an
iroh-relay URL, over the duplex ALPN `iroh-http/2-duplex`. Implementations MUST NOT use n0 relays or n0 DNS discovery
by default.

Each session carries one bidirectional stream of **frames**: a 4-byte big-endian length followed by that many bytes
of UTF-8 JSON, each frame one NIP-01 message array. The client sends a request frame and waits for exactly one reply
frame before the next. Limits a server SHOULD enforce: frame ≤ 17 KiB in, reply ≤ 512 KiB, ≤ 16 requests per
session, 15 s per session, 60 sessions per minute per peer.

## Messages

| Request | Reply | Notes |
| --- | --- | --- |
| `["EVENT", <event>]` | `["OK", id, accepted, reason]` (may append a reply event) | Event admission rules below |
| `["REQ", subId, filter]` | `["EVENTS", subId, [events]]` or `["CLOSED", subId, reason]` | One NIP-01 filter. Only kinds 30561/30563 (public), or kind 30562 with ≤ 4 `#d` and ≤ 4 `authors` (exact presence lookup). Limit ≤ 100 (≤ 5 for presence) |
| `["HEALTH", nonce32hex, url]` | `["HEALTH", schnorrSig]` | Proves the node controls its Nostr key (used for relay reachability) |

Unknown requests get `["NOTICE", "unsupported: …"]`.

## Event admission

An event MUST be rejected unless all hold:

- valid NIP-01 id and BIP-340 signature; serialized size ≤ 16 KiB, content ≤ 12 KiB, ≤ 16 tags;
- `kind` is a mesh kind (table below);
- `created_at` no more than 5 min in the future;
- a NIP-40 `expiration` tag in the future and no further than the kind's maximum TTL from `created_at`;
- addressable kinds (30000–39999) carry a `d` tag (newest per `pubkey`+`kind`+`d` wins).

| Kind | Name | Max TTL | Content |
| --- | --- | --- | --- |
| 30561 | Relay offer | 6 h | Public iroh-relay a hub offers (Tape Hub) |
| 30562 | Presence | 15 min | NIP-44 encrypted, locator-addressed (Tape Hub) |
| 30563 | **Discovery listing** | 1 h | Below |
| 25561 / 25562 | Relay grant request / response | 2 min | NIP-44 (Tape Hub) |
| 25563 / 25564 | Reachability probe request / response | 1 min | NIP-44 (Tape Hub) |

A standalone node only needs 30563; it MUST still store and serve 30561 to keep the mesh healthy.

## Identity binding

Listings carry a tag `["tape-hub", hubId, hubPublicKeyB64url, signatureB64url]` where `signature` is Ed25519 over
the UTF-8 string `tape-hub-mesh-binding/1|<hubId lowercase>|<nostr pubkey lowercase>`, and `hubId` MUST equal the
hex of the first 16 bytes of sha256(raw public key). Receivers MUST drop listings whose binding fails.

## Discovery listing (kind 30563)

Tags: `["d", "tape-discovery"]`, the binding tag, `expiration`. Content (JSON):

```json
{
  "v": 1,
  "service": "tape-discovery",
  "endpointId": "<hex lookup endpoint id>",
  "addrs": ["203.0.113.7:42437"],
  "relayUrls": ["https://relay.example.org/"],
  "capabilities": ["metadata-search-v1", "recommendations-v1"],
  "name": "Optional display name"
}
```

Rules: ≤ 4 `addrs`, ≤ 3 `relayUrls` (http/https), at least one of the two; unknown capabilities are ignored and at
least one known capability is required; `name` is control-character-stripped and cut to 64 chars. Receivers SHOULD
reject private, loopback, link-local and CGNAT addresses unless explicitly operating on a LAN, and SHOULD cap the
listings they track (reference: 1024).

Listing is **opt-in**. A node that does not publish can still search and recommend through peers it already knows.

## Joining

A node joins by dialing one or more bootstrap mesh peers (`<hex endpoint id>@<ip:port>`), sending its own listing
as `EVENT` (if publishing) and asking `REQ` for kinds `[30563, 30561]`. Nodes re-publish before the listing's 1 h
expiry (reference: every 10 min).
