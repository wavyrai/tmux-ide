# Current-source retained snapshot serialization integration

Five TypeScript files only: browser.ts, retained-frame-cache.ts/test and browser-publication.ts/test. Cache preview returns immutable branded cache-owned JSON instead of a parsed frame. Browser retains it solely for outgoing retainedPreview.snapshot; fixed explicit prefix/suffix construction preserves property order and fresh metadata. Live snapshots, preview authority/expiry/invalidation, cache LRU/byte bounds, MAX_FRAME and backpressure remain unchanged.

Validation: four focused serializer/cache tests pass; related session-tab/history-restoration/selection-identity tests pass (see exact count in related-tests.log). Bridge TypeScript, targeted ESLint, Prettier and diff whitespace checks pass. Independent source review found no blockers. Initial test fixture attempted to mutate a frozen blank snapshot; fixture-failure.log retains this fixture error, corrected with structuredClone. It was not a product regression.

Tests compare full current envelope bytes across escaping, Unicode, omitted/null fields and metadata/authority transitions, plus cache isolation/invalidation/bounds. The serializer is internal and fixed-schema, not a general arbitrary-object serializer; future envelope changes must maintain byte-equivalence coverage.

No current-source runtime benchmark or native GUI acceptance is claimed here. Historical private experiment measurements are retained separately. Current-source same-path qualification and performance comparison remain separate followups. No native Rust change, generated CLI rebuild, signing or production interaction.
