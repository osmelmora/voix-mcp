import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Scheduler,
} from "effect";

import { KokoroProvider } from "../src/providers/kokoro/index.ts";
import { modelPath } from "../src/providers/kokoro/model.ts";
import { Provider } from "../src/providers/provider.ts";
import {
  serveMissingModel,
  serveStalledModel,
} from "./helpers/model-server.ts";

const waitFor = (ready: Effect.Effect<boolean>) =>
  Effect.gen(function* waitForBody() {
    while (!(yield* ready)) {
      yield* Effect.sleep("10 millis");
    }
  }).pipe(Effect.timeout("5 seconds"));

/** Operations a fiber runs before yielding; small, so a sweep of caller prefixes covers every yield point. */
const OP_BUDGET = 64;

/**
 * Whether a second caller still gets the download's own failure after the first caller was interrupted. The first
 * caller runs `prefix` operations before calling prepare and is interrupted at its first yield, so a sweep of
 * prefixes lands the interruption on every operation of prepare's start-up.
 */
const laterCallerSettles = (prefix: number) =>
  Effect.gen(function* interruptedFirstCaller() {
    const provider = yield* Provider;

    const first = yield* Effect.forkChild(
      Effect.gen(function* firstCaller() {
        for (let i = 0; i < prefix; i += 1) {
          yield* Effect.sync(() => {});
        }

        yield* provider.prepare;
      })
    );

    yield* Effect.yieldNow;
    yield* Fiber.interrupt(first);

    const exit = yield* Effect.exit(
      provider.prepare.pipe(Effect.timeout("2 seconds"))
    );

    return Option.exists(
      Exit.findErrorOption(exit),
      Predicate.isTagged("DownloadFailed")
    );
  }).pipe(Effect.provide(KokoroProvider));

// Every test is serial, even under --concurrent: each points the provider at its server through process-wide
// environment variables.
describe("kokoro preparation", () => {
  const stalled = serveStalledModel();
  const missing = serveMissingModel();

  const saved = {
    home: process.env.VOIX_HOME,
    url: process.env.VOIX_MODEL_URL,
  };

  let home: string;

  beforeAll(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "voix-prepare-"));
    process.env.VOIX_HOME = home;
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
    await missing.server.stop(true);
    rmSync(home, { force: true, recursive: true });
  });

  test.serial(
    "outlives interrupted callers and ends with the provider",
    async () => {
      process.env.VOIX_MODEL_URL = stalled.server.url.href;

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
    }
  );

  test.serial(
    "a caller interrupted at any point never strands later callers",
    async () => {
      process.env.VOIX_MODEL_URL = missing.server.url.href;

      const stranded = await Effect.runPromise(
        Effect.filter(
          Array.from({ length: OP_BUDGET }, (_, prefix) => prefix),
          (prefix) =>
            Effect.map(laterCallerSettles(prefix), (settled) => !settled)
        ).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, OP_BUDGET))
      );

      expect(stranded).toEqual([]);
    },
    30_000
  );

  test.serial("fails fast once the provider is closed", async () => {
    process.env.VOIX_MODEL_URL = missing.server.url.href;
    const before = missing.requests();

    const exit = await Effect.runPromise(
      Effect.gen(function* afterClose() {
        const context = yield* Effect.scoped(Layer.build(KokoroProvider));

        return yield* Effect.exit(
          Context.get(context, Provider).prepare.pipe(
            Effect.timeout("2 seconds")
          )
        );
      })
    );

    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(missing.requests()).toBe(before);
  });
});
