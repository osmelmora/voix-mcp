# Anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop
- Revision: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`
- Copied from: `skills/install-anti-slop/assets/anti-slop/`, verified identical to the production files in `src/` at that revision.
- Generic entry point: `tools/oxlint/anti-slop/index.ts`
- Effect entry point: `tools/oxlint/anti-slop/effect/index.ts`
- Local rule deviations: none. Upstream tests and installation tooling are not included.
- Dependencies: see [`package.json`](../../../package.json) for versions and [README development guidance](../../../README.md#development) for the matching-version requirement.

Keep vendored plugin files and licenses byte-for-byte identical to the selected upstream revision. When updating, copy the installation assets from that revision and update this record. Configure repository policy in [`oxlint.config.ts`](../../../oxlint.config.ts).

[`LICENSE`](LICENSE) covers anti-slop (MIT). The spacing engine carries its own [license](vendor/eslint-stylistic/LICENSE) and [provenance](vendor/eslint-stylistic/UPSTREAM.md). That provenance is retained from anti-slop upstream: its `pnpm` commands and test-file paths refer to the upstream repository, whose tests are not vendored here. Use [README development guidance](../../../README.md#development) for local checks.
