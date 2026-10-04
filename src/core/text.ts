/** Hard cap on one speak request, in characters (about ten minutes of speech). */
export const MAX_TEXT_LENGTH = 10_000;

/** Longest piece handed to the provider at once; longer sentences are split on words. */
const MAX_SENTENCE_CHARS = 400;

/**
 * Turn agent output (usually markdown) into plain prose a TTS engine can read.
 * Code blocks and images are dropped, structure becomes sentences, inline markup is removed.
 */
export function toSpeakable(input: string): string {
  let t = input.replaceAll(/\r\n?/g, "\n");
  t = t.replaceAll(/```[\s\S]*?```/g, " ");
  t = t.replaceAll(/~~~[\s\S]*?~~~/g, " ");
  t = t.replaceAll(/`([^`\n]+)`/g, "$1");
  t = t.replaceAll(/!\[[^\]]*\]\([^)]*\)/g, " ");
  t = t.replaceAll(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  t = t.replaceAll(/<[^>\n]+>/g, " ");
  // headers become their own sentence
  t = t.replaceAll(
    /^[ \t]{0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/gm,
    (_, h: string) => endSentence(h)
  );
  t = t.replaceAll(/^[ \t]*>[ \t]?/gm, "");
  t = t.replaceAll(/^[ \t]*([-*_][ \t]*){3,}$/gm, " ");
  // table separator rows vanish, table rows become comma lists
  t = t.replaceAll(
    /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm,
    " "
  );
  t = t.replaceAll(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_, row: string) =>
    endSentence(
      row
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean)
        .join(", ")
    )
  );
  // list markers
  t = t.replaceAll(/^[ \t]*[-*+•][ \t]+/gm, "");
  t = t.replaceAll(/^[ \t]*\d+[.)][ \t]+/gm, "");
  t = t.replaceAll(/^[ \t]*\[[ xX]\][ \t]+/gm, "");
  // inline emphasis
  t = t.replaceAll(/(\*\*|__)(.+?)\1/g, "$2");
  t = t.replaceAll(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2");
  t = t.replaceAll(/~~(.+?)~~/g, "$1");
  t = t.replaceAll(/[*_]{2,}/g, " ");
  // whitespace
  t = t.replaceAll(/[ \t]+/g, " ");
  t = t.replaceAll(/[ \t]*\n[ \t]*/g, "\n").replaceAll(/\n{2,}/g, "\n");
  return t.trim();
}

function endSentence(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length === 0) {
    return "";
  }
  return /[.!?:;…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Split speakable text into sentences. Newlines are always boundaries. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    for (const part of line.split(/(?<=[.!?…]["'”’)\]]?)\s+/)) {
      const s = part.trim();
      if (s.length > 0) {
        out.push(...splitLong(s));
      }
    }
  }
  return out;
}

function splitLong(sentence: string): string[] {
  if (sentence.length <= MAX_SENTENCE_CHARS) {
    return [sentence];
  }
  const pieces: string[] = [];
  let current = "";
  for (const word of sentence.split(/\s+/)) {
    if (
      current.length > 0 &&
      current.length + 1 + word.length > MAX_SENTENCE_CHARS
    ) {
      pieces.push(current);
      current = word;
    } else {
      current = current.length === 0 ? word : `${current} ${word}`;
    }
  }
  if (current.length > 0) {
    pieces.push(current);
  }
  return pieces;
}
