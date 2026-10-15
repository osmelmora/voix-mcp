import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect, Fiber, Option } from "effect";

import { KokoroProvider } from "../src/providers/kokoro/index.ts";
import { modelPath } from "../src/providers/kokoro/model.ts";
import { Provider } from "../src/providers/provider.ts";
import { serveStalledModel } from "./helpers/model-server.ts";

const waitFor = (ready: Effect.Effect<boolean>) =>
  Effect.gen(function* waitForBody() {
    while (!(yield* ready)) {
      yield* Effect.sleep("10 millis");
    }
  }).pipe(Effect.timeout("5 seconds"));

describe("kokoro preparation", () => {
  const stalled = serveStalledModel();

  const saved = {
    home: process.env.VOIX_HOME,
    url: process.env.VOIX_MODEL_URL,
  };

  let home: string;

  beforeAll(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "voix-prepare-"));
    process.env.VOIX_HOME = home;
    process.env.VOIX_MODEL_URL = stalled.server.url.href;
  });

  afterAll(async () => {
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

    await stalled.server.stop(true);
    rmSync(home, { force: true, recursive: true });
  });

  test("outlives interrupted callers and ends with the provider", async () => {
    await Effect.runPromise(
      Effect.gen(function* sharedDownload() {
        const provider = yield* Provider;

        const downloading = provider.status.pipe(
          Effect.map((s) => Option.isSome(s.downloading))
        );

        const first = yield* Effect.forkChild(provider.prepare);
        yield* waitFor(downloading);
        yield* Fiber.interrupt(first);

        const second = yield* Effect.forkChild(provider.prepare);
        yield* Effect.sleep("100 millis");
        yield* Fiber.interrupt(second);

        expect(yield* downloading).toBe(true);
        expect(stalled.requests()).toBe(1);
        expect(stalled.aborted()).toBe(0);
      }).pipe(Effect.provide(KokoroProvider))
    );

    await Effect.runPromise(
      waitFor(Effect.sync(() => stalled.aborted() === 1))
    );
    expect(existsSync(modelPath())).toBe(false);
  });
});
