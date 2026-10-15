import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect, Exit, Fiber, Option, Predicate } from "effect";

import {
  downloadModel,
  modelDir,
  modelPath,
} from "../src/providers/kokoro/model.ts";
import { serveGatedModels } from "./helpers/model-server.ts";
import { waitUntil } from "./helpers/process.ts";

const sha256 = (bytes: Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** A stand-in for the model: the downloader only needs its checksum and size. */
const good = crypto.getRandomValues(new Uint8Array(1024 * 1024));

const corrupt = crypto.getRandomValues(new Uint8Array(good.byteLength));

const expected = { sha256: sha256(good), size: good.byteLength };

const download = downloadModel(() => Effect.void, expected);

const tempFiles = () =>
  existsSync(modelDir())
    ? readdirSync(modelDir()).filter((f) => f.endsWith(".part"))
    : [];

/** Whether some temp file already holds the first half of `body`, so its download has written to disk. */
const writing = (body: Uint8Array) => {
  const half = Math.floor(body.byteLength / 2);

  return tempFiles().some((f) => {
    const bytes = readFileSync(path.join(modelDir(), f));

    return (
      bytes.byteLength >= half &&
      bytes.subarray(0, half).equals(body.subarray(0, half))
    );
  });
};

// Every test is serial, even under --concurrent: they share VOIX_HOME and VOIX_MODEL_URL, both process-wide.
describe("model download", () => {
  const saved = {
    home: process.env.VOIX_HOME,
    url: process.env.VOIX_MODEL_URL,
  };

  let home: string;

  beforeAll(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "voix-download-"));
    process.env.VOIX_HOME = home;
  });

  afterAll(() => {
    if (saved.home === undefined) {
      delete process.env.VOIX_HOME;
    } else {
      process.env.VOIX_HOME = saved.home;
    }

    if (saved.url === undefined) {
      delete process.env.VOIX_MODEL_URL;
    } else {
      process.env.VOIX_MODEL_URL = saved.url;
    }

    rmSync(home, { force: true, recursive: true });
  });

  test.serial(
    "overlapping downloads each publish only their own verified file",
    async () => {
      // The first download receives the model, the second a corrupt file of the same size.
      const gated = serveGatedModels([good, corrupt]);
      process.env.VOIX_MODEL_URL = gated.server.url.href;

      try {
        const first = Effect.runFork(download);
        await gated.started(0);
        await waitUntil(() => writing(good));

        // The second starts while the first is still writing into the same directory.
        const second = Effect.runFork(download);
        await gated.started(1);
        await waitUntil(() => writing(corrupt));

        gated.release(0);
        expect(
          Exit.isSuccess(await Effect.runPromise(Fiber.await(first)))
        ).toBe(true);
        expect(sha256(await Bun.file(modelPath()).bytes())).toBe(
          expected.sha256
        );

        gated.release(1);
        const failed = await Effect.runPromise(Fiber.await(second));
        expect(
          Option.exists(
            Exit.findErrorOption(failed),
            Predicate.isTagged("ChecksumMismatch")
          )
        ).toBe(true);

        expect(sha256(await Bun.file(modelPath()).bytes())).toBe(
          expected.sha256
        );
        expect(readdirSync(modelDir())).toEqual(["model.onnx"]);
      } finally {
        await gated.server.stop(true);
        rmSync(modelDir(), { force: true, recursive: true });
      }
    }
  );

  test.serial(
    "a file that could not be written in full is never published",
    async () => {
      const gated = serveGatedModels([good]);
      gated.release(0);

      try {
        // The child may write at most 256 blocks (128 or 256 KiB, depending on the shell), far less than the model.
        const child = Bun.spawn(
          [
            "/bin/sh",
            "-c",
            'ulimit -f 256 && exec "$@"',
            "sh",
            process.execPath,
            path.join(import.meta.dir, "fixtures/download.ts"),
            expected.sha256,
            String(expected.size),
          ],
          {
            env: {
              ...process.env,
              // Keeps Bun's own cache writes out of the child's file-size limit.
              BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
              VOIX_HOME: home,
              VOIX_MODEL_URL: gated.server.url.href,
            },
            stderr: "pipe",
            stdout: "pipe",
          }
        );

        const [output, code] = await Promise.all([
          new Response(child.stdout).text(),
          child.exited,
        ]);

        expect({ code, output: JSON.parse(output) }).toEqual({
          code: 0,
          output: { error: "DownloadFailed", success: false },
        });
        expect(existsSync(modelPath())).toBe(false);
        expect(tempFiles()).toEqual([]);
      } finally {
        await gated.server.stop(true);
        rmSync(modelDir(), { force: true, recursive: true });
      }
    }
  );

  test.serial(
    "removes temp files crashed attempts left, not a live peer's",
    async () => {
      const gated = serveGatedModels([good]);
      process.env.VOIX_MODEL_URL = gated.server.url.href;
      gated.release(0);

      try {
        mkdirSync(modelDir(), { recursive: true });
        const crashed = `${modelPath()}.1-crashed.part`;
        const legacy = `${modelPath()}.part`;
        const live = `${modelPath()}.2-live.part`;

        for (const file of [crashed, legacy, live]) {
          writeFileSync(file, "partial");
        }

        const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
        utimesSync(crashed, twoDaysAgo, twoDaysAgo);
        utimesSync(legacy, twoDaysAgo, twoDaysAgo);

        await Effect.runPromise(download);

        expect(readdirSync(modelDir()).toSorted()).toEqual([
          "model.onnx",
          path.basename(live),
        ]);
      } finally {
        await gated.server.stop(true);
        rmSync(modelDir(), { force: true, recursive: true });
      }
    }
  );
});
