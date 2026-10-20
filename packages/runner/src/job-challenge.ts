import type { Page } from 'playwright';
import type { Step } from '@hornet-swarm/core';

export function journeyFillsTotp(steps: Step[]): boolean {
  return steps.some((step) => 'fill' in step && Boolean(step.fill.totp));
}

export function classifyBlockedReason(message: string): 'allowlist' | 'proxy' | undefined {
  if (/ERR_PROXY_CONNECTION_FAILED/i.test(message) || (/proxy/i.test(message) && /\b502\b/.test(message))) return 'proxy';
  if (/allowlist|ERR_BLOCKED_BY_CLIENT|blockedbyclient|ERR_TUNNEL_CONNECTION_FAILED/i.test(message)) return 'allowlist';
  return undefined;
}

export type ChallengeFrame = { src?: string; title?: string; width: number; height: number; visible: boolean; badge?: boolean };
export type ChallengeWidget = { width: number; height: number; visible: boolean; size?: string };
export type ChallengeInput = {
  type?: string;
  name?: string;
  id?: string;
  autocomplete?: string;
  placeholder?: string;
  maxlength?: string;
  inputmode?: string;
  label?: string;
};

const CAPTCHA_PROVIDER = /recaptcha|hcaptcha|turnstile|challenges\.cloudflare\.com|arkoselabs|funcaptcha/i;
const CODE_TOKEN = /^(otp|totp|mfa|2fa|passcode|onetime)$/;
const CODE_PHRASE = /one[\s_-]?time[\s_-]?(code|pass(word|code)?)|verification[\s_-]?code|security[\s_-]?code|auth(entication|enticator)?[\s_-]?code|login[\s_-]?code|sign[\s_-]?in[\s_-]?code/;
const NOT_A_SECOND_CODE = /^(post|zip|promo|coupon|discount|referral|gift|voucher|country|area|postal)$/;
const CODE_SENT =
  /(texted|emailed|sent|messaged) you (a|an|the|your) ([\w-]+ )?code|code (was|has been) (texted|emailed|sent)|enter the (\d+[\s-]digit )?code (we|that was) (sent|texted|emailed)|we('ve| have) sent (a|an|the) ([\w-]+ )?code/;

function words(value: string): string[] {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Only a challenge a person can see stops the journey. Invisible reCAPTCHA v3, the reCAPTCHA
 * badge, and a Turnstile or hCaptcha script that never shows a widget are ignored. A second-code
 * prompt needs a one-time-code field, a field named for a code, or wording that a code was sent.
 */
export function classifyChallenge(input: {
  text: string;
  frames?: ChallengeFrame[];
  widgets?: ChallengeWidget[];
  inputs: ChallengeInput[];
}): 'captcha' | '2fa' | undefined {
  const text = input.text.toLowerCase();
  if (text.includes('verify you are human')) return 'captcha';
  const shown = (box: { width: number; height: number; visible: boolean }) => box.visible && box.width >= 100 && box.height >= 50;
  const captchaFrame = (input.frames ?? []).some(
    (frame) => shown(frame) && !frame.badge && !/size=invisible/i.test(frame.src ?? '') && CAPTCHA_PROVIDER.test(`${frame.src ?? ''} ${frame.title ?? ''}`),
  );
  const captchaWidget = (input.widgets ?? []).some((widget) => shown(widget) && widget.size !== 'invisible');
  if (captchaFrame || captchaWidget) return 'captcha';
  const isPassword = (field: ChallengeInput) => (field.type ?? '').toLowerCase() === 'password' || words(`${field.name ?? ''} ${field.id ?? ''} ${field.autocomplete ?? ''}`).includes('password');
  const other = input.inputs.filter((field) => !isPassword(field));
  const codeSent = CODE_SENT.test(text);
  const oneTime = other.some((field) => {
    if ((field.autocomplete ?? '').toLowerCase().includes('one-time-code')) return true;
    const described = `${field.name ?? ''} ${field.id ?? ''} ${field.placeholder ?? ''} ${field.label ?? ''}`;
    const tokens = words(described);
    if (tokens.some((token) => NOT_A_SECOND_CODE.test(token))) return false;
    if (tokens.some((token) => CODE_TOKEN.test(token)) || CODE_PHRASE.test(described.toLowerCase())) return true;
    return field.maxlength === '6' && tokens.includes('code');
  });
  if ((codeSent && other.length > 0) || oneTime) return '2fa';
  return undefined;
}

export async function detectChallenge(page: Page): Promise<'captcha' | '2fa' | undefined> {
  const text = await page.locator('body').innerText().catch(() => '');
  // Each callback runs inside the page. It is written out in full rather than built with
  // new Function, which a strict Content-Security-Policy would block.
  const frames = await page
    .locator('iframe')
    .evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          src: element.getAttribute('src') ?? '',
          title: element.getAttribute('title') ?? '',
          badge: Boolean(element.closest('.grecaptcha-badge')),
          width: rect.width,
          height: rect.height,
          visible:
            style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || '1') > 0 && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0,
        };
      }),
    )
    .catch(() => [] as ChallengeFrame[]);
  const widgets = await page
    .locator('.g-recaptcha, .h-captcha, .cf-turnstile, #FunCaptcha, [data-hcaptcha-widget-id]')
    .evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          size: element.getAttribute('data-size') ?? '',
          width: rect.width,
          height: rect.height,
          visible:
            style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || '1') > 0 && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0,
        };
      }),
    )
    .catch(() => [] as ChallengeWidget[]);
  const inputs = await page
    .locator('input:visible')
    .evaluateAll((elements) =>
      elements.map((element) => ({
        type: element.getAttribute('type') ?? '',
        name: element.getAttribute('name') ?? '',
        id: element.getAttribute('id') ?? '',
        autocomplete: element.getAttribute('autocomplete') ?? '',
        placeholder: element.getAttribute('placeholder') ?? '',
        maxlength: element.getAttribute('maxlength') ?? '',
        inputmode: element.getAttribute('inputmode') ?? '',
        label: element.getAttribute('aria-label') ?? (element as HTMLInputElement).labels?.[0]?.textContent ?? '',
      })),
    )
    .catch(() => [] as ChallengeInput[]);
  return classifyChallenge({ text, frames, widgets, inputs });
}
