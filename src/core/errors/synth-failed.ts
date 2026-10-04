import { Schema } from "effect";

import { taggedError } from "./tagged-error.ts";

export class SynthFailed extends taggedError<SynthFailed>()("SynthFailed", {
  reason: Schema.String,
}) {
  override get message() {
    return `Speech synthesis failed: ${this.reason}`;
  }
}
