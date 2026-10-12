# Contributing

Thanks for helping build Tape Network.

- **Before a PR:** `npm run typecheck && npm test`. The e2e test runs real Iroh nodes on loopback; it needs no network.
- **Protocol changes** start as an issue with a spec diff under `spec/`. Wire formats are shared with Tape Hub:
  a change must stay backwards compatible within v1 (new optional fields need both sides to ignore them safely —
  remember signed payloads must not change shape) or bump the path version.
- **Security-relevant changes** (validators, limits, approval, key handling) need a test that fails without the change.
- **Catalog adapters** are welcome as separate packages implementing `CatalogSource`; keep them metadata-only.
- **Ranking algorithms** go in `src/recommend/`; they must be deterministic, local, and explain themselves through `reasons`.

Style: TypeScript strict, ES modules, no runtime dependencies beyond Iroh and `@noble/*` without discussion.

By contributing you agree your work is released under the MIT License.
