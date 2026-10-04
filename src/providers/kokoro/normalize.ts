// Kokoro's English text normalization, ported from kokoro-js (Apache-2.0) so phonemes match upstream.

function splitNum(m: string): string {
  if (m.includes(".")) {
    return m;
  }
  if (m.includes(":")) {
    const [h, mi] = m.split(":").map(Number) as [number, number];
    if (mi === 0) {
      return `${h} o'clock`;
    }
    return mi < 10 ? `${h} oh ${mi}` : `${h} ${mi}`;
  }
  const y = Number.parseInt(m.slice(0, 4), 10);
  if (y < 1100 || y % 1000 < 10) {
    return m;
  }
  const left = m.slice(0, 2);
  const right = Number.parseInt(m.slice(2, 4), 10);
  const s = m.endsWith("s") ? "s" : "";
  if (y % 1000 >= 100 && y % 1000 <= 999) {
    if (right === 0) {
      return `${left} hundred${s}`;
    }
    if (right < 10) {
      return `${left} oh ${right}${s}`;
    }
  }
  return `${left} ${right}${s}`;
}

function flipMoney(m: string): string {
  const bill = m[0] === "$" ? "dollar" : "pound";
  if (Number.isNaN(Number(m.slice(1)))) {
    return `${m.slice(1)} ${bill}s`;
  }
  if (!m.includes(".")) {
    return `${m.slice(1)} ${bill}${m.slice(1) === "1" ? "" : "s"}`;
  }
  const [b, c] = m.slice(1).split(".") as [string, string];
  const cents = Number.parseInt(c.padEnd(2, "0"), 10);
  const dollarCoin = cents === 1 ? "cent" : "cents";
  const poundCoin = cents === 1 ? "penny" : "pence";
  const coin = m[0] === "$" ? dollarCoin : poundCoin;
  return `${b} ${bill}${b === "1" ? "" : "s"} and ${cents} ${coin}`;
}

function pointNum(m: string): string {
  const [a, b] = m.split(".") as [string, string];
  return `${a} point ${b.split("").join(" ")}`;
}

export function normalizeText(t: string): string {
  return t
    .replaceAll(/[‘’]/g, "'")
    .replaceAll("«", "“")
    .replaceAll("»", "”")
    .replaceAll(/[“”]/g, '"')
    .replaceAll("(", "«")
    .replaceAll(")", "»")
    .replaceAll("、", ", ")
    .replaceAll("。", ". ")
    .replaceAll("！", "! ")
    .replaceAll("，", ", ")
    .replaceAll("：", ": ")
    .replaceAll("；", "; ")
    .replaceAll("？", "? ")
    .replaceAll(/[^\S \n]/g, " ")
    .replace(/  +/, " ")
    .replaceAll(/(?<=\n) +(?=\n)/g, "")
    .replaceAll(/\bD[Rr]\.(?= [A-Z])/g, "Doctor")
    .replaceAll(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, "Mister")
    .replaceAll(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, "Miss")
    .replaceAll(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, "Mrs")
    .replaceAll(/\betc\.(?! [A-Z])/gi, "etc")
    .replaceAll(/\b(y)eah?\b/gi, "$1e'a")
    .replaceAll(
      /\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g,
      splitNum
    )
    .replaceAll(/(?<=\d),(?=\d)/g, "")
    .replaceAll(
      /[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi,
      flipMoney
    )
    .replaceAll(/\d*\.\d+/g, pointNum)
    .replaceAll(/(?<=\d)-(?=\d)/g, " to ")
    .replaceAll(/(?<=\d)S/g, " S")
    .replaceAll(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replaceAll(/(?<=X')S\b/g, "s")
    .replaceAll(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replaceAll(".", "-"))
    .replaceAll(/(?<=[A-Z])\.(?=[A-Z])/gi, "-")
    .trim();
}
