import { taggedError } from "./tagged-error.ts";

export class EmptyText extends taggedError<EmptyText>()("EmptyText", {}) {
  override readonly message =
    "Nothing to speak: the text is empty after normalization.";
}
