import { randomInt } from 'node:crypto';

const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function fromLetters(length) {
  let body = '';
  for (let index = 0; index < length; index += 1) body += letters[randomInt(letters.length)];
  return body;
}

/** Toolshop's sign-up rules ask for a symbol. The symbol is sent in a JSON body, not a URL. */
export function strongPassword() {
  return `${fromLetters(16)}#${randomInt(10)}a`;
}

/**
 * ParaBank's update-profile page puts this value in a URL. A `#` starts a fragment and never
 * reaches the bank, so the account's password is saved shorter than the one in the login store
 * and the next sign-in fails. Stay alphanumeric.
 */
export function bankPassword() {
  return fromLetters(20);
}
