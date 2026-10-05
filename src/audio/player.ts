import { Context, Effect, FileSystem, Layer, Match, Result } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { PlaybackFailed } from "../core/errors/playback-failed.ts";
import { PlayerNotFound } from "../core/errors/player-not-found.ts";
import { encodeWav } from "./wav.ts";

export interface PlayerService {
  readonly name: string;
  /** Play to completion. Interruption stops playback. */
  readonly play: (
    pcm: Float32Array,
    sampleRate: number
  ) => Effect.Effect<void, PlaybackFailed | PlayerNotFound>;
}

export class Player extends Context.Service<Player, PlayerService>()(
  "voix/Player"
) {}

interface PlayerCommand {
  readonly name: string;
  readonly command: string;
}

const findCommands = (commands: readonly PlayerCommand[]) =>
  Effect.sync(() => {
    const available: PlayerCommand[] = [];

    for (const candidate of commands) {
      const executable = Bun.which(candidate.command);

      if (executable !== null) {
        available.push({ command: executable, name: candidate.name });
      }
    }

    return available;
  });

/** Play a WAV through each installed backend until one succeeds. Interruptions never retry. */
const commandPlayer = (
  commands: readonly PlayerCommand[],
  platform: NodeJS.Platform
): Layer.Layer<
  Player,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> =>
  Layer.effect(
    Player,
    Effect.gen(function* makePlayer() {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const installed = yield* findCommands(commands);

      const playFile = (command: PlayerCommand, file: string) =>
        Effect.gen(function* playFileBody() {
          const handle = yield* ChildProcess.make(command.command, [file], {
            stderr: "ignore",
            stdin: "ignore",
            stdout: "ignore",
          });

          const code = yield* handle.exitCode;

          if (code !== 0) {
            return yield* new PlaybackFailed({
              reason: `${command.name} exited with code ${code}`,
            });
          }
        }).pipe(
          Effect.scoped,
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            spawner
          ),
          Effect.catchTag(
            "PlatformError",
            (failure) =>
              new PlaybackFailed({
                reason: `${command.name}: ${failure.message}`,
              })
          )
        );

      const play = (pcm: Float32Array, sampleRate: number) =>
        Effect.gen(function* playPcm() {
          // Resolve again for every playback so a long-running MCP server sees newly installed players.
          const available = yield* findCommands(commands);

          if (available.length === 0) {
            return yield* new PlayerNotFound({ platform });
          }

          const file = yield* fs.makeTempFileScoped({
            prefix: "voix-",
            suffix: ".wav",
          });

          yield* fs.writeFile(file, encodeWav(pcm, sampleRate));
          const failures: string[] = [];

          for (const command of available) {
            const result = yield* Effect.result(playFile(command, file));

            if (Result.isSuccess(result)) {
              return;
            }

            failures.push(result.failure.reason);
          }

          return yield* new PlaybackFailed({ reason: failures.join("; ") });
        }).pipe(
          Effect.scoped,
          Effect.catchTag(
            "PlatformError",
            (failure) => new PlaybackFailed({ reason: failure.message })
          )
        );

      return {
        name:
          installed.length === 0
            ? "unavailable"
            : installed.map((command) => command.name).join(" → "),
        play,
      };
    })
  );

export const AfplayPlayer = commandPlayer(
  [{ command: "/usr/bin/afplay", name: "afplay" }],
  "darwin"
);

export const LinuxPlayer = commandPlayer(
  [
    { command: "pw-play", name: "pw-play" },
    { command: "paplay", name: "paplay" },
    { command: "aplay", name: "aplay" },
  ],
  "linux"
);

/** Discards audio. Used for tests and CI (VOIX_PLAYER=none). */
export const NullPlayer: Layer.Layer<Player> = Layer.succeed(Player, {
  name: "none",
  play: () => Effect.void,
});

const selectPlayer = () => {
  if (process.env.VOIX_PLAYER === "none") {
    return NullPlayer;
  }

  return Match.value(process.platform).pipe(
    Match.when("darwin", () => AfplayPlayer),
    Match.when("linux", () => LinuxPlayer),
    Match.orElse((platform) => commandPlayer([], platform))
  );
};

/** Pick the player for this process: VOIX_PLAYER=none disables output; otherwise the platform default. */
export const PlayerFromEnv: Layer.Layer<
  Player,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> = selectPlayer();
