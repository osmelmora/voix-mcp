import { describe, expect, test } from "bun:test";

import { Effect, Layer, Option, Stream } from "effect";

import { Player } from "../src/audio/player.ts";
import { Speaker, SpeakerLive } from "../src/core/speaker.ts";
import { Provider } from "../src/providers/provider.ts";
import type { AudioChunk } from "../src/providers/provider.ts";

const RATE = 100;

/** Fake provider: each sentence takes `synthMs` and yields one chunk whose length encodes the sentence index. */
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
          Effect.as<AudioChunk>({
            pcm: new Float32Array(text.length),
            sampleRate: RATE,
            text,
          })
        )
      ),
    voices: [{ gender: "female", id: "v1", language: "en-US", name: "One" }],
  });

interface Played {
  readonly samples: number;
  readonly at: number;
}

/** Recording player: each play takes `playMs` and records the batch size. */
const makeRecorder = (playMs: number) => {
  const played: Played[] = [];
  const start = Date.now();

  const layer = Layer.succeed(Player, {
    name: "recorder",
    play: (pcm) =>
      Effect.gen(function* recordPlay() {
        played.push({ at: Date.now() - start, samples: pcm.length });
        yield* Effect.sleep(`${playMs} millis`);
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
  test("returns once the first sentence plays and batches the rest", async () => {
    await run(20, 60, (speaker, played) =>
      Effect.gen(function* batching() {
        const result = yield* speaker.speak({ text: "One. Two. Three. Four." });
        expect(result.status).toBe("speaking");
        expect(result.sentences).toBe(4);
        expect(result.queued_behind).toBe(0);
        // first sentence is playing, the rest are still synthesizing
        expect(played.length).toBe(1);
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
        expect(a.status).toBe("speaking");
        expect(b.status).toBe("queued");
        expect(b.queued_behind).toBe(1);
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
        const started = Date.now();
        yield* speaker.speak({ text: "First. Second. Third." });
        const queued = yield* speaker.speak({ text: "Later." });
        expect(queued.status).toBe("queued");
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
});
