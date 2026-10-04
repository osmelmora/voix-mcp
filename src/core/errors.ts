import { Schema } from "effect";

import { ChecksumMismatch } from "./errors/checksum-mismatch.ts";
import { DownloadFailed } from "./errors/download-failed.ts";
import { EmptyText } from "./errors/empty-text.ts";
import { InvalidSpeed } from "./errors/invalid-speed.ts";
import { InvalidVoice } from "./errors/invalid-voice.ts";
import { ModelDownloading } from "./errors/model-downloading.ts";
import { PlaybackFailed } from "./errors/playback-failed.ts";
import { PlayerNotFound } from "./errors/player-not-found.ts";
import { SynthFailed } from "./errors/synth-failed.ts";
import { TextTooLong } from "./errors/text-too-long.ts";

export const VoixErrorSchema = Schema.Union([
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
export type VoixError = typeof VoixErrorSchema.Type;

export type PrepareError = DownloadFailed | ChecksumMismatch | SynthFailed;

export const isVoixError = (u: unknown): u is VoixError =>
  Schema.is(VoixErrorSchema)(u);
