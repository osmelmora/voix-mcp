import { Schema } from "effect";

// Lowercase alias: unicorn/throw-new-error mistakes `Schema.TaggedError<T>()(…)`
// for calling an Error constructor without `new`.
export const taggedError = Schema.TaggedError;
