// Loads onnxruntime-node. Inside a compiled executable Bun extracts the native addon to $TMPDIR and
// the addon looks for libonnxruntime.1.dylib next to itself (@rpath = @loader_path), so the dylib is
// embedded as an asset and copied there before the dynamic import.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";
import type * as OnnxRuntime from "onnxruntime-node";

import dylibAsset from "../../../node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib" with { type: "file" };
import { SynthFailed } from "../../core/errors/synth-failed.ts";

export type Ort = typeof OnnxRuntime;

const DYLIB_NAME = "libonnxruntime.1.dylib";

export const isEmbedded = (): boolean => dylibAsset.startsWith("/$bunfs/");

export const dylibDestination = (): string =>
  path.join(os.tmpdir(), DYLIB_NAME);

const materializeDylib = async (): Promise<void> => {
  if (!isEmbedded()) {
    return;
  }
  const dest = dylibDestination();
  const src = Bun.file(dylibAsset);
  if (fs.existsSync(dest) && fs.statSync(dest).size === src.size) {
    return;
  }
  await Bun.write(dest, src);
};

let ortPromise: Promise<Ort> | undefined;

const importOrt = async (): Promise<Ort> => {
  await materializeDylib();
  return import("onnxruntime-node");
};

export const loadOrt: Effect.Effect<Ort, SynthFailed> = Effect.tryPromise({
  catch: (e) =>
    new SynthFailed({
      reason: `could not load ONNX runtime: ${e instanceof Error ? e.message : String(e)}`,
    }),
  try: () => (ortPromise ??= importOrt()),
});
