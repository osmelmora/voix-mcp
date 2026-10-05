import path from "node:path";

import { Effect } from "effect";

export const cliCommand = () =>
  process.env.VOIX_BIN
    ? [path.resolve(process.env.VOIX_BIN)]
    : [process.execPath, path.join(import.meta.dir, "../../src/main.ts")];

export const waitUntil = (ready: () => boolean) =>
  Effect.runPromise(
    Effect.gen(function* waitForCondition() {
      while (!ready()) {
        yield* Effect.sleep("10 millis");
      }
    }).pipe(Effect.timeout("5 seconds"))
  );
