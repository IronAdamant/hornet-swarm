const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

/**
 * Masks an email address or a phone number in text saved from a page response.
 * A date such as 2026-10-17 is left as it is. A card number is longer than a phone number and is
 * handled with the other secret masking.
 */
export function maskPersonalData(text: string): string {
  return text.replace(EMAIL, '[REDACTED:email]').replace(/\+?\d[\d\s().-]{7,}\d/g, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) return match;
    if (/^\d{4}-\d{2}-\d{2}$/.test(match.trim())) return match;
    return '[REDACTED:phone]';
  });
}
