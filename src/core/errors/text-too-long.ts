import { Schema } from "effect";

import { taggedError } from "./tagged-error.ts";

export class TextTooLong extends taggedError<TextTooLong>()("TextTooLong", {
  length: Schema.Number,
  max: Schema.Number,
}) {
  override get message() {
    return `Text is ${this.length} characters; the limit is ${this.max}.`;
  }
}
