// eSpeak NG (WASM, via `phonemizer`) + Kokoro's post-processing, ported from kokoro-js so the
// phoneme strings are identical to upstream. Tokenization is per character against tokenizer.json.
import { Effect } from "effect";
import { phonemize as espeak } from "phonemizer";

import { SynthFailed } from "../../core/errors.ts";
import tokenizer from "./assets/tokenizer.json";
import { normalizeText } from "./normalize.ts";

export const SAMPLE_RATE = 24_000;
/** model_max_length 512 minus the two "$" padding tokens. */
export const MAX_PHONEME_TOKENS = 510;

const VOCAB: Record<string, number> = tokenizer.model.vocab;

const PUNCT = ';:,.!?¡¿—…"«»“”(){}[]';
const PUNCT_RE = new RegExp(
  `(\\s*[${PUNCT.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}]+\\s*)+`,
  "g"
);

export type Lang = "en-US" | "en-GB";

async function phonemizeRaw(text: string, lang: Lang): Promise<string> {
  const espeakLang = lang === "en-US" ? "en-us" : "en";
  const normalized = normalizeText(text);
  const parts: string[] = [];
  let last = 0;
  for (const m of normalized.matchAll(PUNCT_RE)) {
    if (last < m.index) {
      // The eSpeak WASM instance is shared; process each segment sequentially.
      // oxlint-disable-next-line no-await-in-loop
      const phonemes = await espeak(
        normalized.slice(last, m.index),
        espeakLang
      );
      parts.push(phonemes.join(" "));
    }
    if (m[0].length > 0) {
      parts.push(m[0]);
    }
    last = m.index + m[0].length;
  }
  if (last < normalized.length) {
    const phonemes = await espeak(normalized.slice(last), espeakLang);
    parts.push(phonemes.join(" "));
  }
  let ps = parts
    .join("")
    .replaceAll("kəkˈoːɹoʊ", "kˈoʊkəɹoʊ")
    .replaceAll("kəkˈɔːɹəʊ", "kˈəʊkəɹəʊ")
    .replaceAll("ʲ", "j")
    .replaceAll("r", "ɹ")
    .replaceAll("x", "k")
    .replaceAll("ɬ", "l")
    .replaceAll(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, " ")
    .replaceAll(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, "z");
  if (lang === "en-US") {
    ps = ps.replaceAll(/(?<=nˈaɪn)ti(?!ː)/g, "di");
  }
  return ps.trim();
}

export const phonemize = (
  text: string,
  lang: Lang
): Effect.Effect<string, SynthFailed> =>
  Effect.tryPromise({
    try: () => phonemizeRaw(text, lang),
    catch: (e) =>
      new SynthFailed({ reason: `phonemization failed: ${String(e)}` }),
  });

/** Map phonemes to token ids, wrapped in the "$" (0) padding tokens. Unknown characters are dropped. */
export function tokenize(phonemes: string): number[] {
  const ids: number[] = [];
  for (const ch of phonemes) {
    const id = VOCAB[ch];
    if (id !== undefined) {
      ids.push(id);
    }
  }
  return [0, ...ids.slice(0, MAX_PHONEME_TOKENS), 0];
}

/** Split a phoneme string into pieces that fit the model's token limit, breaking on spaces. */
export function splitPhonemes(
  phonemes: string,
  max = MAX_PHONEME_TOKENS
): string[] {
  if ([...phonemes].length <= max) {
    return [phonemes];
  }
  const pieces: string[] = [];
  let current = "";
  for (const word of phonemes.split(" ")) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if ([...candidate].length > max && current.length > 0) {
      pieces.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    pieces.push(current);
  }
  return pieces;
}
