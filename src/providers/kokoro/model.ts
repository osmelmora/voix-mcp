import fs from "node:fs";
import path from "node:path";

import { Effect, Stream } from "effect";

import { ChecksumMismatch } from "../../core/errors/checksum-mismatch.ts";
import { DownloadFailed } from "../../core/errors/download-failed.ts";
import { modelsDir } from "../../core/paths.ts";

export const KOKORO_MODEL = {
  license: "Apache-2.0",
  precision: "fp32",
  sha256: "8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb",
  size: 325_532_232,
  url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx",
  version: "v1.0",
} as const;

export const modelDir = (): string =>
  path.join(modelsDir(), `kokoro-${KOKORO_MODEL.version}`);
export const modelPath = (): string => path.join(modelDir(), "model.onnx");

/** Installed means present with the expected size; the checksum is verified once, right after download. */
export const isModelInstalled = (): boolean => {
  const p = modelPath();
  return fs.existsSync(p) && fs.statSync(p).size === KOKORO_MODEL.size;
};

const PROGRESS_STEP = 2 * 1024 * 1024;
const FLUSH_STEP = 16 * 1024 * 1024;

export const downloadModel = (
  onProgress: (received: number, total: number) => Effect.Effect<void>
): Effect.Effect<void, DownloadFailed | ChecksumMismatch> =>
  Effect.gen(function* download() {
    const target = modelPath();
    const part = `${target}.part`;
    const fail = (reason: string) =>
      new DownloadFailed({ reason, url: KOKORO_MODEL.url });

    yield* Effect.try({
      catch: (e) => fail(String(e)),
      try: () => fs.mkdirSync(modelDir(), { recursive: true }),
    });
    yield* Effect.try({
      catch: (e) => fail(String(e)),
      try: () => fs.rmSync(part, { force: true }),
    });

    const response = yield* Effect.tryPromise({
      catch: (e) => fail(e instanceof Error ? e.message : String(e)),
      try: (signal) => fetch(KOKORO_MODEL.url, { redirect: "follow", signal }),
    });
    const { body } = response;
    if (!response.ok || body === null) {
      return yield* fail(`HTTP ${response.status}`);
    }
    const total =
      Number(response.headers.get("content-length")) || KOKORO_MODEL.size;

    const hasher = new Bun.CryptoHasher("sha256");
    const writer = Bun.file(part).writer();
    let received = 0;
    let lastReported = 0;
    let lastFlushed = 0;

    yield* Stream.fromReadableStream({
      evaluate: () => body,
      onError: (e) => fail(e instanceof Error ? e.message : String(e)),
    }).pipe(
      Stream.runForEach((chunk) =>
        Effect.gen(function* writeChunk() {
          hasher.update(chunk);
          writer.write(chunk);
          received += chunk.byteLength;
          if (received - lastFlushed >= FLUSH_STEP) {
            lastFlushed = received;
            yield* Effect.promise(() => Promise.resolve(writer.flush()));
          }
          if (received - lastReported >= PROGRESS_STEP || received >= total) {
            lastReported = received;
            yield* onProgress(received, total);
          }
        })
      ),
      Effect.ensuring(
        Effect.promise(() => Promise.resolve(writer.end())).pipe(Effect.ignore)
      )
    );

    const actual = hasher.digest("hex");
    if (actual !== KOKORO_MODEL.sha256) {
      fs.rmSync(part, { force: true });
      return yield* new ChecksumMismatch({
        actual,
        expected: KOKORO_MODEL.sha256,
        path: target,
      });
    }
    yield* Effect.try({
      catch: (e) => fail(String(e)),
      try: () => fs.renameSync(part, target),
    });
  });
