import {
  Cause,
  Console,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Stream,
} from "effect";

import { Player } from "../audio/player.ts";
import { concatPcm } from "../audio/wav.ts";
import { Provider } from "../providers/provider.ts";
import type { AudioChunk } from "../providers/provider.ts";
import type { VoixError } from "./errors.ts";
import { EmptyText } from "./errors/empty-text.ts";
import { InvalidSpeed } from "./errors/invalid-speed.ts";
import { InvalidVoice } from "./errors/invalid-voice.ts";
import { ModelDownloading } from "./errors/model-downloading.ts";
import { SynthFailed } from "./errors/synth-failed.ts";
import { TextTooLong } from "./errors/text-too-long.ts";
import { MAX_TEXT_LENGTH, splitSentences, toSpeakable } from "./text.ts";

export const SPEED_MIN = 0.5;

export const SPEED_MAX = 2;

export const DEFAULT_SPEED = 1;

/** How long `speak` waits for playback to start before giving up with ModelDownloading. */
export const FIRST_AUDIO_TIMEOUT = "45 seconds";

export interface SpeakRequest {
  readonly text: string;
  readonly voice?: string | undefined;
  readonly speed?: number | undefined;
  /** Resolve when this utterance finishes or is stopped, instead of when its first audio starts. */
  readonly wait?: boolean | undefined;
}

/**
 * What became of this utterance when `speak` returned.
 * Without `wait`: "speaking" (the player started), "queued" (behind another utterance), "cancelled" (a stop came first).
 * With `wait`: "finished" (played to the end) or "cancelled" (a stop came first).
 */
export const SpeakStatusSchema = Schema.Literals([
  "speaking",
  "queued",
  "cancelled",
  "finished",
]);

export type SpeakStatus = typeof SpeakStatusSchema.Type;

export const SpeakResultSchema = Schema.Struct({
  queued_behind: Schema.Number,
  sentences: Schema.Number,
  speaking: Schema.Boolean.annotate({
    description:
      "Whether voix is still playing or has queued speech when this call returns.",
  }),
  status: SpeakStatusSchema,
  voice: Schema.String,
});

export type SpeakResult = typeof SpeakResultSchema.Type;

type Started = Extract<SpeakStatus, "speaking" | "cancelled">;

type Ended = Extract<SpeakStatus, "finished" | "cancelled">;

export interface StopResult {
  readonly stopped: boolean;
}

export interface SpeakerService {
  /**
   * Validate and enqueue one utterance. Without `wait`, resolves when the player starts, or at once with "queued".
   * With `wait`, resolves when this utterance finishes or is stopped, and fails with any error it hits, including
   * after playback started. Interrupting the call cancels the utterance.
   */
  readonly speak: (
    request: SpeakRequest
  ) => Effect.Effect<SpeakResult, VoixError>;
  /** Stop current playback and drop everything queued. `stopped` is whether any utterance was actually cut. */
  readonly stop: Effect.Effect<StopResult>;
  /** Resolves when nothing is playing or queued. */
  readonly awaitIdle: Effect.Effect<void>;
}

export class Speaker extends Context.Service<Speaker, SpeakerService>()(
  "voix/Speaker"
) {}

interface Job {
  readonly id: number;
  readonly sentences: readonly string[];
  readonly voice: string;
  readonly speed: number;
  readonly started: Deferred.Deferred<Started, VoixError>;
  readonly cancelled: Ref.Ref<boolean>;
  readonly completed: Deferred.Deferred<Ended, VoixError>;
  /** A waiting caller receives this job's failures, so the job does not log them. */
  readonly wait: boolean;
}

type Message =
  | { readonly _tag: "chunk"; readonly chunk: AudioChunk }
  | { readonly _tag: "end" }
  | { readonly _tag: "error"; readonly error: VoixError };

const Messages = Data.taggedEnum<Message>();

export const SpeakerLive: Layer.Layer<Speaker, never, Provider | Player> =
  Layer.effect(
    Speaker,
    Effect.gen(function* SpeakerLive() {
      const provider = yield* Provider;
      const player = yield* Player;
      const jobs = yield* Queue.unbounded<Job>();

      const current = yield* Ref.make(
        Option.none<{ readonly job: Job; readonly fiber: Fiber.Fiber<void> }>()
      );

      const active = yield* Ref.make(0);
      let nextId = 1;

      // Decrement before waking waiters, so a caller that reads `active` does not still count this job.
      const settle = (job: Job, outcome: Exit.Exit<Ended, VoixError>) =>
        Effect.gen(function* settleJob() {
          yield* Ref.update(active, (n) => n - 1);
          yield* Deferred.done(job.completed, outcome);
          yield* Exit.isFailure(outcome)
            ? Deferred.failCause(job.started, outcome.cause)
            : Deferred.succeed(job.started, "cancelled");
        });

      // Synthesize sentence by sentence into a queue while playing what is ready: the first sentence
      // starts as soon as it exists, every later playback chunk is whatever finished meanwhile.
      const runJob = (job: Job): Effect.Effect<Ended, VoixError> =>
        Effect.gen(function* runJobBody() {
          if (yield* Ref.get(job.cancelled)) {
            return "cancelled" as const;
          }

          const messages = yield* Queue.unbounded<Message>();

          const producer = Stream.fromIterable(job.sentences).pipe(
            Stream.flatMap((text) =>
              provider.synthesize({ speed: job.speed, text, voice: job.voice })
            ),
            Stream.runForEach((chunk) =>
              Queue.offer(messages, Messages.chunk({ chunk }))
            ),
            Effect.matchEffect({
              onFailure: (error) =>
                Queue.offer(messages, Messages.error({ error })),
              onSuccess: () => Queue.offer(messages, Messages.end()),
            })
          );

          yield* Effect.forkChild(producer);

          let finished = false;

          while (!finished) {
            const first = yield* Queue.take(messages);

            if (Messages.$is("end")(first)) {
              break;
            }

            if (Messages.$is("error")(first)) {
              return yield* first.error;
            }

            const batch: AudioChunk[] = [first.chunk];
            let pendingError: VoixError | undefined;

            for (const m of yield* Queue.clear(messages)) {
              if (Messages.$is("chunk")(m)) {
                batch.push(m.chunk);
              } else if (Messages.$is("end")(m)) {
                finished = true;
              } else {
                pendingError = m.error;
              }
            }

            // Only the first batch asks for an acknowledgement. A caller that did not pass `wait`
            // returns then; later failures still end the job.
            const acknowledged = yield* Deferred.isDone(job.started);

            yield* player.play(
              concatPcm(batch.map((c) => c.pcm)),
              first.chunk.sampleRate,
              acknowledged
                ? undefined
                : Deferred.succeed(job.started, "speaking").pipe(Effect.asVoid)
            );

            if (pendingError !== undefined) {
              return yield* pendingError;
            }
          }

          return "finished" as const;
        }).pipe(
          Effect.onExit((exit) =>
            settle(
              job,
              Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
                ? Exit.succeed("cancelled" as const)
                : exit
            )
          ),
          // Effect callbacks return Effects, not Promises.
          // oxlint-disable-next-line promise/prefer-await-to-callbacks
          Effect.tapError((error) =>
            job.wait ? Effect.void : Console.error(`voix: ${error.message}`)
          )
        );

      const worker = Effect.forever(
        Effect.gen(function* worker() {
          const job = yield* Queue.take(jobs);

          const fiber = yield* Effect.forkChild(
            runJob(job).pipe(Effect.ignore)
          );

          yield* Ref.set(current, Option.some({ fiber, job }));
          yield* Fiber.await(fiber);
          yield* Ref.set(current, Option.none());
        })
      );

      yield* Effect.forkScoped(worker);

      const cancelJob = (job: Job) =>
        Effect.gen(function* cancelJobBody() {
          yield* Ref.set(job.cancelled, true);
          const running = yield* Ref.get(current);

          if (Option.isSome(running) && running.value.job.id === job.id) {
            yield* Fiber.interrupt(running.value.fiber);
          }
        });

      const enqueue = (request: SpeakRequest) =>
        Effect.gen(function* enqueueJob() {
          const voice = request.voice ?? provider.defaultVoice;
          const speed = request.speed ?? DEFAULT_SPEED;

          if (!provider.voices.some((v) => v.id === voice)) {
            return yield* new InvalidVoice({
              available: provider.voices.map((v) => v.id),
              voice,
            });
          }

          if (
            !Number.isFinite(speed) ||
            speed < SPEED_MIN ||
            speed > SPEED_MAX
          ) {
            return yield* new InvalidSpeed({
              max: SPEED_MAX,
              min: SPEED_MIN,
              speed,
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
            cancelled: yield* Ref.make(false),
            completed: yield* Deferred.make<Ended, VoixError>(),
            id,
            sentences,
            speed,
            started: yield* Deferred.make<Started, VoixError>(),
            voice,
            wait: request.wait === true,
          };

          const queuedBehind = yield* Ref.getAndUpdate(active, (n) => n + 1);
          yield* Queue.offer(jobs, job);

          return { job, queuedBehind };
        });

      // Give up when the player has not started in time: the model is still downloading, or synthesis stalled.
      const awaitStart = (job: Job) =>
        Deferred.await(job.started).pipe(
          Effect.timeoutOrElse({
            duration: FIRST_AUDIO_TIMEOUT,
            orElse: () =>
              Effect.gen(function* orElse() {
                yield* cancelJob(job);
                const s = yield* provider.status;

                return yield* Option.isSome(s.downloading)
                  ? new ModelDownloading(s.downloading.value)
                  : new SynthFailed({
                      reason: `no audio after ${FIRST_AUDIO_TIMEOUT}`,
                    });
              }),
          })
        );

      const speak = (
        request: SpeakRequest
      ): Effect.Effect<SpeakResult, VoixError> =>
        Effect.gen(function* speakBody() {
          const { job, queuedBehind } = yield* enqueue(request);

          const status: SpeakStatus = yield* Effect.gen(function* resolve() {
            const started =
              queuedBehind === 0 ? yield* awaitStart(job) : "queued";

            return job.wait ? yield* Deferred.await(job.completed) : started;
          }).pipe(Effect.onInterrupt(() => cancelJob(job)));

          return {
            queued_behind: queuedBehind,
            sentences: job.sentences.length,
            speaking: (yield* Ref.get(active)) > 0,
            status,
            voice: job.voice,
          };
        });

      const stop: Effect.Effect<StopResult> = Effect.gen(function* stop() {
        const dropped = yield* Queue.clear(jobs);

        for (const job of dropped) {
          yield* Ref.set(job.cancelled, true);
          yield* settle(job, Exit.succeed("cancelled"));
        }

        const running = yield* Ref.get(current);

        // `current` can still point at a job `settle` already ended.
        const interrupted =
          Option.isSome(running) &&
          !(yield* Deferred.isDone(running.value.job.completed));

        if (Option.isSome(running)) {
          yield* Fiber.interrupt(running.value.fiber);
        }

        return { stopped: dropped.length > 0 || interrupted };
      });

      const awaitIdle: Effect.Effect<void> = Effect.gen(function* awaitIdle() {
        while ((yield* Ref.get(active)) > 0) {
          yield* Effect.sleep("25 millis");
        }
      });

      return { awaitIdle, speak, stop };
    })
  );
