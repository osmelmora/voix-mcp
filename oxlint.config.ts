import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import jest from "ultracite/oxlint/jest";

export default defineConfig({
  extends: [core, jest],
  ignorePatterns: core.ignorePatterns,
});
