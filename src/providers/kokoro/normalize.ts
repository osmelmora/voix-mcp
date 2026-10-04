// Kokoro's English text normalization, ported from kokoro-js (Apache-2.0) so phonemes match upstream.

function splitNum(m: string): string {
  if (m.includes(".")) return m
  if (m.includes(":")) {
    const [h, mi] = m.split(":").map(Number) as [number, number]
    return mi === 0 ? `${h} o'clock` : mi < 10 ? `${h} oh ${mi}` : `${h} ${mi}`
  }
  const y = parseInt(m.slice(0, 4), 10)
  if (y < 1100 || y % 1000 < 10) return m
  const left = m.slice(0, 2)
  const right = parseInt(m.slice(2, 4), 10)
  const s = m.endsWith("s") ? "s" : ""
  if (y % 1000 >= 100 && y % 1000 <= 999) {
    if (right === 0) return `${left} hundred${s}`
    if (right < 10) return `${left} oh ${right}${s}`
  }
  return `${left} ${right}${s}`
}

function flipMoney(m: string): string {
  const bill = m[0] === "$" ? "dollar" : "pound"
  if (isNaN(Number(m.slice(1)))) return `${m.slice(1)} ${bill}s`
  if (!m.includes(".")) return `${m.slice(1)} ${bill}${m.slice(1) === "1" ? "" : "s"}`
  const [b, c] = m.slice(1).split(".") as [string, string]
  const cents = parseInt(c.padEnd(2, "0"), 10)
  const coin = m[0] === "$" ? (cents === 1 ? "cent" : "cents") : cents === 1 ? "penny" : "pence"
  return `${b} ${bill}${b === "1" ? "" : "s"} and ${cents} ${coin}`
}

function pointNum(m: string): string {
  const [a, b] = m.split(".") as [string, string]
  return `${a} point ${b.split("").join(" ")}`
}

export function normalizeText(t: string): string {
  return t
    .replace(/[‘’]/g, "'")
    .replace(/«/g, "“")
    .replace(/»/g, "”")
    .replace(/[“”]/g, '"')
    .replace(/\(/g, "«")
    .replace(/\)/g, "»")
    .replace(/、/g, ", ")
    .replace(/。/g, ". ")
    .replace(/！/g, "! ")
    .replace(/，/g, ", ")
    .replace(/：/g, ": ")
    .replace(/；/g, "; ")
    .replace(/？/g, "? ")
    .replace(/[^\S \n]/g, " ")
    .replace(/  +/, " ")
    .replace(/(?<=\n) +(?=\n)/g, "")
    .replace(/\bD[Rr]\.(?= [A-Z])/g, "Doctor")
    .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, "Mister")
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, "Miss")
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, "Mrs")
    .replace(/\betc\.(?! [A-Z])/gi, "etc")
    .replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNum)
    .replace(/(?<=\d),(?=\d)/g, "")
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, flipMoney)
    .replace(/\d*\.\d+/g, pointNum)
    .replace(/(?<=\d)-(?=\d)/g, " to ")
    .replace(/(?<=\d)S/g, " S")
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, "s")
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, "-"))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, "-")
    .trim()
}
