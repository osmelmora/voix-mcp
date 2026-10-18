import { Effect, Exit, Option } from "effect";

import { downloadModel } from "../../src/providers/kokoro/model.ts";

// Downloads from VOIX_MODEL_URL into VOIX_HOME, expecting the checksum and size given as arguments, and prints how
// the download ended.
const [sha256 = "", size = "0"] = process.argv.slice(2);

const exit = await Effect.runPromiseExit(
  downloadModel(() => Effect.void, { sha256, size: Number(size) })
);

console.log(
  JSON.stringify({
    error: Option.getOrNull(
      Option.map(Exit.findErrorOption(exit), (e) => e._tag)
    ),
    success: Exit.isSuccess(exit),
  })
);
