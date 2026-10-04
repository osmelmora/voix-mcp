import {
  Cause,
  Console,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Stream,
} from "effect";

import { Player } from "../audio/player.ts";
import { concatPcm } from "../audio/wav.ts";
import { Provider } from "../providers/provider.ts";
import type { AudioChunk } from "../providers/provider.ts";
import {
  EmptyText,
  InvalidSpeed,
  InvalidVoice,
  ModelDownloading,
  SynthFailed,
  TextTooLong,
} from "./errors.ts";
import type { VoixError } from "./errors.ts";
import { MAX_TEXT_LENGTH, splitSentences, toSpeakable } from "./text.ts";

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2;
export const DEFAULT_SPEED = 1;
/** How long `speak` waits for the first audio before giving up with ModelDownloading. */
export const FIRST_AUDIO_TIMEOUT = "45 seconds";

export interface SpeakRequest {
  readonly text: string;
  readonly voice?: string | undefined;
  readonly speed?: number | undefined;
}

export type SpeakStatus = "speaking" | "queued" | "cancelled";

export interface SpeakResult {
  readonly status: SpeakStatus;
  readonly voice: string;
  readonly sentences: number;
  readonly queued_behind: number;
}

export interface StopResult {
  readonly stopped: boolean;
}

export interface SpeakerShape {
  /** Resolves when this utterance starts playing, or at once with "queued" if something else is playing. */
  readonly speak: (
    request: SpeakRequest
  ) => Effect.Effect<SpeakResult, VoixError>;
  /** Stop current playback and drop everything queued. */
  readonly stop: Effect.Effect<StopResult>;
  /** Resolves when nothing is playing or queued. */
  readonly awaitIdle: Effect.Effect<void>;
}

export class Speaker extends Context.Service<Speaker, SpeakerShape>()(
  "voix/Speaker"
) {}

interface Job {
  readonly id: number;
  readonly sentences: readonly string[];
  readonly voice: string;
  readonly speed: number;
  readonly started: Deferred.Deferred<SpeakStatus, VoixError>;
  readonly cancelled: Ref.Ref<boolean>;
}

type Message =
  | { readonly _tag: "chunk"; readonly chunk: AudioChunk }
  | { readonly _tag: "end" }
  | { readonly _tag: "error"; readonly error: VoixError };

export const SpeakerLive: Layer.Layer<Speaker, never, Provider | Player> =
  Layer.effect(
    Speaker,
    Effect.gen(function* () {
      const provider = yield* Provider;
      const player = yield* Player;
      const jobs = yield* Queue.unbounded<Job>();
      const current = yield* Ref.make(
        Option.none<{ readonly job: Job; readonly fiber: Fiber.Fiber<void> }>()
      );
      const active = yield* Ref.make(0);
      let nextId = 1;

      // Synthesize sentence by sentence into a queue while playing what is ready: the first sentence
      // starts as soon as it exists, every later playback chunk is whatever finished meanwhile.
      const runJob = (job: Job): Effect.Effect<void, VoixError> =>
        Effect.gen(function* () {
          if (yield* Ref.get(job.cancelled)) {
            return;
          }
          const messages = yield* Queue.unbounded<Message>();
          const producer = Stream.fromIterable(job.sentences).pipe(
            Stream.flatMap((text) =>
              provider.synthesize({ text, voice: job.voice, speed: job.speed })
            ),
            Stream.runForEach((chunk) =>
              Queue.offer(messages, { _tag: "chunk", chunk })
            ),
            Effect.matchEffect({
              onFailure: (error) =>
                Queue.offer(messages, { _tag: "error", error }),
              onSuccess: () => Queue.offer(messages, { _tag: "end" }),
            })
          );
          yield* Effect.forkChild(producer);

          let finished = false;
          while (!finished) {
            const first = yield* Queue.take(messages);
            if (first._tag === "end") {
              break;
            }
            if (first._tag === "error") {
              return yield* first.error;
            }
            const batch: AudioChunk[] = [first.chunk];
            let pendingError: VoixError | undefined;
            for (const m of yield* Queue.clear(messages)) {
              if (m._tag === "chunk") {
                batch.push(m.chunk);
              } else if (m._tag === "end") {
                finished = true;
              } else {
                pendingError = m.error;
              }
            }
            // Start playback synchronously (up to its first async boundary) before reporting "speaking",
            // so a caller that returns from speak() can rely on audio being underway.
            const playing = yield* Effect.forkChild(
              player.play(
                concatPcm(batch.map((c) => c.pcm)),
                first.chunk.sampleRate
              ),
              { startImmediately: true }
            );
            yield* Deferred.succeed(job.started, "speaking");
            yield* Fiber.join(playing);
            if (pendingError !== undefined) {
              return yield* pendingError;
            }
          }
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
              ? Deferred.failCause(job.started, exit.cause)
              : Deferred.succeed(job.started, "cancelled")
          ),
          // Effect callbacks return Effects, not Promises.
          // oxlint-disable-next-line promise/prefer-await-to-callbacks
          Effect.tapError((error) => Console.error(`voix: ${error.message}`))
        );

      const worker = Effect.forever(
        Effect.gen(function* () {
          const job = yield* Queue.take(jobs);
          const fiber = yield* Effect.forkChild(
            runJob(job).pipe(Effect.ignore)
          );
          yield* Ref.set(current, Option.some({ job, fiber }));
          yield* Fiber.await(fiber);
          yield* Ref.set(current, Option.none());
          yield* Ref.update(active, (n) => n - 1);
        })
      );
      yield* Effect.forkScoped(worker);

      const cancelJob = (job: Job) =>
        Effect.gen(function* () {
          yield* Ref.set(job.cancelled, true);
          const running = yield* Ref.get(current);
          if (Option.isSome(running) && running.value.job.id === job.id) {
            yield* Fiber.interrupt(running.value.fiber);
          }
        });

      const speak = (
        request: SpeakRequest
      ): Effect.Effect<SpeakResult, VoixError> =>
        Effect.gen(function* () {
          const voice = request.voice ?? provider.defaultVoice;
          const speed = request.speed ?? DEFAULT_SPEED;
          if (!provider.voices.some((v) => v.id === voice)) {
            return yield* new InvalidVoice({
              voice,
              available: provider.voices.map((v) => v.id),
            });
          }
          if (
            !Number.isFinite(speed) ||
            speed < SPEED_MIN ||
            speed > SPEED_MAX
          ) {
            return yield* new InvalidSpeed({
              speed,
              min: SPEED_MIN,
              max: SPEED_MAX,
            });
          }
          if (request.text.length > MAX_TEXT_LENGTH) {
            return yield* new TextTooLong({
              length: request.text.length,
              max: MAX_TEXT_LENGTH,
            });
          }
          const sentences = splitSentences(toSpeakable(request.text));
          if (sentences.length === 0) {
            return yield* new EmptyText();
          }

          const id = nextId;
          nextId += 1;
          const job: Job = {
            id,
            sentences,
            voice,
            speed,
            started: yield* Deferred.make<SpeakStatus, VoixError>(),
            cancelled: yield* Ref.make(false),
          };
          const queuedBehind = yield* Ref.getAndUpdate(active, (n) => n + 1);
          yield* Queue.offer(jobs, job);
          const base = {
            voice,
            sentences: sentences.length,
            queued_behind: queuedBehind,
          };
          if (queuedBehind > 0) {
            return { status: "queued" as const, ...base };
          }

          const status = yield* Deferred.await(job.started).pipe(
            Effect.timeoutOrElse({
              duration: FIRST_AUDIO_TIMEOUT,
              orElse: () =>
                Effect.gen(function* () {
                  yield* cancelJob(job);
                  const s = yield* provider.status;
                  return yield* Option.isSome(s.downloading)
                    ? new ModelDownloading(s.downloading.value)
                    : new SynthFailed({
                        reason: `no audio after ${FIRST_AUDIO_TIMEOUT}`,
                      });
                }),
            }),
            Effect.onInterrupt(() => cancelJob(job))
          );
          return { status, ...base };
        });

      const stop: Effect.Effect<StopResult> = Effect.gen(function* () {
        const dropped = yield* Queue.clear(jobs);
        for (const job of dropped) {
          yield* Ref.set(job.cancelled, true);
          yield* Deferred.succeed(job.started, "cancelled");
          yield* Ref.update(active, (n) => n - 1);
        }
        const running = yield* Ref.get(current);
        if (Option.isSome(running)) {
          yield* Fiber.interrupt(running.value.fiber);
        }
        return { stopped: dropped.length > 0 || Option.isSome(running) };
      });

      const awaitIdle: Effect.Effect<void> = Effect.gen(function* () {
        while ((yield* Ref.get(active)) > 0) {
          yield* Effect.sleep("25 millis");
        }
      });

      return { speak, stop, awaitIdle };
    })
  );
