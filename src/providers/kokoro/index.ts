import { Deferred, Effect, Exit, Layer, Option, Ref, Stream } from "effect";
import type { InferenceSession } from "onnxruntime-node";

import type { PrepareError } from "../../core/errors.ts";
import { InvalidVoice } from "../../core/errors/invalid-voice.ts";
import { SynthFailed } from "../../core/errors/synth-failed.ts";
import { Provider } from "../provider.ts";
import type {
  AudioChunk,
  DownloadProgress,
  ProviderStatus,
  SynthRequest,
} from "../provider.ts";
import { downloadModel, isModelInstalled, modelPath } from "./model.ts";
import {
  MAX_PHONEME_TOKENS,
  phonemize,
  SAMPLE_RATE,
  splitPhonemes,
  tokenize,
} from "./phonemize.ts";
import type { Lang } from "./phonemize.ts";
import { loadOrt } from "./runtime.ts";
import type { Ort } from "./runtime.ts";
import {
  DEFAULT_VOICE,
  KOKORO_VOICE_IDS,
  KOKORO_VOICES,
  VOICE_FILES,
} from "./voices.ts";

interface Session {
  readonly ort: Ort;
  readonly session: InferenceSession;
}

const STYLE_DIM = 256;

const styleFor = (voice: Float32Array, tokenCount: number): Float32Array => {
  const offset =
    STYLE_DIM * Math.min(Math.max(tokenCount - 2, 0), MAX_PHONEME_TOKENS - 1);
  return voice.slice(offset, offset + STYLE_DIM);
};

export const KokoroProvider: Layer.Layer<Provider> = Layer.effect(
  Provider,
  Effect.gen(function* KokoroProvider() {
    const downloading = yield* Ref.make(Option.none<DownloadProgress>());
    const sessionRef = yield* Ref.make(Option.none<Session>());
    const prepared = yield* Ref.make(
      Option.none<Deferred.Deferred<void, PrepareError>>()
    );
    const voiceCache = new Map<string, Float32Array>();

    const doPrepare: Effect.Effect<void, PrepareError> = Effect.gen(
      function* doPrepare() {
        if (!isModelInstalled()) {
          yield* downloadModel((received, total) =>
            Ref.set(downloading, Option.some({ received, total }))
          ).pipe(Effect.ensuring(Ref.set(downloading, Option.none())));
        }
        const ort = yield* loadOrt;
        const session = yield* Effect.tryPromise({
          catch: (e) =>
            new SynthFailed({
              reason: `could not load model: ${e instanceof Error ? e.message : String(e)}`,
            }),
          try: () =>
            ort.InferenceSession.create(modelPath(), {
              executionProviders: ["cpu"],
            }),
        });
        yield* Ref.set(sessionRef, Option.some({ ort, session }));
      }
    );

    // Memoized: the first caller starts the work in a detached fiber so that an interrupted caller
    // (a cancelled tool call, Ctrl-C) does not strand later callers. Failures reset so a retry can happen.
    const prepare: Effect.Effect<void, PrepareError> = Effect.gen(
      function* prepare() {
        // Effect's Deferred.make accepts void as its success type.
        // oxlint-disable-next-line typescript/no-invalid-void-type
        const fresh = yield* Deferred.make<void, PrepareError>();
        type Slot = Option.Option<Deferred.Deferred<void, PrepareError>>;
        const [deferred, isOwner] = yield* Ref.modify(
          prepared,
          (
            current: Slot
          ): readonly [
            readonly [Deferred.Deferred<void, PrepareError>, boolean],
            Slot,
          ] =>
            Option.isSome(current)
              ? [[current.value, false], current]
              : [[fresh, true], Option.some(fresh)]
        );
        if (isOwner) {
          yield* Effect.forkDetach(
            Effect.gen(function* prepareInBackground() {
              const exit = yield* Effect.exit(doPrepare);
              if (Exit.isFailure(exit)) {
                yield* Ref.set(prepared, Option.none());
              }
              yield* Deferred.done(deferred, exit);
            })
          );
        }
        return yield* Deferred.await(deferred);
      }
    );

    const status: Effect.Effect<ProviderStatus> = Effect.gen(
      function* status() {
        const session = yield* Ref.get(sessionRef);
        const progress = yield* Ref.get(downloading);
        return {
          downloading: progress,
          installed: isModelInstalled(),
          loaded: Option.isSome(session),
          modelPath: modelPath(),
        };
      }
    );

    const loadVoice = (id: string): Effect.Effect<Float32Array, SynthFailed> =>
      Effect.gen(function* loadVoiceBody() {
        const cached = voiceCache.get(id);
        if (cached !== undefined) {
          return cached;
        }
        const file = VOICE_FILES[id];
        if (file === undefined) {
          return yield* new SynthFailed({ reason: `no voice file for ${id}` });
        }
        const bytes = yield* Effect.tryPromise({
          catch: (e) =>
            new SynthFailed({
              reason: `could not read voice ${id}: ${String(e)}`,
            }),
          try: () => Bun.file(file).arrayBuffer(),
        });
        const voice = new Float32Array(bytes);
        voiceCache.set(id, voice);
        return voice;
      });

    const infer = (
      session: Session,
      ids: number[],
      voice: Float32Array,
      speed: number,
      text: string
    ) =>
      Effect.tryPromise({
        catch: (e) =>
          new SynthFailed({
            reason: e instanceof Error ? e.message : String(e),
          }),
        try: async (): Promise<AudioChunk> => {
          const { Tensor } = session.ort;
          const feeds = {
            input_ids: new Tensor("int64", BigInt64Array.from(ids, BigInt), [
              1,
              ids.length,
            ]),
            speed: new Tensor("float32", Float32Array.from([speed]), [1]),
            style: new Tensor("float32", styleFor(voice, ids.length), [
              1,
              STYLE_DIM,
            ]),
          };
          const out = await session.session.run(feeds);
          return {
            // The pinned Kokoro model defines a waveform output tensor.
            // oxlint-disable-next-line typescript/no-non-null-assertion
            pcm: out.waveform!.data as Float32Array,
            sampleRate: SAMPLE_RATE,
            text,
          };
        },
      });

    const synthesize = (request: SynthRequest) =>
      Stream.unwrap(
        Effect.gen(function* synthesizeBody() {
          if (
            !(KOKORO_VOICE_IDS as readonly string[]).includes(request.voice)
          ) {
            return yield* new InvalidVoice({
              available: [...KOKORO_VOICE_IDS],
              voice: request.voice,
            });
          }
          yield* prepare;
          const session = Option.getOrThrow(yield* Ref.get(sessionRef));
          const voice = yield* loadVoice(request.voice);
          const lang: Lang = request.voice.startsWith("b") ? "en-GB" : "en-US";
          const phonemes = yield* phonemize(request.text, lang);
          const pieces = splitPhonemes(phonemes).filter(
            (p) => p.trim().length > 0
          );
          return Stream.fromIterable(pieces).pipe(
            Stream.mapEffect((piece) =>
              infer(
                session,
                tokenize(piece),
                voice,
                request.speed,
                request.text
              )
            )
          );
        })
      );

    return {
      defaultVoice: DEFAULT_VOICE,
      id: "kokoro",
      prepare,
      status,
      synthesize,
      voices: KOKORO_VOICES,
    };
  })
);
