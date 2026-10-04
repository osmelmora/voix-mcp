import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Layer, Option, Stdio, Stream } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { PlayerFromEnv, Player } from "./audio/player.ts"
import { concatPcm, durationSeconds, encodeWav } from "./audio/wav.ts"
import { isVoixError } from "./core/errors.ts"
import { voixHome } from "./core/paths.ts"
import { DEFAULT_SPEED, Speaker, SpeakerLive, SPEED_MAX, SPEED_MIN } from "./core/speaker.ts"
import { splitSentences, toSpeakable } from "./core/text.ts"
import { McpLive } from "./mcp.ts"
import { KokoroProvider } from "./providers/kokoro/index.ts"
import { KOKORO_MODEL } from "./providers/kokoro/model.ts"
import { dylibDestination, isEmbedded } from "./providers/kokoro/runtime.ts"
import { DEFAULT_VOICE } from "./providers/kokoro/voices.ts"
import { Provider } from "./providers/provider.ts"
import { VERSION } from "./version.ts"

const mb = (n: number) => (n / (1024 * 1024)).toFixed(0)

/** Run `prepare`, rendering download progress on stderr when a download is needed. */
const prepareWithProgress = Effect.gen(function* () {
  const provider = yield* Provider
  const before = yield* provider.status
  if (before.installed) return yield* provider.prepare
  yield* Console.error(
    `Kokoro model not installed. Downloading ${mb(KOKORO_MODEL.size)} MB to ${before.modelPath} (one time)...`
  )
  const ticker = Effect.forever(
    Effect.gen(function* () {
      const s = yield* provider.status
      if (Option.isSome(s.downloading)) {
        const { received, total } = s.downloading.value
        const pct = total > 0 ? Math.floor((received / total) * 100) : 0
        process.stderr.write(`\r  ${pct}%  ${mb(received)} / ${mb(total)} MB`)
      }
      yield* Effect.sleep("200 millis")
    })
  )
  yield* provider.prepare.pipe(Effect.raceFirst(ticker))
  process.stderr.write("\r")
  yield* Console.error("✓ Model installed")
})

const readStdin = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  if (yield* stdio.stdinIsTerminal) return ""
  const chunks = yield* Stream.runCollect(stdio.stdin)
  return new TextDecoder().decode(concatBytes(chunks))
}).pipe(Effect.catch(() => Effect.succeed("")))

function concatBytes(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

const voiceFlag = Flag.String("voice").pipe(
  Flag.withDescription("Voice id (see `voix voices`)"),
  Flag.withDefault(DEFAULT_VOICE)
)
const speedFlag = Flag.Finite("speed").pipe(
  Flag.withAlias("s"),
  Flag.withDescription(`Speaking rate, ${SPEED_MIN} to ${SPEED_MAX}`),
  Flag.withDefault(DEFAULT_SPEED)
)
const outFlag = Flag.String("out").pipe(
  Flag.withAlias("o"),
  Flag.withDescription("Write a WAV file instead of playing"),
  Flag.optional
)
const textArg = Argument.String("text").pipe(Argument.withDescription("Text to speak; reads stdin when omitted"), Argument.variadic())

const say = Command.make("say", { text: textArg, voice: voiceFlag, speed: speedFlag, out: outFlag }, ({ out, speed, text, voice }) =>
  Effect.gen(function* () {
    const input = (text.length > 0 ? text.join(" ") : yield* readStdin).trim()
    if (input.length === 0) {
      yield* Console.error("usage: voix say <text>   (or pipe text on stdin)")
      process.exitCode = 2
      return
    }
    yield* prepareWithProgress
    if (Option.isSome(out)) {
      const provider = yield* Provider
      const sentences = splitSentences(toSpeakable(input))
      const chunks = yield* Stream.fromIterable(sentences).pipe(
        Stream.flatMap((s) => provider.synthesize({ text: s, voice, speed })),
        Stream.runCollect
      )
      const pcm = concatPcm(chunks.map((c) => c.pcm))
      const rate = chunks[0]?.sampleRate ?? 24_000
      yield* Effect.promise(() => Bun.write(out.value, encodeWav(pcm, rate)))
      yield* Console.log(`wrote ${out.value} (${durationSeconds(pcm, rate).toFixed(1)}s)`)
      return
    }
    const speaker = yield* Speaker
    yield* speaker.speak({ text: input, voice, speed })
    yield* speaker.awaitIdle
  })
).pipe(Command.withDescription("Speak text through the local speakers"))

const setup = Command.make("setup", {}, () =>
  Effect.gen(function* () {
    yield* prepareWithProgress
    const provider = yield* Provider
    const status = yield* provider.status
    yield* Console.log(`ready: ${status.modelPath}`)
  })
).pipe(Command.withDescription("Download and verify the speech model"))

const voices = Command.make("voices", {}, () =>
  Effect.gen(function* () {
    const provider = yield* Provider
    for (const v of provider.voices) {
      const mark = v.id === provider.defaultVoice ? "*" : " "
      yield* Console.log(`${mark} ${v.id.padEnd(14)} ${v.language}  ${v.gender.padEnd(6)}  ${v.name}`)
    }
  })
).pipe(Command.withDescription("List available voices (* = default)"))

const status = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const provider = yield* Provider
    const player = yield* Player
    const s = yield* provider.status
    const lines = [
      `voix ${VERSION}`,
      `platform:   ${process.platform}-${process.arch}`,
      `runtime:    bun ${Bun.version}${isEmbedded() ? " (compiled executable)" : ""}`,
      `home:       ${voixHome()}`,
      `provider:   ${provider.id} (${KOKORO_MODEL.precision}, ${provider.voices.length} voices, default ${provider.defaultVoice})`,
      `model:      ${s.modelPath}`,
      `installed:  ${s.installed ? "yes" : "no (run `voix setup`)"}`,
      `player:     ${player.name}`,
      `onnx dylib: ${isEmbedded() ? dylibDestination() : "node_modules (dev)"}`
    ]
    yield* Console.log(lines.join("\n"))
  })
).pipe(Command.withDescription("Show installation state"))

const mcp = Command.make("mcp", {}, () => Layer.launch(McpLive)).pipe(
  Command.withDescription("Run the MCP server over stdio")
)

const voix = Command.make("voix").pipe(
  Command.withDescription("Local voice output for AI agents"),
  Command.withSubcommands([say, setup, voices, status, mcp])
)

const AppLive = SpeakerLive.pipe(Layer.provideMerge(Layer.mergeAll(KokoroProvider, PlayerFromEnv)))

Command.run(voix, { version: VERSION }).pipe(
  Effect.catchIf(isVoixError, (e) =>
    Effect.gen(function* () {
      yield* Console.error(`error: ${e.message}`)
      process.exitCode = 1
    })
  ),
  Effect.provide(AppLive),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain({ disableErrorReporting: false })
)
