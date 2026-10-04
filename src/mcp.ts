import { Console, Effect, Layer, Logger, Option, Schema } from "effect";
import type { Stdio } from "effect";
import { McpProtocol, McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import skillMarkdown from "../skills/voix/SKILL.md" with { type: "text" };
import { VoixErrorSchema } from "./core/errors.ts";
import { Speaker, SPEED_MAX, SPEED_MIN } from "./core/speaker.ts";
import { MAX_TEXT_LENGTH } from "./core/text.ts";
import { DEFAULT_VOICE, KOKORO_VOICE_IDS } from "./providers/kokoro/voices.ts";
import { Provider } from "./providers/provider.ts";
import { VERSION } from "./version.ts";

export const SKILL_URI = "skill://voix/SKILL.md";

export const INSTRUCTIONS = `voix speaks text out loud on the user's machine with a local TTS model. Use \`speak\` when the user asks to hear something, wants a spoken update or summary, or a short audible notification is better than text. Write plain spoken prose: no markdown, lists, code, URLs or paths; short sentences; numbers and abbreviations written the way they are said. Call \`speak\` once with the whole message; it returns as soon as the first sentence starts playing. Use \`stop\` to interrupt, then \`speak\` again to replace. If \`speak\` reports ModelDownloading, the model is being fetched on first use: tell the user and retry shortly. Full guidance: resource ${SKILL_URI}.`;

const SpeakParams = Schema.Struct({
  speed: Schema.optional(
    Schema.Number.annotate({
      description: `Speaking rate multiplier, ${SPEED_MIN} to ${SPEED_MAX}. Default 1.`,
    })
  ),
  text: Schema.String.annotate({
    description: `What to say, as plain spoken prose (markdown is stripped). 1 to ${MAX_TEXT_LENGTH} characters.`,
  }),
  voice: Schema.optional(
    Schema.Literals(KOKORO_VOICE_IDS).annotate({
      description: `Voice id. Default ${DEFAULT_VOICE}. Prefix: af/am American female/male, bf/bm British female/male.`,
    })
  ),
});

const SpeakResult = Schema.Struct({
  queued_behind: Schema.Number,
  sentences: Schema.Number,
  status: Schema.Literals(["speaking", "queued", "cancelled"]),
  voice: Schema.String,
});

const StopResult = Schema.Struct({ stopped: Schema.Boolean });

const Speak = Tool.make("speak", {
  dependencies: [McpSchema.McpRequestContext],
  description:
    'Speak text aloud through the local speakers. Returns when this utterance starts playing (or immediately with status "queued" if another one is playing); it does not wait for playback to finish. Utterances play in order.',
  failure: VoixErrorSchema,
  failureMode: "return",
  parameters: SpeakParams,
  success: SpeakResult,
}).annotate(Tool.Title, "Speak");

const Stop = Tool.make("stop", {
  description: "Stop current speech immediately and discard anything queued.",
  success: StopResult,
}).annotate(Tool.Title, "Stop speaking");

export const VoixToolkit = Toolkit.make(Speak, Stop);

const PROGRESS_INTERVAL = "2 seconds";

const decodeProgressToken = Schema.decodeUnknownOption(McpSchema.ProgressToken);

const ToolHandlers = VoixToolkit.toLayer(
  Effect.gen(function* ToolHandlers() {
    const speaker = yield* Speaker;
    const provider = yield* Provider;
    const server = yield* McpServer.McpServer;

    const reportProgress = (token: string | number) =>
      Effect.forever(
        Effect.gen(function* reportProgressTick() {
          yield* Effect.sleep(PROGRESS_INTERVAL);
          const status = yield* provider.status;

          if (Option.isSome(status.downloading)) {
            const { received, total } = status.downloading.value;
            yield* server.notifications["notifications/progress"]({
              message: "Downloading the speech model",
              progress: received,
              progressToken: token,
              total,
            });
          }
        })
      );

    return {
      speak: (params) =>
        Effect.gen(function* speak() {
          const ctx = yield* McpSchema.McpRequestContext;
          const token = decodeProgressToken(ctx.requestMetadata?.progressToken);

          const run = speaker.speak({
            speed: params.speed,
            text: params.text,
            voice: params.voice,
          });

          return Option.isSome(token)
            ? yield* run.pipe(Effect.raceFirst(reportProgress(token.value)))
            : yield* run;
        }),
      stop: () => speaker.stop,
    };
  })
);

const SkillResource = McpServer.resource({
  content: Effect.succeed(skillMarkdown),
  description: "How an agent should write for and call voix.",
  mimeType: "text/markdown",
  name: "voix skill",
  uri: SKILL_URI,
});

/** Kick off the model download at startup so the first `speak` usually finds it ready. */
const EagerPrepare = Layer.effectDiscard(
  Effect.gen(function* EagerPrepare() {
    const provider = yield* Provider;
    yield* Effect.forkScoped(
      provider.prepare.pipe(
        Effect.catch((error) =>
          Console.error(`voix: model preparation failed: ${error.message}`)
        )
      )
    );
  })
);

export const McpLive: Layer.Layer<
  never,
  never,
  Speaker | Provider | Stdio.Stdio
> = Layer.mergeAll(
  McpServer.toolkit(VoixToolkit).pipe(Layer.provide(ToolHandlers)),
  SkillResource,
  EagerPrepare
).pipe(
  Layer.provide(
    McpServer.layerStdio({
      description: "Local voice output for agents",
      instructions: INSTRUCTIONS,
      name: "voix",
      protocols: [McpProtocol.v2025_06_18],
      version: VERSION,
    }).pipe(Layer.orDie)
  ),
  // stdout is the MCP wire; every log line must go to stderr
  Layer.provide(Layer.succeed(Logger.LogToStderr, true))
);
