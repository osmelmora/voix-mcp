/** Hard cap on one speak request, in characters (about ten minutes of speech). */
export const MAX_TEXT_LENGTH = 10_000;

/** Longest piece handed to the provider at once; longer sentences are split on words. */
const MAX_SENTENCE_CHARS = 400;

const endSentence = (s: string): string => {
  const trimmed = s.trim();

  if (trimmed.length === 0) {
    return "";
  }

  return /[.!?:;…]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
};

const splitLong = (sentence: string): string[] => {
  if (sentence.length <= MAX_SENTENCE_CHARS) {
    return [sentence];
  }

  const pieces: string[] = [];
  let current = "";

  for (const word of sentence.split(/\s+/u)) {
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
};

/**
 * Turn agent output (usually markdown) into plain prose a TTS engine can read.
 * Code blocks and images are dropped, structure becomes sentences, inline markup is removed.
 */
export const toSpeakable = (input: string): string => {
  let t = input.replaceAll(/\r\n?/gu, "\n");
  t = t.replaceAll(/```[\s\S]*?```/gu, " ");
  t = t.replaceAll(/~~~[\s\S]*?~~~/gu, " ");
  t = t.replaceAll(/`(?<code>[^`\n]+)`/gu, "$<code>");
  t = t.replaceAll(/!\[[^\]]*\]\([^)]*\)/gu, " ");
  t = t.replaceAll(/\[(?<label>[^\]]+)\]\([^)]*\)/gu, "$<label>");
  t = t.replaceAll(/<[^>\n]+>/gu, " ");
  // headers become their own sentence
  t = t.replaceAll(
    /^[ \t]{0,3}#{1,6}[ \t]+(?<heading>.*?)[ \t]*#*[ \t]*$/gmu,
    (_, h: string) => endSentence(h)
  );
  t = t.replaceAll(/^[ \t]*>[ \t]?/gmu, "");
  t = t.replaceAll(/^[ \t]*(?:[-*_][ \t]*){3,}$/gmu, " ");
  // table separator rows vanish, table rows become comma lists
  t = t.replaceAll(
    /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gmu,
    " "
  );
  t = t.replaceAll(/^[ \t]*\|(?<row>.+)\|[ \t]*$/gmu, (_, row: string) =>
    endSentence(
      row
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean)
        .join(", ")
    )
  );
  // list markers
  t = t.replaceAll(/^[ \t]*[-*+•][ \t]+/gmu, "");
  t = t.replaceAll(/^[ \t]*\d+[.)][ \t]+/gmu, "");
  t = t.replaceAll(/^[ \t]*\[[ xX]\][ \t]+/gmu, "");
  // inline emphasis
  t = t.replaceAll(/(?<mark>\*\*|__)(?<inner>.+?)\k<mark>/gu, "$<inner>");
  t = t.replaceAll(
    /(?<lead>^|[^\w*])[*_](?<inner>[^*_\n]+)[*_](?=[^\w*]|$)/gu,
    "$<lead>$<inner>"
  );
  t = t.replaceAll(/~~(?<inner>.+?)~~/gu, "$<inner>");
  t = t.replaceAll(/[*_]{2,}/gu, " ");
  // whitespace
  t = t.replaceAll(/[ \t]+/gu, " ");
  t = t.replaceAll(/[ \t]*\n[ \t]*/gu, "\n").replaceAll(/\n{2,}/gu, "\n");

  return t.trim();
};

/** Split speakable text into sentences. Newlines are always boundaries. */
export const splitSentences = (text: string): string[] => {
  const out: string[] = [];

  for (const line of text.split("\n")) {
    for (const part of line.split(/(?<=[.!?…]["'”’)\]]?)\s+/u)) {
      const s = part.trim();

      if (s.length > 0) {
        out.push(...splitLong(s));
      }
    }
  }

  return out;
};
