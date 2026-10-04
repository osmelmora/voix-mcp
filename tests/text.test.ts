import { describe, expect, test } from "bun:test"
import { splitSentences, toSpeakable } from "../src/core/text.ts"

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
      "See [the board](https://example.com/board) for details."
    ].join("\n")
    const out = toSpeakable(md)
    expect(out).toBe(
      "Daily update.\nYou have three meetings today:\nDesign review at 10\n1:1 with Sam\nSee the board for details."
    )
  })

  test("tables become comma lists", () => {
    const out = toSpeakable("| name | count |\n|---|---|\n| apples | 3 |")
    expect(out).toBe("name, count.\napples, 3.")
  })

  test("keeps plain text untouched", () => {
    expect(toSpeakable("Good morning. Nothing is overdue.")).toBe("Good morning. Nothing is overdue.")
  })
})

describe("splitSentences", () => {
  test("splits on terminal punctuation and newlines", () => {
    expect(splitSentences("Hello there. How are you? Fine!\nNew line")).toEqual([
      "Hello there.",
      "How are you?",
      "Fine!",
      "New line"
    ])
  })

  test("keeps closing quotes with the sentence", () => {
    expect(splitSentences('She said "go." Then left.')).toEqual(['She said "go."', "Then left."])
  })

  test("breaks very long sentences on words", () => {
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ")
    const parts = splitSentences(long)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(400)
    expect(parts.join(" ")).toBe(long)
  })

  test("ignores empty input", () => {
    expect(splitSentences("   \n  ")).toEqual([])
  })
})
