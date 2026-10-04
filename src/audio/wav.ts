/** Encode mono float PCM as a 16-bit PCM WAV file. */
export function encodeWav(pcm: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) {
      // WAV chunk identifiers are ASCII bytes, not Unicode code points.
      // oxlint-disable-next-line unicorn/prefer-code-point
      view.setUint8(offset + i, s.charCodeAt(i));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.length; i += 1) {
    // The loop bounds guarantee this sample exists.
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const s = Math.max(-1, Math.min(1, pcm[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x80_00 : s * 0x7f_ff, true);
  }
  return new Uint8Array(buffer);
}

export function concatPcm(chunks: readonly Float32Array[]): Float32Array {
  if (chunks.length === 1) {
    // The length check guarantees the single chunk exists.
    // oxlint-disable-next-line typescript/no-non-null-assertion
    return chunks[0]!;
  }
  let total = 0;
  for (const c of chunks) {
    total += c.length;
  }
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export const durationSeconds = (
  pcm: Float32Array,
  sampleRate: number
): number => pcm.length / sampleRate;
