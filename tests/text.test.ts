import { describe, expect, test } from "bun:test";

import { splitSentences, toSpeakable } from "../src/core/text.ts";
import { normalizeText } from "../src/providers/kokoro/normalize.ts";

// Median of nine timed batches of five splits, in milliseconds.
const median = (text: string): number => {
  const runs: number[] = [];

  for (let i = 0; i < 9; i += 1) {
    const t = performance.now();

    for (let j = 0; j < 5; j += 1) {
      splitSentences(text);
    }

    runs.push(performance.now() - t);
  }

  return runs.toSorted((a, b) => a - b)[4] ?? 0;
};

const ONSET =
  /^(?:[aeiou]|(?:[b-df-hj-np-tv-z]|[bcfgkp][lr]|dr|dw|gn|kn|ph|ps|rh|sc|sh|sk|sl|sm|sn|sp|squ|st|sw|th|tr|tw|wh|wr|chr|phr|sch|scr|shr|spl|spr|str|thr)[aeiouy])/u;

// Letters read one by one, "W" counting four and "H" two.
const names = (l: string) =>
  l.length +
  3 * (l.match(/w/giu)?.length ?? 0) +
  (l.match(/h/giu)?.length ?? 0);

// Letters a run of letters costs as if read one by one.
const spelledLetters = (run: string): number => {
  const caps = /^(?<caps>\p{Lu}{2,})s?$/u.exec(run)?.groups?.["caps"];

  if (/^[ivx]{2,}$/iu.test(run)) {
    return 3 * run.length;
  }

  if (caps !== undefined) {
    return caps.length > 4 ? Number.POSITIVE_INFINITY : names(caps);
  }

  if (/^[aAI]$/u.test(run)) {
    return 0;
  }

  if (!ONSET.test(run.toLowerCase())) {
    return names(run);
  }

  return run.length <= 4 ? run.length : 0;
};

// The first-sentence join rule, restated: plain characters, no token over 15 characters
// or number over four digits, and a speech cost of at most 50.
const plain = (p: string) => {
  const tokens = p
    .replaceAll(/(?<=\d) (?=\d{3}(?!\d))/gu, "")
    .split(/[\s\-–—]+/u)
    .map((w) => w.replaceAll(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, ""));

  const runs = (
    p.replaceAll(/['’](?:s|t|re|ve|ll|d|m)\b/giu, "").match(/[A-Za-z]+/gu) ?? []
  ).flatMap((r) =>
    r.split(/(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll}{2})/u)
  );

  const digits = p.match(/\d/gu)?.length ?? 0;

  return (
    /^[A-Za-z\d\s.,;:!?'"‘’“”()\-–—]*$/u.test(p) &&
    tokens.every(
      (w) => w.length <= 15 && (w.match(/\d/gu)?.length ?? 0) <= 4
    ) &&
    p.length + runs.reduce((n, r) => n + spelledLetters(r), 0) + 4 * digits <=
      50
  );
};

describe("toSpeakable", () => {
  test("strips markdown structure into prose", () => {
    const md = [
      "# Daily update",
      "",
      "You have **three** meetings today:",
      "",
      "- Design review at 10",
      "- 1:1 with *Sam*",
      "",
      "```ts",
      "const x = 1",
      "```",
      "",
      "See [the board](https://example.com/board) for details.",
    ].join("\n");

    const out = toSpeakable(md);
    expect(out).toBe(
      "Daily update.\nYou have three meetings today:\nDesign review at 10\n1:1 with Sam\nSee the board for details."
    );
  });

  test("tables become comma lists", () => {
    const out = toSpeakable("| name | count |\n|---|---|\n| apples | 3 |");
    expect(out).toBe("name, count.\napples, 3.");
  });

  test("drops invisible characters, spaces zero-width spaces, keeps joiners", () => {
    expect(toSpeakable("\uFEFF\u200B\nso\u00ADlo\u2060")).toBe("solo");
    expect(toSpeakable("hello\u200Bworld")).toBe("hello world");
    // Hangul fillers are letters that say nothing
    expect(toSpeakable("\u115F\u1160\u3164\uFFA0done")).toBe("done");
    // joiners and variation selectors shape emoji: woman technologist, red heart
    expect(toSpeakable("👩\u200D💻 \u2764\uFE0F")).toBe(
      "👩\u200D💻 \u2764\uFE0F"
    );
  });

  test("keeps plain text untouched", () => {
    expect(toSpeakable("Good morning. Nothing is overdue.")).toBe(
      "Good morning. Nothing is overdue."
    );
  });
});

describe("splitSentences", () => {
  test("splits on terminal punctuation and newlines", () => {
    expect(splitSentences("Hello there. How are you? Fine!\nNew line")).toEqual(
      ["Hello there.", "How are you?", "Fine!", "New line"]
    );
  });

  test("keeps closing quotes with the sentence", () => {
    expect(splitSentences('She said "go." Then left.')).toEqual([
      'She said "go."',
      "Then left.",
    ]);
  });

  test("breaks very long sentences on words", () => {
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const parts = splitSentences(long);
    expect(parts.length).toBeGreaterThan(1);

    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(400);
    }

    expect(parts.join(" ")).toBe(long);
  });

  test.each([
    // joins: the period belongs to an abbreviation inside the sentence
    ["Dr. Smith arrived.", ["Dr. Smith arrived."]],
    ["Prof. Lee vs. Dr. Kim.", ["Prof. Lee vs. Dr. Kim."]],
    ["(See Dr. Who.) Next.", ["(See Dr. Who.)", "Next."]],
    [
      "Hi. We met on Jan. 5 and Sept. 12.",
      ["Hi.", "We met on Jan. 5 and Sept. 12."],
    ],
    ["The U.K. now leads.", ["The U.K. now leads."]],
    ["The U.S.A. and the U.K. agree.", ["The U.S.A. and the U.K. agree."]],
    ["Meet at 5 p.m. on Monday.", ["Meet at 5 p.m. on Monday."]],
    [
      "Bring fruit, e.g. Apples or pears.",
      ["Bring fruit, e.g. Apples or pears."],
    ],
    ["That is, i.e. the rest.", ["That is, i.e. the rest."]],
    ["Apples, pears, etc. are fine.", ["Apples, pears, etc. are fine."]],
    ["It weighs approx. 5 kilos.", ["It weighs approx. 5 kilos."]],
    ["Acme Inc. shipped it.", ["Acme Inc. shipped it."]],
    ["Item No. 5 is gone.", ["Item No. 5 is gone."]],
    ["J. R. R. Tolkien wrote it.", ["J. R. R. Tolkien wrote it."]],
    ["Dr. J. Smith called.", ["Dr. J. Smith called."]],
    ["Ticket No. 812 is closed.", ["Ticket No. 812 is closed."]],
    ["See e.g. the setup guide first.", ["See e.g. the setup guide first."]],
    [
      "Hi. Meeting moved to Jan. 5 at 3 p.m. on Zoom.",
      ["Hi.", "Meeting moved to Jan. 5 at 3 p.m. on Zoom."],
    ],
    // splits: a real sentence end that only looks like an abbreviation
    [
      "It closed in Feb. Then it reopened.",
      ["It closed in Feb.", "Then it reopened."],
    ],
    [
      "It closed in Feb. 2026 was hard.",
      ["It closed in Feb.", "2026 was hard."],
    ],
    [
      "He moved to the U.K. The next year was hard.",
      ["He moved to the U.K.", "The next year was hard."],
    ],
    ["Meet at 5 p.m. Then we eat.", ["Meet at 5 p.m.", "Then we eat."]],
    [
      "Apples, pears, etc. We have plenty.",
      ["Apples, pears, etc.", "We have plenty."],
    ],
    [
      "Session load 300 ms. afplay: file only.",
      ["Session load 300 ms.", "afplay: file only."],
    ],
    [
      "The request completed in 300 ms. Everything else passed.",
      ["The request completed in 300 ms.", "Everything else passed."],
    ],
    [
      "The abbreviation is Dr. It means doctor.",
      ["The abbreviation is Dr.", "It means doctor."],
    ],
    [
      "Ask the Dr. lab results are back.",
      ["Ask the Dr.", "lab results are back."],
    ],
    ["Mr. and Mrs. Smith came.", ["Mr.", "and Mrs. Smith came."]],
    [
      "Choose option B. The fallback is disabled.",
      ["Choose option B.", "The fallback is disabled."],
    ],
    ["We chose Plan B. Tests pass.", ["We chose Plan B.", "Tests pass."]],
    ["Pick A. B is slower.", ["Pick A.", "B is slower."]],
    ["Pick A. Bigger is slower.", ["Pick A.", "Bigger is slower."]],
    [
      "I chose Variant B. Run the tests.",
      ["I chose Variant B.", "Run the tests."],
    ],
    ["The label is Dr. Tests pass.", ["The label is Dr.", "Tests pass."]],
    [
      "CI status: No. 12 tests still fail.",
      ["CI status: No.", "12 tests still fail."],
    ],
    [
      "The response is No. 2026 is not supported.",
      ["The response is No.", "2026 is not supported."],
    ],
    // a lowercase command, path, identifier or version opens a sentence
    [
      "Removed caches, logs, etc. npm test now passes.",
      ["Removed caches, logs, etc.", "npm test now passes."],
    ],
    [
      "The deploy ran at 5 p.m. npm reported no errors.",
      ["The deploy ran at 5 p.m.", "npm reported no errors."],
    ],
    [
      "Cleaned the U.S. src/core/text.ts now handles it.",
      ["Cleaned the U.S.", "src/core/text.ts now handles it."],
    ],
    [
      "Updated docs, tests, etc. package.json lists it.",
      ["Updated docs, tests, etc.", "package.json lists it."],
    ],
    [
      "Shipped at 9 a.m. v0.3.0 is the latest.",
      ["Shipped at 9 a.m.", "v0.3.0 is the latest."],
    ],
    [
      "Moved to Acme Inc. git push failed.",
      ["Moved to Acme Inc.", "git push failed."],
    ],
    [
      "Logs, caches, etc. splitSentences is linear.",
      ["Logs, caches, etc.", "splitSentences is linear."],
    ],
    [
      "Configs, etc. --verbose prints timings.",
      ["Configs, etc.", "--verbose prints timings."],
    ],
    // known cost of splitting when in doubt: a sentence-initial name loses its initial
    ["John F. Kennedy spoke.", ["John F.", "Kennedy spoke."]],
    [
      "President John F. Kennedy spoke.",
      ["President John F.", "Kennedy spoke."],
    ],
    ["No. 2026 is the target year.", ["No.", "2026 is the target year."]],
    [
      "Did it work? No. 5 tests failed.",
      ["Did it work?", "No.", "5 tests failed."],
    ],
    [
      "Did it work? No. Then we retry.",
      ["Did it work?", "No.", "Then we retry."],
    ],
    ["So do I. Then what?", ["So do I.", "Then what?"]],
    ["John Smith Jr. Then he left.", ["John Smith Jr.", "Then he left."]],
    ["Acme Inc. 5 people left.", ["Acme Inc.", "5 people left."]],
    // unrelated punctuation keeps its old behaviour
    [
      "Version 2.4.1 is out. It costs $1,200.50 now.",
      ["Version 2.4.1 is out.", "It costs $1,200.50 now."],
    ],
    ["It's 14.5 degrees. Cold.", ["It's 14.5 degrees.", "Cold."]],
    ["Well... I guess so.", ["Well...", "I guess so."]],
    ["Really?! Yes.", ["Really?!", "Yes."]],
    ['She said "etc." Then left.', ['She said "etc."', "Then left."]],
    ["Dr.\nSmith", ["Dr.", "Smith"]],
  ])("abbreviations: %p", (text, expected) => {
    expect(splitSentences(text)).toEqual(expected);
  });

  test("normalization sees the whole sentence around an abbreviation", () => {
    const spoken = splitSentences(
      toSpeakable("Dr. Smith arrived. Mr. Jones left the U.K. now.")
    ).map(normalizeText);

    expect(spoken).toEqual([
      "Doctor Smith arrived.",
      "Mister Jones left the U-K- now.",
    ]);
  });

  test("etc. keeps its period only where it ends a sentence", () => {
    expect(
      splitSentences(
        "Apples, pears, etc. are fine. Apples, pears, etc. We eat."
      ).map(normalizeText)
    ).toEqual([
      "Apples, pears, etc are fine.",
      "Apples, pears, etc",
      "We eat.",
    ]);
    expect(normalizeText("Apples, etc. We eat.")).toBe("Apples, etc. We eat.");
    expect(normalizeText("Apples, etc. are fine.")).toBe(
      "Apples, etc are fine."
    );
  });

  test("a join never grows the first sentence past its speech cost", () => {
    const tail =
      "reviewed the latency report and asked about the targets for first audio.";

    expect(splitSentences(`Dr. Smith ${tail}`)).toEqual([
      "Dr.",
      `Smith ${tail}`,
    ]);
    expect(splitSentences(`Hi. Dr. Smith ${tail}`)).toEqual([
      "Hi.",
      `Dr. Smith ${tail}`,
    ]);
    expect(splitSentences("Dr. Smith reviewed the latency report.")).toEqual([
      "Dr. Smith reviewed the latency report.",
    ]);
  });

  test("the first sentence joins only plain prose", () => {
    // each joined form took 2 to 3 s to first audio instead of 0.25 to 0.35 s
    expect(
      splitSentences("It accepts approx. 18446744073709551615 records.")
    ).toEqual(["It accepts approx.", "18446744073709551615 records."]);
    expect(
      splitSentences(
        "Dr. Smith checked HTTPS, JSON, XML, SQL, HTML, CSS, CPU, GPU, TCP, UDP, TLS."
      )[0]
    ).toBe("Dr.");
    expect(
      splitSentences(
        "Dr. Smith checked 0123456789abcdef0123456789abcdef0123456789abcdef0123456789."
      )[0]
    ).toBe("Dr.");

    for (const text of [
      "Dr. Smith had 1234, 5678 and 9012 items.",
      "Dr. Smith typed A B C D E F G H J K L M N O P Q R S T U V W X Y Z.",
      "Dr. Smith wrote $ & + = # @ % ~ ^ * $ & + = # @ % ~ ^ * $ & + = #.",
      "Dr. Smith wrote 東京 and 大阪.",
      "Dr. Smith spelled a-b-c-d-e-f-g-h, i-j-k-l-m-n-o-p and more.",
    ]) {
      expect(splitSentences(text)[0]).toBe("Dr.");
    }

    // short acronyms and a short number are cheap to speak
    for (const text of [
      "Dr. Smith approved the PR.",
      "Dr. Smith merged two PRs and fixed CI.",
      "Dr. Smith fixed CI on macOS.",
      "Dr. Smith filed 7777 notes.",
    ]) {
      expect(splitSentences(text)).toEqual([text]);
    }

    // letters read one by one, digits, Roman numerals and words eSpeak spells out add up;
    // joined, such forms took 1.2 to 3.9 s to first audio instead of 0.25 s
    for (const text of [
      "Dr. Smith checked API, CLI, SDK and AWS.",
      "Dr. Smith filed 7777 and 77 notes.",
      "Dr. Smith filed 777,777 notes.",
      "Dr. Smith filed 3.14159 notes.",
      "Dr. Smith filed 777 777 notes.",
      "Dr. Smith saw W,W,W,W,W,W,W W,W,W,W,W,W,W W,W,W,W,W,W,W.",
      "Dr. Smith saw W's, W's, W's and W's.",
      "Dr. Smith saw wwwwwwwwwwwwww wwwwwwwwwwwwww.",
      "Dr. Smith saw bcdfghjklmnpqra twice.",
      "Dr. Smith read xviii and xxviii.",
      "Dr. Smith said ox ox ox ox ox ox ox ox ox ox.",
      "Dr. Smith fixed the CI's cache on macOS and iOS via GitHub.",
      "Dr. Smith saw WWW and WW today.",
      "Dr. Smith checked NGINX.",
      "Dr. Smith saw B C D E F G H J K L M N O today.",
      "Dr. Smith met José.",
      "Dr. Smith saw ｗｗｗ.",
      "Dr. Smith filed 7777 and 77 notes, then wrote seventy-seven more drafts today.",
    ]) {
      expect(splitSentences(text)[0]).toBe("Dr.");
    }

    // an acronym after a title is not a name, in any sentence
    expect(splitSentences("Hi. The label is Dr. CI passed.")).toEqual([
      "Hi.",
      "The label is Dr.",
      "CI passed.",
    ]);
    // later sentences keep their joins
    expect(splitSentences("Hi. Dr. Smith checked HTTPS.")).toEqual([
      "Hi.",
      "Dr. Smith checked HTTPS.",
    ]);
    // a sentence of initials, a date and a time joins only as far as its cost allows
    expect(
      splitSentences("Dr. J. Smith met U.S. reps on Jan. 5, 2026 at 3 p.m.")
    ).toEqual(["Dr. J. Smith met U.S.", "reps on Jan. 5, 2026 at 3 p.m."]);
    expect(splitSentences("Item No. 5 is done.")).toEqual([
      "Item No. 5 is done.",
    ]);
  });

  test("a piece without letters or digits does not spend the first-sentence bound", () => {
    const long = `Dr. Smith ${"reviewed the report ".repeat(15)}today.`;

    expect(splitSentences(`—\n${long}`).slice(0, 2)).toEqual(["—", "Dr."]);
    expect(splitSentences(toSpeakable(`\u200B\n${long}`))[0]).toBe("Dr.");
    // a Hangul filler is a letter that says nothing
    expect(splitSentences(`\u115F\n${long}`).slice(0, 2)).toEqual([
      "\u115F",
      "Dr.",
    ]);
    expect(splitSentences(toSpeakable(`\u115F\n${long}`))[0]).toBe("Dr.");
  });

  test("joined abbreviations still respect the length cap", () => {
    const long = `Hi. Dr. ${Array.from({ length: 120 }, (_, i) => `Word${i}`).join(" ")}.`;
    const parts = splitSentences(long);

    expect(parts.length).toBeGreaterThan(2);
    expect(parts[1]?.startsWith("Dr. Word0")).toBe(true);

    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(400);
    }
  });

  test("the length cap does not end a piece on a joined abbreviation", () => {
    const parts = splitSentences(
      `Hi. ${"a ".repeat(197)}Dr. J. Smith arrived.`
    );

    expect(parts.length).toBe(3);
    expect(parts[2]).toBe("Dr. J. Smith arrived.");
  });

  test("the cap wins over keeping an abbreviation with its word", () => {
    const name = "S".repeat(397);
    const url = `https://example.com/${"x".repeat(376)}`;

    for (const text of [
      `Hi. ${"a ".repeat(196)}Dr. ${name} arrived.`,
      `Hi. ${"a ".repeat(196)}see e.g. ${url} for more.`,
    ]) {
      for (const p of splitSentences(text)) {
        expect(p.length).toBeLessThanOrEqual(400);
      }
    }
  });

  test("random text keeps every word, fits the cap and joins only cheap prose first", () => {
    // Park-Miller, seeded so a failure reproduces
    let seed = 31;

    const random = () => {
      seed = (seed * 48_271) % 2_147_483_647;

      return seed / 2_147_483_647;
    };

    const vocabulary = [
      "Dr.",
      "Mr.",
      "Prof.",
      "J.",
      "R.",
      "B.",
      "I.",
      "U.S.",
      "p.m.",
      "etc.",
      "No.",
      "Jan.",
      "e.g.",
      "vs.",
      "Inc.",
      "approx.",
      "item",
      "Smith",
      "Lee",
      "the",
      "npm",
      "src/a.ts",
      "5",
      "2026",
      "It",
      "The",
      "option",
      "word.",
      "done!",
      "why?",
      "(see",
      "Dr.)",
      "HTTPS",
      "PR",
      "APIs",
      "WWW",
      "iOS",
      "18446744073709551615",
      "a1b2c3d4e5f6a7b8c9",
      "777,777",
      "W's",
      "www",
      "xvii",
      "ox",
      "kgu",
      "—",
      "$",
      "Q",
      "\n",
    ];

    const boundary = /(?<=[.!?…]["'”’)\]]?)\s+/u;

    for (let c = 0; c < 3000; c += 1) {
      const words = Array.from(
        { length: 1 + Math.floor(random() * 250) },
        () =>
          random() < 0.01
            ? "x".repeat(1 + Math.floor(random() * 450))
            : (vocabulary[Math.floor(random() * vocabulary.length)] ?? "")
      );

      const text = words.join(" ");
      const parts = splitSentences(text);

      expect(parts.flatMap((p) => p.split(/\s+/u))).toEqual(
        text.split(/\s+/u).filter(Boolean)
      );

      for (const p of parts) {
        expect(p.trim()).toBe(p);
        expect(p.length > 0).toBe(true);
        expect(p.length <= 400 || !/\s/u.test(p)).toBe(true);
      }

      const first = parts.find((p) => /[\p{L}\p{N}]/u.test(p)) ?? "";
      expect(first.split(boundary).length === 1 || plain(first)).toBe(true);
    }
  });

  test("chains of abbreviations split in linear time", () => {
    const unit =
      "A. B. Dr. J. Smith met U.S. reps on Jan. 5 at 3 p.m. etc. and left. ";

    const small = unit.repeat(40);
    const large = unit.repeat(160);

    median(large);

    // four times the input takes about four times as long; quadratic would take sixteen
    expect(median(large) / median(small)).toBeLessThan(8);
  });

  test("ignores empty input", () => {
    expect(splitSentences("   \n  ")).toEqual([]);
  });
});
