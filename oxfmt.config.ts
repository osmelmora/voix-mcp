import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  // Keep vendored model assets byte-for-byte identical to upstream.
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "src/providers/kokoro/assets/**",
  ],
});
