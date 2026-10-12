# Privacy and consent

## Never on the wire

Audio (an acoustic fingerprint may appear only as a lookup key), file paths, local track or database ids, listening
history, play counts, ratings, the complete catalogue, or anything about the asker's library in a request.

## Consent

- A node answers lookups and recommendations **only** for peers its owner approved (by lookup peer id).
- A node queries **only** peers its owner approved. Discovery listings let people find each other; they grant nothing.
- Blocking a peer revokes approval and stops it from appearing as usable.
- Publishing a listing is opt-in.

## What others can learn

| Observer | Learns |
| --- | --- |
| Any mesh peer | Your listing if you publish one: lookup endpoint id, advertised addresses/relays, capabilities, display name, node identity |
| An approved peer you query | The single track you asked about or seeded with, and your lookup peer id |
| An approved peer that queries you | Whether you hold the tracks it asks about, with their public metadata |
| A relay operator | That two endpoint ids talk, and traffic volume; contents are end-to-end encrypted |

## Trust lists

Weights you give peers (e.g. a MusicBrainz reference node at ×3) live in your config and are never published. There
is no global reputation, no central ranking and no network-wide consensus beyond what each node computes for itself.
