# voix — MVP specification

Status: settled after a three-round design grill on 2026-10-04. Every decision below was chosen by the project owner from measured alternatives; the measurements are in §11.

## 1. MVP definition

**Target user.** A developer running an AI agent locally (Claude Code, Claude Desktop, Cursor or any MCP client) on a Mac with Apple Silicon who wants the agent to _say_ things.

**Problem.** Local, good-quality TTS exists, but every option is an ML development environment (Python, pip, ONNX setup). Agents need a voice primitive they can install like a Unix tool and call like a function.

**Primary workflow.**

```text
User:  "Give me my daily update out loud."
Agent: gathers data → writes a spoken summary → calls speak({ text })
voix:  normalizes text → Kokoro (local ONNX) → afplay → speakers
```

**Supported platform.** macOS on Apple Silicon (`darwin-arm64`) only. The code keeps the player and native-runtime lookups behind small platform switches so Linux is a follow-up, not a redesign, but nothing else is built, tested or claimed.

**Success criteria.**

1. `curl | sh` installer (or a downloaded binary) + `voix say "Hello"` produces speech, downloading the model automatically on first run.
2. Adding `{ "command": "voix", "args": ["mcp"] }` to an MCP client gives the agent a `speak` tool that produces speech, with first audio under two seconds for a short sentence once the model is cached.
3. `stop` interrupts speech immediately.
4. The whole thing is one executable plus one downloaded model file.

**Explicit non-goals.** Web UI, voice cloning, remote/HTTP server, cloud providers, auth, telemetry, SSML, multiple simultaneous models, plugin marketplace, OpenAI compatible API, playback queues beyond strict serial order, a daemon, a config file, `synthesize`/`list_voices`/`status` MCP tools, npm publishing, code signing, any platform other than darwin-arm64, any provider other than Kokoro.

## 2. Architecture

```text
Agent ──MCP stdio──▶ voix mcp ─┐
Shell ──argv───────▶ voix say ─┤
                               ▼
                           Speaker            serial queue, sentence pipelining,
                        (core/speaker)         adaptive batching, stop
                          │        │
                          ▼        ▼
                       Provider  Player         Context.Service interfaces
                          │        │
                       Kokoro    afplay         onnxruntime-node + phonemizer / child process
                          │
                       model.onnx (~/.cache/voix)   embedded: voices, tokenizer, ORT dylib
```

One process. The MCP stdio server lives for the agent session, so the model stays warm without a daemon. `voix say` is the same core driven from argv.

Implementation style: Effect 4.0.0 throughout. Services are `Context.Service` classes wired with `Layer`, errors are `Schema.TaggedError` classes, synthesis is a `Stream`, `stop` is fiber interruption, playback is a scoped child process that is killed when its scope closes (stop, cancellation, or process exit).

## 3. MCP API

Server: `name: "voix"`, protocol `2025-06-18`, stdio transport, stdout is the wire, diagnostics go to stderr. Server `instructions` tell the agent when to speak and how to write for speech, and point at the `skill://voix/SKILL.md` resource (SEP-2640 pointer pattern; the skills extension itself is not declared because no client consumes it yet and Effect's server cannot serve `skills/list`).

### `speak`

Speak text aloud on the local machine. Returns as soon as this utterance starts playing, or immediately with `status: "queued"` if another utterance is already playing. Does not wait for playback to finish.

Input:

| field | type | required | notes |
| --- | --- | --- | --- |
| `text` | string | yes | 1 to 10 000 characters. Markdown is stripped before synthesis. |
| `voice` | enum of 28 Kokoro voice ids | no | default `af_heart` |
| `speed` | number | no | 0.5 to 2.0, default 1.0 |

Output (structured content, also serialized as text):

```json
{
  "status": "speaking",
  "voice": "af_heart",
  "sentences": 4,
  "queued_behind": 0
}
```

`status` is `"speaking"` (playback of this utterance started), `"queued"` (another utterance was playing; this one will follow), or `"cancelled"` (a `stop` arrived before it started). `sentences` is the chunk count after splitting, known before synthesis.

Errors are returned as tool results with `isError: true` and a JSON body `{ "_tag": "<Code>", ...fields, "message": "..." }`. Codes: `EmptyText`, `TextTooLong`, `InvalidVoice`, `InvalidSpeed`, `ModelDownloading` (model not ready after a 45 s bounded wait; includes `received`/`total` bytes), `DownloadFailed`, `ChecksumMismatch`, `PlayerNotFound`, `PlaybackFailed`, `SynthFailed`. Invalid JSON shapes are rejected by the protocol layer as `-32602`.

Progress: while `speak` waits for a model download it sends `notifications/progress` every two seconds if the client supplied a `progressToken`.

Cancellation: `notifications/cancelled` interrupts the handler; an utterance that has not started is dropped.

### `stop`

Stop current speech and discard anything queued. Input: none. Output:

```json
{ "stopped": true }
```

`stopped` is whether anything was actually playing or queued.

### Resource

`skill://voix/SKILL.md` (`text/markdown`): the agent skill shipped in `skills/voix/`.

### Startup behaviour

On start the server checks the model cache and, if the model is missing, begins downloading in the background so that the first `speak` usually finds it ready.

## 4. Provider contract

```ts
interface Voice {
  id: string;
  name: string;
  language: string;
  gender: "female" | "male";
}
interface AudioChunk {
  pcm: Float32Array;
  sampleRate: number;
  text: string;
}
interface SynthRequest {
  text: string;
  voice: string;
  speed: number;
}
interface ProviderStatus {
  installed: boolean; // model files present
  loaded: boolean; // inference session created
  downloading: Option<{ received: number; total: number }>;
  modelPath: string;
}

class Provider extends Context.Service<
  Provider,
  {
    readonly id: string;
    readonly voices: ReadonlyArray<Voice>;
    readonly defaultVoice: string;
    readonly prepare: Effect<
      void,
      DownloadFailed | ChecksumMismatch | SynthFailed
    >; // idempotent, memoized
    readonly status: Effect<ProviderStatus>;
    readonly synthesize: (
      req: SynthRequest
    ) => Stream<
      AudioChunk,
      SynthFailed | InvalidVoice | DownloadFailed | ChecksumMismatch
    >;
  }
>()("voix/Provider") {}
```

Rules:

- The core normalizes text and splits it into sentences; it calls `synthesize` once per sentence. The provider may still yield several chunks for one call (Kokoro does when a sentence exceeds its 510-phoneme limit). Every provider is a stream, even if it yields once.
- `synthesize` must call `prepare` itself if needed; callers never have to.
- Playback is not the provider's business. Providers emit float PCM and a sample rate.
- No capability flags, no init options, no provider-specific parameters in the MVP.
- Provider errors are wrapped into `SynthFailed { reason }`; model acquisition errors keep their own tags.

How a second provider plugs in (hypothetical Piper, child-process strategy):

```ts
const PiperProvider = Layer.effect(Provider, Effect.gen(function* () {
  return Provider.of({
    id: "piper", voices: PIPER_VOICES, defaultVoice: "en_US-lessac-medium",
    prepare: ensurePiperBinaryAndVoice,                      // download once
    status: readStatus,
    synthesize: (req) => Stream.scoped(ChildProcess.make("piper", ["--model", ...]))
      .pipe(Stream.flatMap(h => h.stdout), Stream.via(rawPcmToChunks(22050, req.text)))
  })
}))
```

It is selected by swapping the layer passed to the Speaker; the Speaker, CLI and MCP code do not change. Provider selection is not exposed in the MVP.

## 5. Runtime decisions

| decision | choice | why |
| --- | --- | --- |
| Language/runtime | TypeScript on Bun 1.3.9, `bun build --compile` | Single-file executables, cross-compilation, embeds assets. Measured working. |
| Framework | Effect 4.0.0 (pinned exactly) | Typed errors, fibers for stop/cancel, scoped child processes, built-in MCP server and CLI. +32 KB, +2.5 ms over hello world. |
| Inference | `onnxruntime-node` 1.30.0 native CPU + `phonemizer` 1.2.1 (eSpeak NG in WASM) + ~150 lines of own Kokoro glue | 2× faster than q8, ~5× real time at fp32. No transformers.js, no sharp. Byte-identical phonemes to kokoro-js. WASM-only path measured slower than real time in Bun. |
| ONNX runtime dylib | embedded as an asset, copied to the per-user temp dir on first use, then `onnxruntime-node` is imported dynamically | Bun extracts the `.node` addon to `$TMPDIR` and its rpath is `@loader_path`; the companion dylib must be there. Bun's own fix is unreleased. |
| Model precision | fp32 `model.onnx`, 326 MB, SHA-256 pinned | best quality and 2.2× faster than q8 on Apple Silicon. One fixed choice. |
| Voices | 28 English voice files embedded (14 MB) | voice enum, `voix voices` and offline use never depend on a download |
| Audio | write WAV to a temp file, spawn `/usr/bin/afplay` as a scoped child process | present on every Mac, needs a seekable file, SIGTERM stops it cleanly |
| Pipelining | synthesize sentence by sentence; first sentence plays as soon as it is ready; each later playback chunk is every sentence that finished while the previous chunk played | first audio in about one second instead of after full synthesis; adaptive batching hides afplay's ~0.9 s per-spawn overhead |
| Process lifecycle | no daemon; MCP server lives for the agent session; exit kills current playback | warm model load is 250 ms, nothing needs to outlive the session |
| Model storage | `$VOIX_HOME` or `~/.cache/voix`, `models/kokoro-v1.0/model.onnx`, downloaded from the Hugging Face ONNX repo, verified by SHA-256 after download, checked by size afterwards | one env var, no config file |
| Configuration | none; defaults voice `af_heart`, speed 1.0 | first invocation must work |
| Text handling | 10 000 character cap; markdown stripped (headers, emphasis, code fences, lists, links, tables); eSpeak handles numbers | agents emit markdown; the skill asks for spoken prose, this is the safety net |
| License | project MIT; NOTICE documents Apache-2.0 model and the GPL-3 eSpeak NG inside `phonemizer` | conscious choice, to be revisited before wide distribution |

## 6. Distribution

User downloads one file: `voix-darwin-arm64` (≈118 MB: Bun runtime 60 MB, ONNX runtime 44 MB, voices 14 MB, code <1 MB). On first speech it downloads `model.onnx` (326 MB) into `~/.cache/voix`.

```bash
curl -fsSL https://github.com/<owner>/voix-mcp/releases/latest/download/install.sh | sh
voix say "Hello"
```

MCP configuration:

```json
{ "mcpServers": { "voix": { "command": "voix", "args": ["mcp"] } } }
```

Unsigned binary. `curl` downloads carry no quarantine flag; browser downloads need `xattr -d com.apple.quarantine voix`. A GitHub Actions workflow builds and uploads the binary and installer on tag push. No remote is created by this work. Homebrew tap and npm are later.

## 7. Repository structure

```text
voix-mcp/
├── package.json, bun.lock, tsconfig.json, mise.toml, .gitignore
├── README.md, LICENSE, NOTICE
├── docs/SPEC.md
├── skills/voix/SKILL.md            # agent skill, also served as skill://voix/SKILL.md
├── scripts/build.ts                # bun build --compile wrapper
├── scripts/install.sh              # curl | sh installer
├── src/
│   ├── main.ts                     # effect/cli: say | setup | voices | status | mcp
│   ├── mcp.ts                      # effect/ai McpServer: speak, stop, skill resource
│   ├── core/
│   │   ├── errors.ts               # Schema.TaggedError classes, VoixError union
│   │   ├── paths.ts                # VOIX_HOME resolution
│   │   ├── text.ts                 # markdown → speakable text, sentence split
│   │   └── speaker.ts              # Speaker service: queue, pipelining, stop, awaitIdle
│   ├── audio/
│   │   ├── wav.ts                  # float PCM → 16-bit WAV
│   │   └── player.ts               # Player service: afplay layer, null layer, env selection
│   └── providers/
│       ├── provider.ts             # Provider service + types
│       └── kokoro/
│           ├── index.ts            # KokoroProvider layer
│           ├── model.ts            # download, checksum, paths
│           ├── runtime.ts          # dylib materialization + dynamic ORT import
│           ├── normalize.ts        # Kokoro text normalization
│           ├── phonemize.ts        # eSpeak phonemization + Kokoro post-processing + tokenizer
│           ├── voices.ts           # 28 embedded voices + metadata
│           └── assets/             # tokenizer.json, voices/*.bin
├── tests/
└── .github/workflows/release.yml
```

## 8. Implementation plan

| # | milestone | acceptance |
| --- | --- | --- |
| 1 | Kokoro provider: runtime, model download, phonemize, synthesize | `bun test tests/kokoro.test.ts` passes; phonemes match the recorded kokoro-js output; with the model cached, a sentence synthesizes to 24 kHz PCM of plausible length |
| 2 | Audio: WAV encoder, afplay player, null player | a generated tone plays and `kill` stops it |
| 3 | Core: text normalization, Speaker queue with pipelining and stop | fake-provider tests: serial order, speak returns when first chunk plays, queued status, stop clears queue and interrupts |
| 4 | CLI | `voix say "Hello"` speaks; `voix setup`, `voices`, `status` work; `--out` writes a WAV |
| 5 | MCP server | an MCP client over stdio lists `speak` and `stop`, calls `speak`, gets `status: "speaking"`; `stop` returns; errors come back typed |
| 6 | Build + distribution | `bun run build` produces `dist/voix-darwin-arm64`; the binary runs from another directory with node_modules absent; README documents install and MCP config; release workflow and installer present |

## 9. Testing strategy

- Unit (`bun test`): text normalization and splitting; Speaker with a fake provider and a recording player; Kokoro phonemizer/tokenizer parity with recorded values; WAV encoder.
- Integration: Kokoro synthesis and the MCP stdio round trip run only when the model is present in the cache (skipped with a message otherwise); playback is disabled with `VOIX_PLAYER=none` so CI is silent.
- Smoke: `voix say "Hello"` and the compiled binary's `mcp` command driven by a raw JSON-RPC client, with stdin kept open until the response arrives (Effect's stdio layer drops in-flight responses on EOF).
- Manual: the owner hears `voix say` once; no automated test asserts audible output.

## 10. Open items carried forward

- Intel Mac: onnxruntime-node 1.30 ships no darwin-x64 binary.
- Linux/Windows: cross-compile builds; audio player and dylib path untested.
- `effect/ai`, `effect/cli`, `effect/process` are marked unstable; pinned to 4.0.0.
- Effect issue #8710 (stdio drops in-flight responses on stdin close) affects one-shot pipelines only.
- Bun minifier incident with Effect (effect-smol #2126): build without `--minify` unless the compiled smoke test passes with it.

## 11. Measurements behind the decisions (this machine, M-series, Bun 1.3.9)

| path | works | binary | synth time, 3.6 s sentence |
| --- | --- | --- | --- |
| `bun run` + kokoro-js, native ORT | yes | n/a | 1.3 s q8 / 0.65 s fp32 |
| compiled, stock kokoro-js | no (dlopen) | 65 MB | n/a |
| compiled, WASM ORT, self-contained | yes | 105 MB | 5.9 s (slower than real time) |
| compiled, own glue, native ORT + embedded dylib | yes | 118 MB | 0.7 s fp32 |

fp32 paragraph (23 s audio): 4.3 s total, ~5× real time. Session load 300 ms. `afplay`: file only (no stdin, no raw PCM), ~0.9 s spawn/teardown overhead, SIGTERM clean.
