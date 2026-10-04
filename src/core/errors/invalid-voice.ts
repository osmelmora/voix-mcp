import { Schema } from "effect";

import { taggedError } from "./tagged-error.ts";

export class InvalidVoice extends taggedError<InvalidVoice>()("InvalidVoice", {
  available: Schema.Array(Schema.String),
  voice: Schema.String,
}) {
  override get message() {
    return `Unknown voice "${this.voice}". Available: ${this.available.join(", ")}.`;
  }
}
