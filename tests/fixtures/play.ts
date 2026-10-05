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

  yield* player.play(new Float32Array([0, 0.5, -0.5]), 24_000);
}).pipe(
  Effect.provide(layer),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain
);
