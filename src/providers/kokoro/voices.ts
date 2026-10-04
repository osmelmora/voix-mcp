// Embedded Kokoro voices. The .bin files are [510, 1, 256] float32 style vectors
// from onnx-community/Kokoro-82M-v1.0-ONNX (Apache-2.0).
import type { Voice } from "../provider.ts"

import af_heart from "./assets/voices/af_heart.bin" with { type: "file" }
import af_alloy from "./assets/voices/af_alloy.bin" with { type: "file" }
import af_aoede from "./assets/voices/af_aoede.bin" with { type: "file" }
import af_bella from "./assets/voices/af_bella.bin" with { type: "file" }
import af_jessica from "./assets/voices/af_jessica.bin" with { type: "file" }
import af_kore from "./assets/voices/af_kore.bin" with { type: "file" }
import af_nicole from "./assets/voices/af_nicole.bin" with { type: "file" }
import af_nova from "./assets/voices/af_nova.bin" with { type: "file" }
import af_river from "./assets/voices/af_river.bin" with { type: "file" }
import af_sarah from "./assets/voices/af_sarah.bin" with { type: "file" }
import af_sky from "./assets/voices/af_sky.bin" with { type: "file" }
import am_adam from "./assets/voices/am_adam.bin" with { type: "file" }
import am_echo from "./assets/voices/am_echo.bin" with { type: "file" }
import am_eric from "./assets/voices/am_eric.bin" with { type: "file" }
import am_fenrir from "./assets/voices/am_fenrir.bin" with { type: "file" }
import am_liam from "./assets/voices/am_liam.bin" with { type: "file" }
import am_michael from "./assets/voices/am_michael.bin" with { type: "file" }
import am_onyx from "./assets/voices/am_onyx.bin" with { type: "file" }
import am_puck from "./assets/voices/am_puck.bin" with { type: "file" }
import am_santa from "./assets/voices/am_santa.bin" with { type: "file" }
import bf_alice from "./assets/voices/bf_alice.bin" with { type: "file" }
import bf_emma from "./assets/voices/bf_emma.bin" with { type: "file" }
import bf_isabella from "./assets/voices/bf_isabella.bin" with { type: "file" }
import bf_lily from "./assets/voices/bf_lily.bin" with { type: "file" }
import bm_daniel from "./assets/voices/bm_daniel.bin" with { type: "file" }
import bm_fable from "./assets/voices/bm_fable.bin" with { type: "file" }
import bm_george from "./assets/voices/bm_george.bin" with { type: "file" }
import bm_lewis from "./assets/voices/bm_lewis.bin" with { type: "file" }

export const VOICE_FILES: Record<string, string> = {
  af_heart,
  af_alloy,
  af_aoede,
  af_bella,
  af_jessica,
  af_kore,
  af_nicole,
  af_nova,
  af_river,
  af_sarah,
  af_sky,
  am_adam,
  am_echo,
  am_eric,
  am_fenrir,
  am_liam,
  am_michael,
  am_onyx,
  am_puck,
  am_santa,
  bf_alice,
  bf_emma,
  bf_isabella,
  bf_lily,
  bm_daniel,
  bm_fable,
  bm_george,
  bm_lewis,
}

export const KOKORO_VOICE_IDS = [
  "af_heart",
  "af_alloy",
  "af_aoede",
  "af_bella",
  "af_jessica",
  "af_kore",
  "af_nicole",
  "af_nova",
  "af_river",
  "af_sarah",
  "af_sky",
  "am_adam",
  "am_echo",
  "am_eric",
  "am_fenrir",
  "am_liam",
  "am_michael",
  "am_onyx",
  "am_puck",
  "am_santa",
  "bf_alice",
  "bf_emma",
  "bf_isabella",
  "bf_lily",
  "bm_daniel",
  "bm_fable",
  "bm_george",
  "bm_lewis",
] as const

export type KokoroVoiceId = (typeof KOKORO_VOICE_IDS)[number]

export const DEFAULT_VOICE: KokoroVoiceId = "af_heart"

const describe = (id: string): Voice => {
  const [prefix, raw] = id.split("_") as [string, string]
  return {
    id,
    name: raw.charAt(0).toUpperCase() + raw.slice(1),
    language: prefix.charAt(0) === "a" ? "en-US" : "en-GB",
    gender: prefix.charAt(1) === "f" ? "female" : "male"
  }
}

export const KOKORO_VOICES: ReadonlyArray<Voice> = KOKORO_VOICE_IDS.map(describe)
