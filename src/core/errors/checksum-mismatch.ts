import { Schema } from "effect";

import { taggedError } from "./tagged-error.ts";

export class ChecksumMismatch extends taggedError<ChecksumMismatch>()(
  "ChecksumMismatch",
  {
    actual: Schema.String,
    expected: Schema.String,
    path: Schema.String,
  }
) {
  override get message() {
    return `Downloaded file ${this.path} failed verification (expected ${this.expected}, got ${this.actual}).`;
  }
}
