import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Match,
  Option,
  Ref,
  Result,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { PlaybackFailed } from "../core/errors/playback-failed.ts";
import { PlayerNotFound } from "../core/errors/player-not-found.ts";
import { encodeWav } from "./wav.ts";

export interface PlayerService {
  readonly name: string;
  /**
   * Play to completion. Passing onStarted asks for a truthful start acknowledgement: each backend first
   * passes the platform's startup check, then onStarted runs once real audio has started. Later batches
   * of an already acknowledged utterance omit it. Interruptions stop without retrying.
   */
  readonly play: (
    pcm: Float32Array,
    sampleRate: number,
    onStarted?: Effect.Effect<void>
  ) => Effect.Effect<void, PlaybackFailed | PlayerNotFound>;
}

export class Player extends Context.Service<Player, PlayerService>()(
  "voix/Player"
) {}

/** Temp-file prefix of the silent startup check, so fake players in tests can tell it from speech. */
export const STARTUP_CHECK_PREFIX = "voix-startup-check-";

const STARTUP_CHECK_TIMEOUT = "5 seconds";

interface PlayerCommand {
  readonly name: string;
  readonly command: string;
}

/**
 * Prove that a backend reaches an output device before its real audio is acknowledged.
 * `playSilence` plays one silent sample through the backend; a strategy may skip it.
 */
type StartupCheck = (
  backend: PlayerCommand,
  playSilence: Effect.Effect<void, PlaybackFailed>
) => Effect.Effect<void, PlaybackFailed>;

/** macOS always has an output device, so a successful afplay spawn is proof enough. */
const spawnIsProof: StartupCheck = () => Effect.void;

/** Linux clients spawn without a sound server or device, so they must play silence successfully first. */
const silentSample: StartupCheck = (backend, playSilence) =>
  playSilence.pipe(
    Effect.timeoutOrElse({
      duration: STARTUP_CHECK_TIMEOUT,
      orElse: () =>
        new PlaybackFailed({
          reason: `${backend.name} startup check timed out`,
        }),
    })
  );

interface PlayerPlatform {
  readonly platform: NodeJS.Platform;
  /** Backends in order of preference. */
  readonly commands: readonly PlayerCommand[];
  readonly startupCheck: StartupCheck;
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
  target: PlayerPlatform
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
      const installed = yield* findCommands(target.commands);

      // The backend that last played successfully goes first, so a failing one is not retried every time.
      const lastWorking = yield* Ref.make(Option.none<string>());

      const writeWav = (
        prefix: string,
        pcm: Float32Array,
        sampleRate: number
      ) =>
        Effect.gen(function* writeWavFile() {
          const file = yield* fs.makeTempFileScoped({ prefix, suffix: ".wav" });
          yield* fs.writeFile(file, encodeWav(pcm, sampleRate));

          return file;
        });

      const playFile = (
        backend: PlayerCommand,
        file: string,
        onStarted: Effect.Effect<void>
      ) =>
        Effect.gen(function* playFileBody() {
          const handle = yield* ChildProcess.make(backend.command, [file], {
            forceKillAfter: "250 millis",
            stderr: "ignore",
            stdin: "ignore",
            stdout: "ignore",
          });

          yield* onStarted;
          const code = yield* handle.exitCode;

          if (code !== 0) {
            return yield* new PlaybackFailed({
              reason: `${backend.name} exited with code ${code}`,
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
                reason: `${backend.name}: ${failure.message}`,
              })
          )
        );

      const playSilence = (backend: PlayerCommand, sampleRate: number) =>
        writeWav(STARTUP_CHECK_PREFIX, new Float32Array(1), sampleRate).pipe(
          Effect.flatMap((file) => playFile(backend, file, Effect.void)),
          Effect.scoped,
          Effect.catchTag(
            "PlatformError",
            (failure) => new PlaybackFailed({ reason: failure.message })
          )
        );

      const attempt = (
        backend: PlayerCommand,
        file: string,
        sampleRate: number,
        onStarted: Effect.Effect<void> | undefined
      ) =>
        Effect.gen(function* attemptBackend() {
          // Only an acknowledgement needs proof; a later batch plays straight away.
          if (onStarted !== undefined) {
            yield* target.startupCheck(
              backend,
              playSilence(backend, sampleRate)
            );
          }

          yield* playFile(backend, file, onStarted ?? Effect.void);
        });

      const play = (
        pcm: Float32Array,
        sampleRate: number,
        onStarted?: Effect.Effect<void>
      ) =>
        Effect.gen(function* playPcm() {
          // Resolve again for every playback so a long-running MCP server sees newly installed players.
          const available = yield* findCommands(target.commands);

          if (available.length === 0) {
            return yield* new PlayerNotFound({ platform: target.platform });
          }

          const last = yield* Ref.get(lastWorking);

          const ordered = available.toSorted(
            (a, b) =>
              Number(Option.contains(last, b.name)) -
              Number(Option.contains(last, a.name))
          );

          const file = yield* writeWav("voix-", pcm, sampleRate);
          const failures: string[] = [];

          for (const backend of ordered) {
            const outcome = yield* Effect.result(
              attempt(backend, file, sampleRate, onStarted)
            );

            if (Result.isSuccess(outcome)) {
              yield* Ref.set(lastWorking, Option.some(backend.name));

              return;
            }

            // Forget a failed backend so the next playback falls back to preference order.
            yield* Ref.update(
              lastWorking,
              Option.filter((name) => name !== backend.name)
            );
            failures.push(outcome.failure.reason);
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
            : installed.map((backend) => backend.name).join(" → "),
        play,
      };
    })
  );

export const AfplayPlayer = commandPlayer({
  commands: [{ command: "/usr/bin/afplay", name: "afplay" }],
  platform: "darwin",
  startupCheck: spawnIsProof,
});

export const LinuxPlayer = commandPlayer({
  commands: [
    { command: "pw-play", name: "pw-play" },
    { command: "paplay", name: "paplay" },
    { command: "aplay", name: "aplay" },
  ],
  platform: "linux",
  startupCheck: silentSample,
});

/** Discards audio. Used for tests and CI (VOIX_PLAYER=none). */
export const NullPlayer: Layer.Layer<Player> = Layer.succeed(Player, {
  name: "none",
  play: (_pcm, _sampleRate, onStarted = Effect.void) => onStarted,
});

const selectPlayer = () => {
  if (process.env.VOIX_PLAYER === "none") {
    return NullPlayer;
  }

  return Match.value(process.platform).pipe(
    Match.when("darwin", () => AfplayPlayer),
    Match.when("linux", () => LinuxPlayer),
    Match.orElse((platform) =>
      commandPlayer({ commands: [], platform, startupCheck: spawnIsProof })
    )
  );
};

/** Pick the player for this process: VOIX_PLAYER=none disables output; otherwise the platform default. */
export const PlayerFromEnv: Layer.Layer<
  Player,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> = selectPlayer();
