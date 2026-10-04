import { Context, type Effect, type Option, type Stream } from "effect"
import type { ChecksumMismatch, DownloadFailed, InvalidVoice, SynthFailed } from "../core/errors.ts"

export interface Voice {
  readonly id: string
  readonly name: string
  readonly language: string
  readonly gender: "female" | "male"
}

export interface AudioChunk {
  readonly pcm: Float32Array
  readonly sampleRate: number
  readonly text: string
}

export interface SynthRequest {
  readonly text: string
  readonly voice: string
  readonly speed: number
}

export interface DownloadProgress {
  readonly received: number
  readonly total: number
}

export interface ProviderStatus {
  readonly installed: boolean
  readonly loaded: boolean
  readonly downloading: Option.Option<DownloadProgress>
  readonly modelPath: string
}

export type SynthError = SynthFailed | InvalidVoice | DownloadFailed | ChecksumMismatch

export interface ProviderShape {
  readonly id: string
  readonly voices: ReadonlyArray<Voice>
  readonly defaultVoice: string
  /** Download, verify and load the model. Idempotent and memoized; safe to call eagerly. */
  readonly prepare: Effect.Effect<void, DownloadFailed | ChecksumMismatch | SynthFailed>
  readonly status: Effect.Effect<ProviderStatus>
  /**
   * Synthesize one piece of text (the core hands over one sentence at a time).
   * Yields at least one chunk; may yield several when the engine has to split further.
   * Calls `prepare` itself if needed.
   */
  readonly synthesize: (request: SynthRequest) => Stream.Stream<AudioChunk, SynthError>
}

export class Provider extends Context.Service<Provider, ProviderShape>()("voix/Provider") {}
