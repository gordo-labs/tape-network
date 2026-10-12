# Security

## Reporting

Please report vulnerabilities privately through GitHub Security Advisories on this repository
("Report a vulnerability"). Don't open public issues for security problems. We aim to acknowledge within 72 hours.

## Model

| Surface | Who can reach it | Controls |
| --- | --- | --- |
| Mesh node (UDP 42436, Iroh) | Anyone who knows the endpoint id | Iroh-authenticated peers; length-prefixed frames (≤ 17 KiB, 16 per session, 15 s session timeout); `EVENT` only for mesh kinds with valid Schnorr signatures and size/tag/clock-skew (5 min)/TTL limits (listings ≤ 1 h); `REQ` limited to public listings/relay offers and exact presence lookups, replies ≤ 512 KiB; 60 sessions/min per peer, 64 concurrent; in-memory store of ≤ 4000 events |
| Lookup endpoint (UDP 42437, iroh-http) | Approved peers only | `403` for unapproved or blocked peer ids (identity comes from the QUIC handshake, not from the request body); 30 requests/min per peer; bounded bodies (16 KiB lookup, 64 KiB recommend); nonce replay window; load shedding; 8 concurrent requests |
| Discovery listings received | Any mesh peer | Signature + Ed25519 identity binding verified; private/loopback/CGNAT addresses rejected (unless `--lan`); one listing per Nostr key, newest wins; at most 1024 tracked |
| Answers received | Approved peers | Strict allowlist schema with size bounds; responses must echo the dialed peer id and the request nonce; confidence capped by local verification |

What a node never sends: audio, file paths, local track ids, listening history, the full catalogue, or anything
about the asker's library (recommendation seeds contain only public catalogue facts).

Keys are stored with mode `0600` in `$TAPE_NETWORK_HOME`. Losing `keys.json` means a new identity; leaking it lets
someone impersonate your node — treat it like an SSH key.

## Defaults

- No n0 relays, no n0 DNS discovery, no mDNS.
- Not listed on the mesh unless you pass `--publish` (or set `publishListing`).
- Nobody approved.
