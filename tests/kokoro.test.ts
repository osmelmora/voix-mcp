import { describe, expect, test } from "bun:test";

import { Effect, Stream } from "effect";

import { KokoroProvider } from "../src/providers/kokoro/index.ts";
import { isModelInstalled } from "../src/providers/kokoro/model.ts";
import {
  phonemize,
  splitPhonemes,
  tokenize,
} from "../src/providers/kokoro/phonemize.ts";
import { KOKORO_VOICES } from "../src/providers/kokoro/voices.ts";
import { Provider } from "../src/providers/provider.ts";

const SENTENCE = "Hello from voix. This is a test of local speech.";
// Recorded from kokoro-js 1.2.1 for the same input (see docs/SPEC.md §11).
const EXPECTED_PHONEMES =
  "həlˈoʊ fɹʌm vwˈɑː. ðɪs ɪz ɐ tˈɛst ʌv lˈoʊkəl spˈiːtʃ.";

describe("kokoro phonemizer", () => {
  test("matches kokoro-js output", async () => {
    const ps = await Effect.runPromise(phonemize(SENTENCE, "en-US"));
    expect(ps).toBe(EXPECTED_PHONEMES);
    expect(tokenize(ps).length).toBe(55);
  });

  test("tokens are padded with 0 and capped", () => {
    const ids = tokenize("a".repeat(600));
    expect(ids[0]).toBe(0);
    expect(ids.at(-1)).toBe(0);
    expect(ids.length).toBe(512);
  });

  test("splitPhonemes respects the limit on word boundaries", () => {
    const pieces = splitPhonemes(
      Array.from({ length: 100 }, () => "abcdefghi").join(" "),
      50
    );
    for (const p of pieces) {
      expect([...p].length).toBeLessThanOrEqual(50);
    }
    expect(pieces.join(" ")).toBe(
      Array.from({ length: 100 }, () => "abcdefghi").join(" ")
    );
  });

  test("ships 28 English voices", () => {
    expect(KOKORO_VOICES.length).toBe(28);
    expect(KOKORO_VOICES.find((v) => v.id === "bm_george")?.language).toBe(
      "en-GB"
    );
  });
});

describe("kokoro synthesis", () => {
  test.skipIf(!isModelInstalled())(
    "produces 24 kHz audio of plausible length",
    async () => {
      const chunks = await Effect.runPromise(
        Effect.gen(function* chunks() {
          const provider = yield* Provider;
          return yield* Stream.runCollect(
            provider.synthesize({
              speed: 1,
              text: "Hello from voix.",
              voice: "af_heart",
            })
          );
        }).pipe(Effect.provide(KokoroProvider), Effect.scoped)
      );
      expect(chunks.length).toBe(1);
      // The assertion above verifies that synthesis returned exactly one chunk.
      // oxlint-disable-next-line typescript/no-non-null-assertion
      const chunk = chunks[0]!;
      const seconds = chunk.pcm.length / chunk.sampleRate;
      expect(chunk.sampleRate).toBe(24_000);
      expect(seconds).toBeGreaterThan(0.8);
      expect(seconds).toBeLessThan(3);
    },
    60_000
  );

  test.skipIf(!isModelInstalled())(
    "rejects unknown voices before loading anything",
    async () => {
      const error = await Effect.runPromise(
        Effect.gen(function* error() {
          const provider = yield* Provider;
          return yield* Effect.flip(
            Stream.runCollect(
              provider.synthesize({ speed: 1, text: "x", voice: "zz_nobody" })
            )
          );
        }).pipe(Effect.provide(KokoroProvider), Effect.scoped)
      );
      expect(error._tag).toBe("InvalidVoice");
    }
  );
});

if (!isModelInstalled()) {
  console.warn(
    "kokoro synthesis tests skipped: model not installed (run `voix setup`)"
  );
}
