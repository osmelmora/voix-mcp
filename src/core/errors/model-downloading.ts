import { Schema } from "effect";

import { taggedError } from "./tagged-error.ts";

export class ModelDownloading extends taggedError<ModelDownloading>()(
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
