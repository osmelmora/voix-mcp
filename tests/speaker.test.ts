import { describe, expect, test } from "bun:test";

import { Effect, Fiber, Layer, Option, Stream } from "effect";

import { Player } from "../src/audio/player.ts";
import { SynthFailed } from "../src/core/errors/synth-failed.ts";
import { Speaker, SpeakerLive } from "../src/core/speaker.ts";
import { Provider } from "../src/providers/provider.ts";
import type { AudioChunk } from "../src/providers/provider.ts";

const RATE = 100;

/**
 * Fake provider: each sentence takes `synthMs` and yields one chunk whose length encodes the sentence.
 * A sentence starting with "Fail" fails synthesis instead.
 */
const FakeProvider = (synthMs: number) =>
  Layer.succeed(Provider, {
    defaultVoice: "v1",
    id: "fake",
    prepare: Effect.void,
    status: Effect.succeed({
      downloading: Option.none(),
      installed: true,
      loaded: true,
      modelPath: "/dev/null",
    }),
    synthesize: ({ text }) =>
      Stream.fromEffect(
        Effect.sleep(`${synthMs} millis`).pipe(
          Effect.andThen(
            text.startsWith("Fail")
              ? Effect.fail(new SynthFailed({ reason: "synthesis failed" }))
              : Effect.succeed<AudioChunk>({
                  pcm: new Float32Array(text.length),
                  sampleRate: RATE,
                  text,
                })
          )
        )
      ),
    voices: [{ gender: "female", id: "v1", language: "en-US", name: "One" }],
  });

interface Played {
  readonly samples: number;
  readonly at: number;
  completed: boolean;
}

/** Recording player: each play takes `playMs` and records the batch size. */
const makeRecorder = (playMs: number) => {
  const played: Played[] = [];
  const start = Date.now();

  const layer = Layer.succeed(Player, {
    name: "recorder",
    play: (pcm, _sampleRate, onStarted = Effect.void) =>
      Effect.gen(function* recordPlay() {
        const playback = {
          at: Date.now() - start,
          completed: false,
          samples: pcm.length,
        };

        played.push(playback);
        yield* onStarted;
        yield* Effect.sleep(`${playMs} millis`);
        playback.completed = true;
      }),
  });

  return { layer, played };
};

const run = <A, E>(
  synthMs: number,
  playMs: number,
  body: (speaker: Speaker["Service"], played: Played[]) => Effect.Effect<A, E>
) => {
  const rec = makeRecorder(playMs);

  const layer = SpeakerLive.pipe(
    Layer.provide(Layer.mergeAll(FakeProvider(synthMs), rec.layer))
  );

  return Effect.runPromise(
    Effect.gen(function* runScenario() {
      const speaker = yield* Speaker;

      return yield* body(speaker, rec.played);
    }).pipe(Effect.provide(layer), Effect.scoped)
  );
};

describe("Speaker", () => {
  test("returns once the first sentence starts and batches the rest", async () => {
    await run(20, 60, (speaker, played) =>
      Effect.gen(function* batching() {
        const result = yield* speaker.speak({ text: "One. Two. Three. Four." });
        expect(result).toEqual({
          queued_behind: 0,
          sentences: 4,
          speaking: true,
          status: "speaking",
          voice: "v1",
        });
        expect(played[0]?.samples).toBe("One.".length);
        expect(played[0]?.completed).toBe(false);
        expect(played).toHaveLength(1);
        yield* speaker.awaitIdle;
        const total = played.reduce((n, p) => n + p.samples, 0);
        expect(total).toBe(
          "One.".length + "Two.".length + "Three.".length + "Four.".length
        );
        // later sentences were batched while the first played
        expect(played.length).toBeLessThan(4);
      })
    );
  });

  test("second speak is queued behind the first and plays after it", async () => {
    await run(5, 40, (speaker, played) =>
      Effect.gen(function* queueing() {
        const a = yield* speaker.speak({ text: "AAAA." });
        const b = yield* speaker.speak({ text: "BB." });
        expect(a).toEqual({
          queued_behind: 0,
          sentences: 1,
          speaking: true,
          status: "speaking",
          voice: "v1",
        });
        expect(b).toEqual({
          queued_behind: 1,
          sentences: 1,
          speaking: true,
          status: "queued",
          voice: "v1",
        });
        yield* speaker.awaitIdle;
        expect(played.map((p) => p.samples)).toEqual([
          "AAAA.".length,
          "BB.".length,
        ]);
      })
    );
  });

  test("stop interrupts playback and drops the queue", async () => {
    await run(5, 500, (speaker, played) =>
      Effect.gen(function* stopping() {
        yield* speaker.speak({ text: "First. Second. Third." });
        const started = Date.now();
        const queued = yield* speaker.speak({ text: "Later." });
        expect(queued).toEqual({
          queued_behind: 1,
          sentences: 1,
          speaking: true,
          status: "queued",
          voice: "v1",
        });

        const stopped = yield* speaker.stop;
        expect(stopped.stopped).toBe(true);
        yield* speaker.awaitIdle;
        // did not wait for the 500 ms playback
        expect(Date.now() - started).toBeLessThan(400);
        expect(played.length).toBe(1);
        const again = yield* speaker.stop;
        expect(again.stopped).toBe(false);
      })
    );
  });

  test("validates input", async () => {
    await run(1, 1, (speaker) =>
      Effect.gen(function* validation() {
        const empty = yield* Effect.flip(
          speaker.speak({ text: "## \n```x```" })
        );

        expect(empty._tag).toBe("EmptyText");

        const long = yield* Effect.flip(
          speaker.speak({ text: "a".repeat(10_001) })
        );

        expect(long._tag).toBe("TextTooLong");

        const voice = yield* Effect.flip(
          speaker.speak({ text: "hi", voice: "nope" })
        );

        expect(voice._tag).toBe("InvalidVoice");

        const speed = yield* Effect.flip(
          speaker.speak({ speed: 3, text: "hi" })
        );

        expect(speed._tag).toBe("InvalidSpeed");
      })
    );
  });

  test("wait returns finished with speaking false, and stop finds nothing", async () => {
    await run(5, 20, (speaker, played) =>
      Effect.gen(function* completion() {
        expect(yield* speaker.speak({ text: "One. Two.", wait: true })).toEqual(
          {
            queued_behind: 0,
            sentences: 2,
            speaking: false,
            status: "finished",
            voice: "v1",
          }
        );
        expect(played.map((chunk) => chunk.samples)).toEqual([
          "One.".length,
          "Two.".length,
        ]);
        expect(yield* speaker.stop).toEqual({ stopped: false });
      })
    );
  });

  test("a waited utterance reports speech queued behind it", async () => {
    await run(5, 40, (speaker) =>
      Effect.gen(function* behind() {
        const first = yield* Effect.forkChild(
          speaker.speak({ text: "First.", wait: true }),
          { startImmediately: true }
        );

        yield* Effect.sleep("20 millis");
        const second = yield* speaker.speak({ text: "Second." });
        expect(second).toEqual({
          queued_behind: 1,
          sentences: 1,
          speaking: true,
          status: "queued",
          voice: "v1",
        });
        expect(yield* Fiber.join(first)).toEqual({
          queued_behind: 0,
          sentences: 1,
          speaking: true,
          status: "finished",
          voice: "v1",
        });
      })
    );
  });

  test("a queued waited utterance plays after the first and finishes", async () => {
    await run(5, 20, (speaker, played) =>
      Effect.gen(function* queuedWait() {
        yield* speaker.speak({ text: "AAAA." });
        expect(yield* speaker.speak({ text: "BB.", wait: true })).toEqual({
          queued_behind: 1,
          sentences: 1,
          speaking: false,
          status: "finished",
          voice: "v1",
        });
        expect(played.map((chunk) => chunk.samples)).toEqual([
          "AAAA.".length,
          "BB.".length,
        ]);
      })
    );
  });

  test("stop during a waited utterance returns cancelled", async () => {
    await run(5, 500, (speaker, played) =>
      Effect.gen(function* stopWhileWaiting() {
        const waiting = yield* Effect.forkChild(
          speaker.speak({ text: "Long.", wait: true }),
          { startImmediately: true }
        );

        while (played.length === 0) {
          yield* Effect.sleep("5 millis");
        }

        expect(yield* speaker.stop).toEqual({ stopped: true });
        expect(yield* Fiber.join(waiting)).toEqual({
          queued_behind: 0,
          sentences: 1,
          speaking: false,
          status: "cancelled",
          voice: "v1",
        });
      }).pipe(Effect.timeout("2 seconds"))
    );
  });

  test("stop before a queued waited utterance starts returns cancelled", async () => {
    await run(5, 500, (speaker, played) =>
      Effect.gen(function* stopQueued() {
        yield* speaker.speak({ text: "First." });

        const queued = yield* Effect.forkChild(
          speaker.speak({ text: "Queued.", wait: true }),
          { startImmediately: true }
        );

        yield* Effect.sleep("15 millis");
        yield* speaker.stop;
        expect(yield* Fiber.join(queued)).toEqual({
          queued_behind: 1,
          sentences: 1,
          speaking: true,
          status: "cancelled",
          voice: "v1",
        });
        expect(played).toHaveLength(1);
      }).pipe(Effect.timeout("2 seconds"))
    );
  });

  test("wait fails when synthesis fails before any audio", async () => {
    await run(5, 40, (speaker, played) =>
      Effect.gen(function* failBeforeAudio() {
        const error = yield* Effect.flip(
          speaker.speak({ text: "Fail.", wait: true })
        );

        expect(error._tag).toBe("SynthFailed");
        expect(played).toHaveLength(0);
      })
    );
  });

  test("wait surfaces a failure after playback started", async () => {
    await run(5, 20, (speaker, played) =>
      Effect.gen(function* failAfterAudio() {
        const error = yield* Effect.flip(
          speaker.speak({ text: "One. Fail.", wait: true })
        );

        expect(error._tag).toBe("SynthFailed");
        expect(played.map((chunk) => chunk.samples)).toEqual(["One.".length]);
      })
    );
  });

  test("without wait the same failure returns speaking", async () => {
    await run(5, 20, (speaker) =>
      Effect.gen(function* failAfterReturn() {
        expect(yield* speaker.speak({ text: "One. Fail." })).toEqual({
          queued_behind: 0,
          sentences: 2,
          speaking: true,
          status: "speaking",
          voice: "v1",
        });
        yield* speaker.awaitIdle;
      })
    );
  });
});
