# Lookup v1 (metadata search)

`POST /music-hub/network/metadata/1/lookup` over iroh-http (`httpi://<base32 lookup peer id>/…`).

The caller's peer id comes from the QUIC handshake (`Peer-Id` header set by iroh-http), never from the body. A server
MUST answer `403 peer_not_approved` unless that peer is approved and not blocked. Other errors: `404`, `400
invalid_request`, `409 replayed_request`, `429 rate_limited` (reference: 30/min per peer).

## Request (≤ 16 KiB)

```json
{ "version": 1, "nonce": "<16–128 [A-Za-z0-9-]>", "query": { "identity": { "type": "musicbrainz-recording", "value": "<mbid>" } } }
```

`query` keys (all optional, strings ≤ 256): `identity` (`{type, value}`, type ∈ `canonical-recording`,
`musicbrainz-recording`, `isrc`), `recordingId`, `isrc`, `fingerprint`, `title`, `artist`, `album`. It MUST contain an
identity, `recordingId`, `isrc`, `fingerprint`, or **both** `title` and `artist`. No other keys are allowed. Free-text
or partial search is deliberately not part of v1.

## Response

```json
{ "version": 1, "nonce": "<echo>", "peerId": "<server's base32 id>", "hubName": "Node", "matches": [
  { "peerId": "<server id>", "confidence": 1, "matchedBy": ["canonical-identity"], "metadata": { … } } ] }
```

≤ 8 matches. The client MUST reject a response whose `peerId` differs from the dialed id or whose `nonce` differs
from the one it sent.

## Metadata packet

Allowed keys only: `trackId`, `identities` (≤ 3), `title`, `artist` (required), `album`, `albumArtist`, `genre`,
`musicalKey`, `label` (strings ≤ 256 or null), `format` (≤ 64), `year`, `bpm`, `duration` (finite numbers or null),
`source` = `{hubId, hubName ≤ 128, pluginId: "music-hub-network"}`. `trackId` MUST be public: the first identity as
`type:value`, else `peer:<peerId>` — never a local database id. Packets with any other key are rejected.

## Verification and consensus

A peer's `confidence` is capped by what the asking node can verify:

| Evidence | Cap |
| --- | --- |
| The packet echoes the requested canonical identity | 1.0 |
| Exact (case-insensitive) title and artist match the query | 0.6 |
| Anything else | 0.3 |

The asker groups matches by identity (else normalized artist|title), keeps **one vote per peer** (its strongest),
multiplies by its **local** trust weight for that peer (default 1, clamp 0–3), and picks each field by weighted
majority, reporting alternatives and agreement. Trust weights are a local choice and are never published.
