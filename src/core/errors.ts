import { Schema } from "effect";

export class EmptyText extends Schema.TaggedError<EmptyText>()(
  "EmptyText",
  {}
) {
  override get message() {
    return "Nothing to speak: the text is empty after normalization.";
  }
}

export class TextTooLong extends Schema.TaggedError<TextTooLong>()(
  "TextTooLong",
  {
    length: Schema.Number,
    max: Schema.Number,
  }
) {
  override get message() {
    return `Text is ${this.length} characters; the limit is ${this.max}.`;
  }
}

export class InvalidVoice extends Schema.TaggedError<InvalidVoice>()(
  "InvalidVoice",
  {
    voice: Schema.String,
    available: Schema.Array(Schema.String),
  }
) {
  override get message() {
    return `Unknown voice "${this.voice}". Available: ${this.available.join(", ")}.`;
  }
}

export class InvalidSpeed extends Schema.TaggedError<InvalidSpeed>()(
  "InvalidSpeed",
  {
    speed: Schema.Number,
    min: Schema.Number,
    max: Schema.Number,
  }
) {
  override get message() {
    return `Speed ${this.speed} is out of range; use ${this.min} to ${this.max}.`;
  }
}

export class ModelDownloading extends Schema.TaggedError<ModelDownloading>()(
  "ModelDownloading",
  {
    received: Schema.Number,
    total: Schema.Number,
  }
) {
  override get message() {
    const pct =
      this.total > 0 ? Math.floor((this.received / this.total) * 100) : 0;
    return `The speech model is still downloading (${pct}%). Tell the user and try again shortly.`;
  }
}

export class DownloadFailed extends Schema.TaggedError<DownloadFailed>()(
  "DownloadFailed",
  {
    url: Schema.String,
    reason: Schema.String,
  }
) {
  override get message() {
    return `Could not download ${this.url}: ${this.reason}`;
  }
}

export class ChecksumMismatch extends Schema.TaggedError<ChecksumMismatch>()(
  "ChecksumMismatch",
  {
    path: Schema.String,
    expected: Schema.String,
    actual: Schema.String,
  }
) {
  override get message() {
    return `Downloaded file ${this.path} failed verification (expected ${this.expected}, got ${this.actual}).`;
  }
}

export class PlayerNotFound extends Schema.TaggedError<PlayerNotFound>()(
  "PlayerNotFound",
  {
    platform: Schema.String,
  }
) {
  override get message() {
    return `No audio player available on ${this.platform}.`;
  }
}

export class PlaybackFailed extends Schema.TaggedError<PlaybackFailed>()(
  "PlaybackFailed",
  {
    reason: Schema.String,
  }
) {
  override get message() {
    return `Audio playback failed: ${this.reason}`;
  }
}

export class SynthFailed extends Schema.TaggedError<SynthFailed>()(
  "SynthFailed",
  {
    reason: Schema.String,
  }
) {
  override get message() {
    return `Speech synthesis failed: ${this.reason}`;
  }
}

export const VoixError = Schema.Union([
  EmptyText,
  TextTooLong,
  InvalidVoice,
  InvalidSpeed,
  ModelDownloading,
  DownloadFailed,
  ChecksumMismatch,
  PlayerNotFound,
  PlaybackFailed,
  SynthFailed,
]);
export type VoixError = typeof VoixError.Type;

export type PrepareError = DownloadFailed | ChecksumMismatch | SynthFailed;

export const isVoixError = (u: unknown): u is VoixError =>
  Schema.is(VoixError)(u);
