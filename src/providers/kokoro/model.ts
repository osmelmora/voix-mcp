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

/** Where the model is fetched from. Override with VOIX_MODEL_URL (a mirror, or a test server); the pinned SHA-256 still applies. */
export const modelUrl = (): string =>
  process.env.VOIX_MODEL_URL ?? KOKORO_MODEL.url;

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

/** A download's temp file this old was left by a crashed attempt: a live one is written to far more often. */
const STALE_TEMP_MS = 24 * 60 * 60 * 1000;

const isTempFile = (name: string) =>
  name.startsWith("model.onnx.") && name.endsWith(".part");

/** Best effort: removes temp files that crashed attempts left behind, never a recent one a live peer may own. */
const removeStaleTempFiles = (dir: string) =>
  Effect.try({
    catch: (e) => e,
    try: () => {
      for (const name of fs.readdirSync(dir).filter(isTempFile)) {
        const file = path.join(dir, name);
        const stat = fs.statSync(file, { throwIfNoEntry: false });

        if (stat !== undefined && Date.now() - stat.mtimeMs > STALE_TEMP_MS) {
          fs.rmSync(file, { force: true });
        }
      }
    },
  }).pipe(Effect.ignore);

/** What a download must match before it is published. */
export interface ExpectedModel {
  readonly sha256: string;
  readonly size: number;
}

/** Fetches the model into `part`, verifies it, and only then renames exactly that file to `target`. */
const receive = ({
  expected,
  fail,
  onProgress,
  part,
  target,
  url,
}: {
  readonly expected: ExpectedModel;
  readonly fail: (reason: string) => DownloadFailed;
  readonly onProgress: (received: number, total: number) => Effect.Effect<void>;
  readonly part: string;
  readonly target: string;
  readonly url: string;
}): Effect.Effect<void, DownloadFailed | ChecksumMismatch> =>
  Effect.gen(function* receiveBody() {
    const response = yield* Effect.tryPromise({
      catch: (e) => fail(e instanceof Error ? e.message : String(e)),
      try: (signal) => fetch(url, { redirect: "follow", signal }),
    });

    const { body } = response;

    if (!response.ok || body === null) {
      return yield* fail(`HTTP ${response.status}`);
    }

    const total =
      Number(response.headers.get("content-length")) || expected.size;

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

    if (actual !== expected.sha256) {
      return yield* new ChecksumMismatch({
        actual,
        expected: expected.sha256,
        path: target,
      });
    }

    yield* Effect.try({
      catch: (e) => fail(String(e)),
      try: () => fs.renameSync(part, target),
    });
  });

export const downloadModel = (
  onProgress: (received: number, total: number) => Effect.Effect<void>,
  expected: ExpectedModel = KOKORO_MODEL
): Effect.Effect<void, DownloadFailed | ChecksumMismatch> =>
  Effect.gen(function* download() {
    const target = modelPath();
    // Each attempt writes its own file, in the model's directory so the final rename stays atomic: concurrent
    // downloads (two processes on a cold cache) never write into, publish, or delete each other's file.
    const part = `${target}.${process.pid}-${crypto.randomUUID()}.part`;

    const url = modelUrl();

    const fail = (reason: string) => new DownloadFailed({ reason, url });

    yield* Effect.try({
      catch: (e) => fail(String(e)),
      try: () => fs.mkdirSync(modelDir(), { recursive: true }),
    });
    yield* removeStaleTempFiles(modelDir());

    yield* receive({ expected, fail, onProgress, part, target, url }).pipe(
      Effect.ensuring(
        Effect.try({
          catch: (e) => e,
          try: () => fs.rmSync(part, { force: true }),
        }).pipe(Effect.ignore)
      )
    );
  });
