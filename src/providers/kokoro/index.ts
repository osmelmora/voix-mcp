import { Deferred, Effect, Exit, Layer, Option, Ref, Stream } from "effect"
import type { InferenceSession } from "onnxruntime-node"
import { InvalidVoice, SynthFailed, type PrepareError } from "../../core/errors.ts"
import { Provider, type AudioChunk, type DownloadProgress, type ProviderStatus, type SynthRequest } from "../provider.ts"
import { downloadModel, isModelInstalled, modelPath } from "./model.ts"
import { MAX_PHONEME_TOKENS, phonemize, SAMPLE_RATE, splitPhonemes, tokenize, type Lang } from "./phonemize.ts"
import { loadOrt, type Ort } from "./runtime.ts"
import { DEFAULT_VOICE, KOKORO_VOICE_IDS, KOKORO_VOICES, VOICE_FILES } from "./voices.ts"

interface Session {
  readonly ort: Ort
  readonly session: InferenceSession
}

const STYLE_DIM = 256

const styleFor = (voice: Float32Array, tokenCount: number): Float32Array => {
  const offset = STYLE_DIM * Math.min(Math.max(tokenCount - 2, 0), MAX_PHONEME_TOKENS - 1)
  return voice.slice(offset, offset + STYLE_DIM)
}

export const KokoroProvider: Layer.Layer<Provider> = Layer.effect(
  Provider,
  Effect.gen(function* () {
    const downloading = yield* Ref.make(Option.none<DownloadProgress>())
    const sessionRef = yield* Ref.make(Option.none<Session>())
    const prepared = yield* Ref.make(Option.none<Deferred.Deferred<void, PrepareError>>())
    const voiceCache = new Map<string, Float32Array>()

    const doPrepare: Effect.Effect<void, PrepareError> = Effect.gen(function* () {
      if (!isModelInstalled()) {
        yield* downloadModel((received, total) => Ref.set(downloading, Option.some({ received, total }))).pipe(
          Effect.ensuring(Ref.set(downloading, Option.none()))
        )
      }
      const ort = yield* loadOrt
      const session = yield* Effect.tryPromise({
        try: () => ort.InferenceSession.create(modelPath(), { executionProviders: ["cpu"] }),
        catch: (e) => new SynthFailed({ reason: `could not load model: ${e instanceof Error ? e.message : String(e)}` })
      })
      yield* Ref.set(sessionRef, Option.some({ ort, session }))
    })

    // Memoized: the first caller starts the work in a detached fiber so that an interrupted caller
    // (a cancelled tool call, Ctrl-C) does not strand later callers. Failures reset so a retry can happen.
    const prepare: Effect.Effect<void, PrepareError> = Effect.gen(function* () {
      const fresh = yield* Deferred.make<void, PrepareError>()
      type Slot = Option.Option<Deferred.Deferred<void, PrepareError>>
      const [deferred, isOwner] = yield* Ref.modify(
        prepared,
        (current: Slot): readonly [readonly [Deferred.Deferred<void, PrepareError>, boolean], Slot] =>
          Option.isSome(current) ? [[current.value, false], current] : [[fresh, true], Option.some(fresh)]
      )
      if (isOwner) {
        yield* Effect.forkDetach(
          Effect.gen(function* () {
            const exit = yield* Effect.exit(doPrepare)
            if (Exit.isFailure(exit)) yield* Ref.set(prepared, Option.none())
            yield* Deferred.done(deferred, exit)
          })
        )
      }
      return yield* Deferred.await(deferred)
    })

    const status: Effect.Effect<ProviderStatus> = Effect.gen(function* () {
      const session = yield* Ref.get(sessionRef)
      const progress = yield* Ref.get(downloading)
      return { installed: isModelInstalled(), loaded: Option.isSome(session), downloading: progress, modelPath: modelPath() }
    })

    const loadVoice = (id: string): Effect.Effect<Float32Array, SynthFailed> =>
      Effect.gen(function* () {
        const cached = voiceCache.get(id)
        if (cached !== undefined) return cached
        const file = VOICE_FILES[id]
        if (file === undefined) return yield* new SynthFailed({ reason: `no voice file for ${id}` })
        const bytes = yield* Effect.tryPromise({
          try: () => Bun.file(file).arrayBuffer(),
          catch: (e) => new SynthFailed({ reason: `could not read voice ${id}: ${String(e)}` })
        })
        const voice = new Float32Array(bytes)
        voiceCache.set(id, voice)
        return voice
      })

    const infer = (session: Session, ids: Array<number>, voice: Float32Array, speed: number, text: string) =>
      Effect.tryPromise({
        try: async (): Promise<AudioChunk> => {
          const { Tensor } = session.ort
          const feeds = {
            input_ids: new Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
            style: new Tensor("float32", styleFor(voice, ids.length), [1, STYLE_DIM]),
            speed: new Tensor("float32", Float32Array.from([speed]), [1])
          }
          const out = await session.session.run(feeds)
          return { pcm: out.waveform!.data as Float32Array, sampleRate: SAMPLE_RATE, text }
        },
        catch: (e) => new SynthFailed({ reason: e instanceof Error ? e.message : String(e) })
      })

    const synthesize = (request: SynthRequest) =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (!(KOKORO_VOICE_IDS as ReadonlyArray<string>).includes(request.voice)) {
            return yield* new InvalidVoice({ voice: request.voice, available: [...KOKORO_VOICE_IDS] })
          }
          yield* prepare
          const session = Option.getOrThrow(yield* Ref.get(sessionRef))
          const voice = yield* loadVoice(request.voice)
          const lang: Lang = request.voice.startsWith("b") ? "en-GB" : "en-US"
          const phonemes = yield* phonemize(request.text, lang)
          const pieces = splitPhonemes(phonemes).filter((p) => p.trim().length > 0)
          return Stream.fromIterable(pieces).pipe(
            Stream.mapEffect((piece) => infer(session, tokenize(piece), voice, request.speed, request.text))
          )
        })
      )

    return {
      id: "kokoro",
      voices: KOKORO_VOICES,
      defaultVoice: DEFAULT_VOICE,
      prepare,
      status,
      synthesize
    }
  })
)
