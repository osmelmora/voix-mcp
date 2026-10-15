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
  let current: string[] = [];
  let length = 0;

  for (const word of sentence.split(/\s+/u)) {
    if (current.length > 0 && length + 1 + word.length > MAX_SENTENCE_CHARS) {
      // interior period-ended words are joined abbreviations ("Dr.", "J."); carry up to
      // three of them to the next piece with the words they lead into, unless that piece
      // would then pass the cap: the cap wins over keeping an abbreviation with its word
      let keep = current.length;

      while (
        keep > 1 &&
        keep > current.length - 3 &&
        current[keep - 1]?.endsWith(".")
      ) {
        keep -= 1;
      }

      const carried = current.slice(keep).join(" ");

      if (carried.length + 1 + word.length > MAX_SENTENCE_CHARS) {
        keep = current.length;
      }

      pieces.push(current.slice(0, keep).join(" "));
      current = current.slice(keep);
      ({ length } = current.join(" "));
    }

    length += (current.length > 0 ? 1 : 0) + word.length;
    current.push(word);
  }

  if (current.length > 0) {
    pieces.push(current.join(" "));
  }

  return pieces;
};

// default-ignorable characters other than joiners, variation selectors and emoji tags
const INVISIBLE =
  /(?!\u200C|\u200D|\p{Variation_Selector}|[\u{E0020}-\u{E007F}])\p{Default_Ignorable_Code_Point}/gu;

/**
 * Turn agent output (usually markdown) into plain prose a TTS engine can read.
 * Code blocks and images are dropped, structure becomes sentences, inline markup is removed.
 */
export const toSpeakable = (input: string): string => {
  // a zero-width space separates words; other invisible characters (BOM, soft hyphen,
  // Hangul fillers) say nothing, except joiners, variation selectors and emoji tags, which
  // shape emoji and scripts ("👩‍💻" is "woman technologist", not "woman laptop")
  let t = input
    .replaceAll("\u200B", " ")
    .replaceAll(INVISIBLE, "")
    .replaceAll(/\r\n?/gu, "\n");

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

// Every join rule below asks for strong evidence: a wrong split costs a short pause, a
// wrong join delays audio by the whole next sentence and can swallow a real sentence end.

/**
 * Speech cost a join may give the first sentence. The listener waits for the whole first
 * sentence to synthesize, and Kokoro's time follows phonemes, not characters: digits,
 * acronyms and words eSpeak spells out expand several times over. `speechCost` charges
 * for them, so the cap bounds first audio. Later sentences synthesize while earlier ones
 * play; their joins only answer to the 400 character cap.
 */
const FIRST_JOIN_COST = 50;

// ASCII letters, digits and prose punctuation; symbols, emoji, other scripts and other
// Latin letters are read out as words or names ("$ & +", "ß" is "sharp s")
const PLAIN_CHARS = /^[A-Za-z\d\s.,;:!?'"‘’“”()\-–—]*$/u;

// digits in one number, groups joined by `,` or `.` included ("2026" stays plain): past
// four, a number expands into many words ("777,777", "3.14159")
const MAX_NUMBER_DIGITS = 4;

// longer tokens are hashes, URLs or identifiers more often than English words
const MAX_TOKEN_CHARS = 15;

// what a letter read one by one and a digit add to the character they take
const SPELLED_COST = 1;

const DIGIT_COST = 4;

// words this short may be abbreviations or acronyms eSpeak expands or spells ("est", "url")
const SHORT_WORD = 4;

// a vowel, or consonants an English word opens with and then a vowel; eSpeak spells a
// word that opens otherwise ("kg", "bcdfa")
const ONSET =
  /^(?:[aeiou]|(?:[b-df-hj-np-tv-z]|[bcfgkp][lr]|dr|dw|gn|kn|ph|ps|rh|sc|sh|sk|sl|sm|sn|sp|squ|st|sw|th|tr|tw|wh|wr|chr|phr|sch|scr|shr|spl|spr|str|thr)[aeiouy])/u;

/** Letters read one by one, `W` counting four ("double-u") and `H` two ("aitch"). */
const letterNames = (letters: string): number =>
  letters.length +
  3 * (letters.match(/w/giu)?.length ?? 0) +
  (letters.match(/h/giu)?.length ?? 0);

/**
 * Letters that a run of letters costs as if read one by one; `Infinity` for five or more
 * capitals ("HTTPS").
 */
const spelledLetters = (run: string): number => {
  // a Roman numeral is read as "Roman" and a number
  if (/^[ivx]{2,}$/iu.test(run)) {
    return 3 * run.length;
  }

  // capitals only, with an optional plural ("PRs")
  const acronym = /^(?<caps>\p{Lu}{2,})s?$/u.exec(run)?.groups?.["caps"];

  if (acronym !== undefined) {
    return acronym.length > 4 ? Number.POSITIVE_INFINITY : letterNames(acronym);
  }

  if (/^[aAI]$/u.test(run)) {
    return 0;
  }

  const word = run.toLowerCase();

  if (!ONSET.test(word)) {
    return letterNames(word);
  }

  return word.length <= SHORT_WORD ? word.length : 0;
};

/**
 * About how long `text` takes to speak, in characters; `Infinity` for text that is not
 * plain prose: characters outside `PLAIN_CHARS`, a long token or number, or an acronym of
 * five or more capitals.
 */
const speechCost = (text: string): number => {
  if (!PLAIN_CHARS.test(text)) {
    return Number.POSITIVE_INFINITY;
  }

  // eSpeak reads digit groups after a space as one number ("777 777")
  const tokens = text
    .replaceAll(/(?<=\d) (?=\d{3}(?!\d))/gu, "")
    .split(/[\s\-–—]+/u)
    .map((t) => t.replaceAll(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, ""));

  let digits = 0;

  for (const token of tokens) {
    const n = token.match(/\d/gu)?.length ?? 0;

    if (token.length > MAX_TOKEN_CHARS || n > MAX_NUMBER_DIGITS) {
      return Number.POSITIVE_INFINITY;
    }

    digits += n;
  }

  let spelled = 0;

  // contractions and possessives say no letter ("don't", "W's" is "W"); camel case reads
  // as separate words ("GitHub", "macOS", "HTTPServer")
  for (const run of text
    .replaceAll(/['’](?:s|t|re|ve|ll|d|m)\b/giu, "")
    .match(/[A-Za-z]+/gu) ?? []) {
    for (const part of run.split(
      /(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll}{2})/u
    )) {
      spelled += spelledLetters(part);
    }
  }

  return text.length + SPELLED_COST * spelled + DIGIT_COST * digits;
};

// a default-ignorable character says nothing, even one that is a letter (Hangul filler)
const speaks = (piece: string): boolean =>
  /(?!\p{Default_Ignorable_Code_Point})[\p{L}\p{N}]/u.test(piece);

// Titles, case-sensitive so the unit `ms.` is not `Ms.`; they join a following name.
const TITLES = new Set([
  "Capt",
  "Col",
  "Dr",
  "Gen",
  "Gov",
  "Lt",
  "Mr",
  "Mrs",
  "Ms",
  "Mt",
  "Prof",
  "Rep",
  "Rev",
  "Sen",
  "Sgt",
  "St",
]);

// Capitalized words that usually open a sentence, often an agent's report or instruction,
// rather than continue a name.
const STARTERS = new Set([
  "A",
  "Add",
  "Added",
  "After",
  "All",
  "Also",
  "An",
  "And",
  "As",
  "At",
  "Before",
  "Both",
  "Build",
  "But",
  "Check",
  "Done",
  "Each",
  "Error",
  "Everything",
  "Fix",
  "Fixed",
  "For",
  "He",
  "Here",
  "How",
  "I",
  "If",
  "In",
  "Install",
  "It",
  "Its",
  "My",
  "Next",
  "No",
  "Not",
  "Note",
  "Nothing",
  "Now",
  "On",
  "Or",
  "Our",
  "Please",
  "Removed",
  "Run",
  "See",
  "She",
  "So",
  "Test",
  "Tests",
  "That",
  "The",
  "Then",
  "There",
  "These",
  "They",
  "This",
  "Those",
  "To",
  "Try",
  "Updated",
  "Use",
  "Warning",
  "We",
  "What",
  "When",
  "Why",
  "Yes",
  "You",
]);

// Words that label a single letter ("option B.", "Plan A."), so the letter is no initial.
const LABELS = new Set([
  "appendix",
  "block",
  "class",
  "figure",
  "grade",
  "group",
  "level",
  "option",
  "part",
  "phase",
  "plan",
  "section",
  "stage",
  "step",
  "table",
  "tier",
  "type",
]);

// Words that make a following `No.` a number label ("Item No. 5"), not an answer.
const NUMBER_LABELS = new Set([
  "bug",
  "case",
  "issue",
  "item",
  "line",
  "model",
  "order",
  "page",
  "room",
  "step",
  "ticket",
  "version",
]);

const MONTHS = new Set([
  "Apr",
  "Aug",
  "Dec",
  "Feb",
  "Jan",
  "Jul",
  "Jun",
  "Mar",
  "Nov",
  "Oct",
  "Sep",
  "Sept",
]);

// Company and name suffixes; they may end a sentence, so they join only lowercase text.
const SUFFIXES = new Set(["Co", "Corp", "Inc", "Jr", "Ltd", "Sr"]);

// Command names an agent's sentence often opens with in lowercase ("npm test passes").
const COMMANDS = new Set([
  "brew",
  "bun",
  "cargo",
  "cd",
  "curl",
  "docker",
  "git",
  "go",
  "kubectl",
  "ls",
  "make",
  "node",
  "npm",
  "npx",
  "pip",
  "pnpm",
  "python",
  "yarn",
]);

const OPENERS = /^["'“‘([]+/u;

const bareWord = (word: string): string => word.replace(/[^\p{L}]+$/u, "");

const isInitial = (word: string): boolean => /^[A-HJ-Z]\.$/u.test(word);

// an acronym ("CI", "PRs") is a subject more often than a name: "The label is Dr. CI passed."
const isName = (word: string): boolean =>
  /^\p{Lu}/u.test(word) &&
  !/^\p{Lu}{2,}(?:['’]?s)?$/u.test(bareWord(word)) &&
  !STARTERS.has(bareWord(word));

/**
 * A lowercase word that reads as prose. Paths, flags, identifiers, versions and common
 * command names often open a new sentence in lowercase, so they do not continue one;
 * a command missing from `COMMANDS` still does.
 */
const isProse = (word: string): boolean =>
  /^\p{Ll}/u.test(word) &&
  !/[/\\_=@:`]|^-|\p{L}\.\p{L}|\p{L}\d|\d\p{L}|\p{Ll}\p{Lu}/u.test(word) &&
  !COMMANDS.has(bareWord(word));

const firstWord = (s: string): string => s.split(/\s/u, 1)[0] ?? "";

// A single capital initial joins only with name evidence: another initial follows
// ("J. R. R. Tolkien"), or a title or initial precedes it and a name follows ("Dr. J. Smith").
const initialContinues = (
  before: string | undefined,
  start: string
): boolean => {
  if (before !== undefined && LABELS.has(before.toLowerCase())) {
    return false;
  }

  if (isInitial(start)) {
    return true;
  }

  const named =
    before !== undefined &&
    (isInitial(before) || TITLES.has(before.slice(0, -1)));

  return named && start.length > 1 && isName(start);
};

// Abbreviations that may also end a sentence; each joins only text that cannot open one.
const trailingContinues = (
  abbr: string,
  before: string | undefined,
  start: string
): boolean => {
  const prose = isProse(start);

  if (abbr === "No") {
    return (
      before !== undefined &&
      NUMBER_LABELS.has(before.toLowerCase()) &&
      /^\d/u.test(start)
    );
  }

  if (MONTHS.has(abbr)) {
    return prose || /^\d{1,2}(?!\d)/u.test(start);
  }

  if (/^[Aa]pprox$/u.test(abbr)) {
    return prose || /^\d/u.test(start);
  }

  const proseOnly =
    abbr === "etc" ||
    SUFFIXES.has(abbr) ||
    /^(?:[A-Za-z]\.)+[A-Za-z]$/u.test(abbr);

  return proseOnly && prose;
};

/**
 * Whether the period-ended `word` continues into `next` instead of ending a sentence.
 * `before` is the word in front of it, `undefined` when `word` opens the sentence.
 */
const continues = (
  before: string | undefined,
  word: string,
  next: string
): boolean => {
  const bare = word.replace(OPENERS, "");
  const abbr = bare.slice(0, -1);
  const start = firstWord(next).replace(OPENERS, "");

  if (!bare.endsWith(".") || start.length === 0) {
    return false;
  }

  if (TITLES.has(abbr)) {
    return !/^\d/u.test(before ?? "") && isName(start);
  }

  if (abbr === "vs" || abbr === "cf" || /^[EeIi]\.[eg]$/u.test(abbr)) {
    return true;
  }

  if (isInitial(bare)) {
    return initialContinues(before, start);
  }

  return trailingContinues(abbr, before, start);
};

/**
 * Split speakable text into sentences. Newlines are always boundaries.
 * A period followed by space ends a sentence unless `continues` reads it as an abbreviation,
 * and, until a piece with letters or digits has been emitted, the join keeps the sentence
 * within `FIRST_JOIN_COST`.
 */
export const splitSentences = (text: string): string[] => {
  const out: string[] = [];
  // whether a piece that makes sound has been emitted; until then a join delays first audio
  let spoken = false;

  const emit = (sentence: string[]) => {
    const pieces = splitLong(sentence.join(" "));
    out.push(...pieces);
    spoken ||= pieces.some(speaks);
  };

  for (const line of text.split("\n")) {
    let sentence: string[] = [];
    let length = -1;
    // last two words of the sentence so far; enough context for every rule, and linear
    let before: string | undefined;
    let last: string | undefined;

    for (const part of line.split(/(?<=[.!?…]["'”’)\]]?)\s+/u)) {
      const s = part.trim();

      if (s.length === 0) {
        continue;
      }

      const joins =
        last !== undefined &&
        continues(before, last, s) &&
        (spoken ||
          (length + 1 + s.length <= FIRST_JOIN_COST &&
            speechCost(`${sentence.join(" ")} ${s}`) <= FIRST_JOIN_COST));

      if (!joins) {
        if (sentence.length > 0) {
          emit(sentence);
        }

        sentence = [];
        length = -1;
        last = undefined;
      }

      sentence.push(s);
      length += 1 + s.length;
      const words = s.split(/\s+/u);
      before = words.length > 1 ? words.at(-2) : last;
      last = words.at(-1);
    }

    if (sentence.length > 0) {
      emit(sentence);
    }
  }

  return out;
};
