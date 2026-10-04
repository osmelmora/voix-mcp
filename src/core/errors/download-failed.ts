import { Schema } from "effect";

import { taggedError } from "./tagged-error.ts";

export class DownloadFailed extends taggedError<DownloadFailed>()(
  "DownloadFailed",
  {
    reason: Schema.String,
    url: Schema.String,
  }
) {
  override get message() {
    return `Could not download ${this.url}: ${this.reason}`;
  }
}
