import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  extends: [core],
  ignorePatterns: core.ignorePatterns,
  rules: {
    // Effect.gen callbacks are intentionally anonymous generators.
    "func-names": ["error", "as-needed", { generators: "never" }],
    // Keep hoisted helpers and arrow callbacks in the existing module style.
    "func-style": ["error", "declaration", { allowArrowFunctions: true }],
    "no-use-before-define": ["error", { functions: false }],
    // Effect option objects are ordered by operation, and may contain yields.
    "sort-keys": "off",
  },
  overrides: [
    ...(vitest.overrides ?? []).map((preset) => ({
      ...preset,
      rules: {
        ...preset.rules,
        // Test APIs come from bun:test, not the vitest package.
        "vitest/prefer-importing-vitest-globals": "off" as const,
      },
    })),
    {
      files: ["src/core/errors.ts"],
      rules: {
        // Effect's tagged-error factories and schema/type pairs share this module.
        "class-methods-use-this": "off",
        "max-classes-per-file": "off",
        "no-redeclare": "off",
        "unicorn/throw-new-error": "off",
      },
    },
    {
      files: [
        "src/core/text.ts",
        "src/providers/kokoro/{normalize,phonemize}.ts",
      ],
      rules: {
        // Preserve existing regex semantics and positional replacement groups.
        "prefer-named-capture-group": "off",
        "require-unicode-regexp": "off",
      },
    },
    {
      files: ["src/providers/kokoro/normalize.ts"],
      rules: {
        // Keep upstream Kokoro's integer-prefix parsing behavior.
        "unicorn/prefer-number-coercion": "off",
      },
    },
  ],
});
