import { dlopen } from "bun:ffi";

import { Effect } from "effect";

import { loadOrt } from "../../src/providers/kokoro/runtime.ts";

const ort = await Effect.runPromise(loadOrt);

// Read libc independently of the production setter: Bun's JS environment can disagree with native ORT.
const libc = dlopen(
  process.platform === "linux" ? "libc.so.6" : "/usr/lib/libSystem.B.dylib",
  { getenv: { args: ["cstring"], returns: "cstring" } }
);

console.log(
  JSON.stringify({
    telemetryDisabled: String(
      libc.symbols.getenv(Buffer.from("ORT_DISABLE_TELEMETRY\0"))
    ),
    version: ort.env.versions.node,
  })
);

libc.close();
