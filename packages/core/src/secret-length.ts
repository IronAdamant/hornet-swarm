export const MIN_SECRET_LENGTH = 8;

export const SHORT_SECRET_ERROR = 'That secret is too short. It must be at least 8 characters.';

/** Blank values are optional. Any other value shorter than 8 characters is refused. */
export function shortSecretError(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value === undefined || value.length === 0) continue;
    if (value.length < MIN_SECRET_LENGTH) return SHORT_SECRET_ERROR;
  }
  return undefined;
}
