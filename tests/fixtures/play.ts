import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect } from "effect";

import { LinuxPlayer, Player, PlayerFromEnv } from "../../src/audio/player.ts";

const layer = process.argv.includes("--from-env") ? PlayerFromEnv : LinuxPlayer;

Effect.gen(function* playFixture() {
  const player = yield* Player;
  yield* Console.log(player.name);

  if (process.argv.includes("--wait-for-player")) {
    yield* Effect.promise(() => Bun.stdin.text());
  }

  const pcm = new Float32Array([0, 0.5, -0.5]);

  // Like the speaker, the first batch of an utterance waits for an acknowledgement.
  yield* player.play(pcm, 24_000, Effect.void);

  if (process.argv.includes("--repeat")) {
    // A later batch of the same, already acknowledged utterance.
    yield* player.play(pcm, 24_000);
  }

  if (process.argv.includes("--next-utterance")) {
    yield* player.play(pcm, 24_000, Effect.void);
  }
}).pipe(
  Effect.provide(layer),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain
);
