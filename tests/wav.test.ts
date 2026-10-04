import { expect, test } from "bun:test"
import { concatPcm, encodeWav } from "../src/audio/wav.ts"

test("encodeWav writes a valid 16-bit mono header", () => {
  const pcm = new Float32Array([0, 0.5, -0.5, 1, -1])
  const wav = encodeWav(pcm, 24_000)
  const view = new DataView(wav.buffer)
  expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF")
  expect(new TextDecoder().decode(wav.slice(8, 12))).toBe("WAVE")
  expect(view.getUint16(22, true)).toBe(1)
  expect(view.getUint32(24, true)).toBe(24_000)
  expect(view.getUint16(34, true)).toBe(16)
  expect(view.getUint32(40, true)).toBe(pcm.length * 2)
  expect(view.getInt16(44 + 6, true)).toBe(0x7fff)
  expect(view.getInt16(44 + 8, true)).toBe(-0x8000)
})

test("concatPcm joins chunks in order", () => {
  const out = concatPcm([new Float32Array([1, 2]), new Float32Array([3])])
  expect(Array.from(out)).toEqual([1, 2, 3])
})
