/** Bounded on both sides: the site under test writes the body, and an unbounded domain part backtracks quadratically. */
const EMAIL = /(?<![\w.%+-])[A-Z0-9._%+-]{1,64}@(?:[A-Z0-9-]{1,63}\.){1,8}[A-Z]{2,24}(?![\w-])/gi;
/** Separators stay on one line, and a dot is never one, so decimals, addresses, and coordinates are not phones. */
const PHONE = /(?<![\w.+])\+?\d[\d ()-]{6,18}\d(?![\w.])/g;
const DATE_START = /^\d{4}-\d{2}-\d{2}/;

/**
 * Masks an email address or a phone number in text saved from a page response.
 * A phone has a leading +, a separator, or a national leading 0, so a bare id, a price, or a
 * timestamp in JSON is left as it is. A date such as 2026-10-17 is left as it is. A card number
 * is longer than a phone number and is handled with the other secret masking.
 */
export function maskPersonalData(text: string): string {
  return text.replace(EMAIL, '[REDACTED:email]').replace(PHONE, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) return match;
    if (DATE_START.test(match)) return match;
    const shaped = match.startsWith('+') || /[ ()-]/.test(match) || /^0\d{8,10}$/.test(match);
    return shaped ? '[REDACTED:phone]' : match;
  });
}
