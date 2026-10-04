// Kokoro's English text normalization, ported from kokoro-js (Apache-2.0) so phonemes match upstream.

const splitNum = (m: string): string => {
  if (m.includes(".")) {
    return m;
  }

  if (m.includes(":")) {
    // SAFETY: normalizeText calls this with a time regex match containing both hour and minute digits.
    const [h, mi] = m.split(":").map(Number) as [number, number];

    if (mi === 0) {
      return `${h} o'clock`;
    }

    return mi < 10 ? `${h} oh ${mi}` : `${h} ${mi}`;
  }

  const y = Number(m.slice(0, 4));

  if (y < 1100 || y % 1000 < 10) {
    return m;
  }

  const left = m.slice(0, 2);
  const right = Number(m.slice(2, 4));
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
};

const flipMoney = (m: string): string => {
  const bill = m[0] === "$" ? "dollar" : "pound";

  if (Number.isNaN(Number(m.slice(1)))) {
    return `${m.slice(1)} ${bill}s`;
  }

  if (!m.includes(".")) {
    return `${m.slice(1)} ${bill}${m.slice(1) === "1" ? "" : "s"}`;
  }

  // SAFETY: the money regex supplies digits, and the no-decimal branch above has already returned.
  const [b, c] = m.slice(1).split(".") as [string, string];
  const cents = Number(c.padEnd(2, "0"));
  const dollarCoin = cents === 1 ? "cent" : "cents";
  const poundCoin = cents === 1 ? "penny" : "pence";
  const coin = m[0] === "$" ? dollarCoin : poundCoin;

  return `${b} ${bill}${b === "1" ? "" : "s"} and ${cents} ${coin}`;
};

const pointNum = (m: string): string => {
  // SAFETY: the decimal regex always matches a dot followed by at least one digit, yielding two parts.
  const [a, b] = m.split(".") as [string, string];

  return `${a} point ${b.split("").join(" ")}`;
};

export const normalizeText = (t: string): string =>
  t
    .replaceAll(/[‘’]/gu, "'")
    .replaceAll("«", "“")
    .replaceAll("»", "”")
    .replaceAll(/[“”]/gu, '"')
    .replaceAll("(", "«")
    .replaceAll(")", "»")
    .replaceAll("、", ", ")
    .replaceAll("。", ". ")
    .replaceAll("！", "! ")
    .replaceAll("，", ", ")
    .replaceAll("：", ": ")
    .replaceAll("；", "; ")
    .replaceAll("？", "? ")
    .replaceAll(/[^\S \n]/gu, " ")
    .replace(/  +/u, " ")
    .replaceAll(/(?<=\n) +(?=\n)/gu, "")
    .replaceAll(/\bD[Rr]\.(?= [A-Z])/gu, "Doctor")
    .replaceAll(/\b(?:Mr\.|MR\.(?= [A-Z]))/gu, "Mister")
    .replaceAll(/\b(?:Ms\.|MS\.(?= [A-Z]))/gu, "Miss")
    .replaceAll(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/gu, "Mrs")
    .replaceAll(/\betc\.(?! [A-Z])/giu, "etc")
    .replaceAll(/\b(?<y>y)eah?\b/giu, "$<y>e'a")
    .replaceAll(
      /\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/gu,
      splitNum
    )
    .replaceAll(/(?<=\d),(?=\d)/gu, "")
    .replaceAll(
      /[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/giu,
      flipMoney
    )
    .replaceAll(/\d*\.\d+/gu, pointNum)
    .replaceAll(/(?<=\d)-(?=\d)/gu, " to ")
    .replaceAll(/(?<=\d)S/gu, " S")
    .replaceAll(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/gu, "'S")
    .replaceAll(/(?<=X')S\b/gu, "s")
    .replaceAll(/(?:[A-Za-z]\.){2,} [a-z]/gu, (m) => m.replaceAll(".", "-"))
    .replaceAll(/(?<=[A-Z])\.(?=[A-Z])/giu, "-")
    .trim();
