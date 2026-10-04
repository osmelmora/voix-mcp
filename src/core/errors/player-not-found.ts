import { Schema } from "effect";

import { taggedError } from "./tagged-error.ts";

export class PlayerNotFound extends taggedError<PlayerNotFound>()(
  "PlayerNotFound",
  {
    platform: Schema.String,
  }
) {
  override get message() {
    return `No audio player available on ${this.platform}.`;
  }
}
