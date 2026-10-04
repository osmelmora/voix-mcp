# Anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop
- Revision: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`
- Copied from: `skills/install-anti-slop/assets/anti-slop/`, verified identical to the production files in `src/` at that revision.
- Generic entry point: `tools/oxlint/anti-slop/index.ts`
- Effect entry point: `tools/oxlint/anti-slop/effect/index.ts`
- Local rule deviations: none. Upstream tests and installation tooling are not included.
- Dependencies: `oxlint` and `@oxlint/plugins` are both pinned to `1.86.0`, the repository's existing Oxlint version.

The plugin is owned and maintained in this repository. Preserve local changes when updating from upstream; update this record to identify the source revision and any policy deviations.

The root `LICENSE` covers anti-slop (MIT). The spacing engine carries its own license and provenance in `vendor/eslint-stylistic/`.
