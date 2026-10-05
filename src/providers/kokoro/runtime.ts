// Load the native runtime before importing onnxruntime-node. Bun extracts the addon separately
// from its companion shared library, so the platform loader needs help finding that library.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";
import type * as OnnxRuntime from "onnxruntime-node";

import { SynthFailed } from "../../core/errors/synth-failed.ts";

export type Ort = typeof OnnxRuntime;

// Conditional imports let Bun embed only the target platform's library when cross-compiling.
const { default: libraryAsset } =
  process.platform === "linux"
    ? await import(
        "../../../node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1",
        { with: { type: "file" } }
      )
    : await import(
        "../../../node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib",
        { with: { type: "file" } }
      );

const DYLIB_NAME = "libonnxruntime.1.dylib";

export const isEmbedded = (): boolean => libraryAsset.startsWith("/$bunfs/");

const dylibDestination = (): string => path.join(os.tmpdir(), DYLIB_NAME);

const loadFailed = (cause: unknown) =>
  new SynthFailed({
    reason: `could not load ONNX runtime: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

// Written, never read: holding the handle keeps the library loaded for the Node addon's lifetime.
// The OS releases it when the process exits.
let _preloadedLibrary: { readonly close: () => void } | undefined;

const preloadLibrary = Effect.tryPromise({
  catch: loadFailed,
  try: async () => {
    const { dlopen } = await import("bun:ffi");

    // Bun extracts this asset to its user/content-specific temp file. Preloading it lets
    // the ELF loader resolve the addon's libonnxruntime.so.1 dependency by SONAME,
    // without trusting a predictable /tmp/libonnxruntime.so.1 shared by every user.
    _preloadedLibrary = dlopen(libraryAsset, {
      OrtGetApiBase: { args: [], returns: "ptr" },
    });
  },
});

const materializeDylib = Effect.tryPromise({
  catch: loadFailed,
  try: async () => {
    // macOS: @loader_path expects the dylib beside Bun's extracted addon.
    const dest = dylibDestination();
    const src = Bun.file(libraryAsset);

    if (fs.existsSync(dest) && fs.statSync(dest).size === src.size) {
      return;
    }

    await Bun.write(dest, src);
  },
});

const runtimePlatform =
  process.platform === "linux"
    ? {
        describe: () => `${libraryAsset} (embedded; extracted by Bun on load)`,
        prepare: preloadLibrary,
      }
    : {
        describe: dylibDestination,
        prepare: materializeDylib,
      };

export const runtimeLibraryDescription = runtimePlatform.describe;

const importOrt: Effect.Effect<Ort, SynthFailed> = Effect.gen(
  function* importOrt() {
    if (isEmbedded()) {
      yield* runtimePlatform.prepare;
    }

    return yield* Effect.tryPromise({
      catch: loadFailed,
      try: () => import("onnxruntime-node"),
    });
  }
);

/** Load ONNX Runtime once per process; later calls share the first result. */
export const loadOrt: Effect.Effect<Ort, SynthFailed> = Effect.runSync(
  Effect.cached(importOrt)
);
