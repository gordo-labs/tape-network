# Recommend v1

`POST /tape-network/recommend/1` over iroh-http; capability `recommendations-v1`. Same approval, rate limit and
error codes as lookup.

## Request (≤ 64 KiB)

```json
{ "version": 1, "nonce": "<required>", "seed": { "artist": "Artist", "genre": "House" }, "limit": 25 }
```

`seed` keys: `identity`, `title`, `artist`, `label`, `genre`, `musicalKey` (strings ≤ 256), `year`, `bpm` (numbers).
It MUST contain `identity`, `artist`, `label` or `genre`. `limit` is capped at 25. The seed carries public catalogue
facts about one track only — never the asker's library, history or other tracks.

## Response

`{ "version": 1, "nonce", "peerId", "hubName", "tracks": [<metadata packet>, …] }` with ≤ 25 packets, same echo rules
as lookup. A server answers with what *it* relates to the seed (reference: same artist, label or genre in its catalog,
excluding the seed itself).

## Local ranking (not on the wire)

1. Merge answers into candidates: one per recording, recording which peers proposed it.
2. **Novelty filter:** drop the seed and anything the user already owns.
3. Score with one or more `RankingAlgorithm`s and user-chosen weights. The built-in `metadata-affinity` adds points for
   same artist (3), label (2.5), genre (2), era ±3 y (1), tempo within 4 % (1), key (0.5) and agreement between peers
   (0.5 per extra peer, max 2). Every point comes with a human-readable reason.
4. Attach links built locally: MusicBrainz recording/ISRC pages when ids exist; Bandcamp, Discogs, MusicBrainz, Qobuz,
   Beatport and Juno search URLs otherwise.

Ranking, weights and results never leave the machine.

## Roadmap (not in v1)

- Layer B: opt-in co-occurrence snapshots (which recordings appear together in crates), shared as content-addressed
  blobs.
- Layer C: audio embeddings computed locally, with licence-compatible models only.
