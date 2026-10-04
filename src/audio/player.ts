import { Context, Effect, FileSystem, Layer } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { PlaybackFailed, PlayerNotFound } from "../core/errors.ts";
import { encodeWav } from "./wav.ts";

export interface PlayerShape {
  readonly name: string;
  /** Play to completion. Interrupting the effect stops playback immediately. */
  readonly play: (
    pcm: Float32Array,
    sampleRate: number
  ) => Effect.Effect<void, PlaybackFailed | PlayerNotFound>;
}

export class Player extends Context.Service<Player, PlayerShape>()(
  "voix/Player"
) {}

const AFPLAY = "/usr/bin/afplay";

/** macOS: write a WAV to a temp file and play it with afplay as a scoped child process. */
export const AfplayPlayer: Layer.Layer<
  Player,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(
  Player,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const play = (pcm: Float32Array, sampleRate: number) =>
      Effect.gen(function* () {
        if (!(yield* fs.exists(AFPLAY))) {
          return yield* new PlayerNotFound({ platform: process.platform });
        }
        const file = yield* fs.makeTempFileScoped({
          prefix: "voix-",
          suffix: ".wav",
        });
        yield* fs.writeFile(file, encodeWav(pcm, sampleRate));
        const handle = yield* ChildProcess.make(AFPLAY, [file], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
        });
        const code = yield* handle.exitCode;
        if (code !== 0) {
          return yield* new PlaybackFailed({
            reason: `afplay exited with code ${code}`,
          });
        }
      }).pipe(
        Effect.scoped,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.catchTag(
          "PlatformError",
          (e) => new PlaybackFailed({ reason: e.message })
        )
      );
    return { name: "afplay", play };
  })
);

/** Discards audio. Used for tests and CI (VOIX_PLAYER=none). */
export const NullPlayer: Layer.Layer<Player> = Layer.succeed(Player, {
  name: "none",
  play: () => Effect.void,
});

/** Pick the player for this process: VOIX_PLAYER=none disables output; otherwise the platform default. */
export const PlayerFromEnv: Layer.Layer<
  Player,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> = selectPlayer();

function selectPlayer() {
  if (process.env.VOIX_PLAYER === "none") {
    return NullPlayer;
  }
  if (process.platform === "darwin") {
    return AfplayPlayer;
  }
  return Layer.succeed(Player, {
    name: "unsupported",
    play: () => new PlayerNotFound({ platform: process.platform }),
  });
}
