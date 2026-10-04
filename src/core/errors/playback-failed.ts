import { Schema } from "effect";

import { taggedError } from "./tagged-error.ts";

export class PlaybackFailed extends taggedError<PlaybackFailed>()(
  "PlaybackFailed",
  {
    reason: Schema.String,
  }
) {
  override get message() {
    return `Audio playback failed: ${this.reason}`;
  }
}
