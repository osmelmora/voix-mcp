import { Schema } from "effect";

import { taggedError } from "./tagged-error.ts";

export class InvalidSpeed extends taggedError<InvalidSpeed>()("InvalidSpeed", {
  max: Schema.Number,
  min: Schema.Number,
  speed: Schema.Number,
}) {
  override get message() {
    return `Speed ${this.speed} is out of range; use ${this.min} to ${this.max}.`;
  }
}
