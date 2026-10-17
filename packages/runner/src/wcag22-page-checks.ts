import type { Page } from 'playwright';
import type { Wcag22PageSignals } from '@hornet-swarm/core';

/** How many focusable elements one page check gives focus to. A long page is sampled from the top. */
export const FOCUS_CHECK_LIMIT = 60;
const LIST_LIMIT = 20;

/**
 * The WCAG 2.2 checks axe-core does not make, run on the page as it stands. Every check reads the
 * page. The focus check moves focus from element to element, the way a keyboard user would, then
 * puts focus and the scroll position back. Nothing is clicked or typed.
 */
export async function checkWcag22Page(page: Page, exclude: string[]): Promise<Wcag22PageSignals> {
  return page.evaluate(
    async ({ exclude, focusLimit, listLimit }) => {
      const excluded = (element: Element) => exclude.some((selector) => {
        try {
          return element.closest(selector) !== null;
        } catch {
          return false;
        }
      });
      const visible = (element: Element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0;
      };
      const selectorOf = (element: Element): string => {
        if (element.id && !/\d{3,}/.test(element.id)) return `#${CSS.escape(element.id)}`;
        for (const attribute of ['data-test', 'data-testid', 'data-cy', 'data-qa', 'name']) {
          const value = element.getAttribute(attribute);
          if (value) return `${element.tagName.toLowerCase()}[${attribute}="${value}"]`;
        }
        const parts: string[] = [];
        let current: Element | null = element;
        while (current && current !== document.body && parts.length < 3) {
          const tag: string = current.tagName.toLowerCase();
          const siblings: Element[] = current.parentElement ? [...current.parentElement.children].filter((sibling) => sibling.tagName === current?.tagName) : [];
          parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(current) + 1})` : tag);
          current = current.parentElement;
        }
        return parts.join(' > ');
      };
      const labelOf = (element: Element) => (element.getAttribute('aria-label') || (element as HTMLElement).innerText || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 60);

      // 2.4.11: give each focusable element focus, and see whether anything else covers all of it.
      const saved = { x: scrollX, y: scrollY, active: document.activeElement as HTMLElement | null };
      const focusable = [...document.querySelectorAll<HTMLElement>('a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]')]
        .filter((element) => !(element as HTMLButtonElement).disabled && visible(element) && !excluded(element))
        .slice(0, focusLimit);
      const hidden: { target: string; covered_by: string }[] = [];
      let checked = 0;
      for (const element of focusable) {
        element.focus();
        if (document.activeElement !== element) continue;
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
        const box = element.getBoundingClientRect();
        const left = Math.max(box.left, 0);
        const top = Math.max(box.top, 0);
        const right = Math.min(box.right, innerWidth);
        const bottom = Math.min(box.bottom, innerHeight);
        if (right - left < 1 || bottom - top < 1) continue;
        checked += 1;
        const inset = (low: number, high: number) => Math.min(low + 2, (low + high) / 2);
        const points: [number, number][] = [
          [(left + right) / 2, (top + bottom) / 2],
          [inset(left, right), inset(top, bottom)],
          [right - (inset(left, right) - left), inset(top, bottom)],
          [inset(left, right), bottom - (inset(top, bottom) - top)],
          [right - (inset(left, right) - left), bottom - (inset(top, bottom) - top)],
        ];
        const covers = points.map(([x, y]) => {
          const hit = document.elementFromPoint(x, y);
          if (!hit || hit === element || element.contains(hit) || hit.contains(element)) return undefined;
          return hit;
        });
        if (covers.every((cover) => cover !== undefined)) {
          let cover = covers[0] as Element;
          for (let parent: Element | null = cover; parent && parent !== document.body; parent = parent.parentElement) {
            const position = getComputedStyle(parent).position;
            if (position === 'fixed' || position === 'sticky') {
              cover = parent;
              break;
            }
          }
          if (hidden.length < listLimit) hidden.push({ target: selectorOf(element), covered_by: selectorOf(cover) });
        }
      }
      scrollTo(saved.x, saved.y);
      if (saved.active && saved.active !== document.body && typeof saved.active.focus === 'function') saved.active.focus({ preventScroll: true });
      else (document.activeElement as HTMLElement | null)?.blur?.();

      // 2.5.7: things moved by dragging. Whether each has a single-pointer alternative needs a person.
      const dragClass = /(^|[\s_-])(draggable|drag-handle|sortable|ui-slider|noUi-target|swiper|slick-slider|splide)([\s_-]|$)/i;
      const dragging: { target: string; reason: string }[] = [];
      for (const element of document.querySelectorAll('[draggable="true"], [role="slider"], [class]')) {
        if (dragging.length >= listLimit || excluded(element) || !visible(element)) continue;
        if (element.getAttribute('draggable') === 'true') dragging.push({ target: selectorOf(element), reason: 'draggable="true"' });
        else if (element.getAttribute('role') === 'slider' && element.tagName !== 'INPUT') dragging.push({ target: selectorOf(element), reason: 'a custom slider' });
        else if (typeof element.className === 'string' && dragClass.test(element.className)) dragging.push({ target: selectorOf(element), reason: `class "${element.className.trim().slice(0, 60)}"` });
      }

      // 3.2.6: help mechanisms in page order, the first of each kind.
      const help: { kind: 'contact' | 'help' | 'faq' | 'phone' | 'email' | 'chat'; label: string }[] = [];
      const seen = new Set<string>();
      const helpKind = (element: Element): (typeof help)[number]['kind'] | undefined => {
        const href = (element.getAttribute('href') ?? '').toLowerCase();
        const words = `${labelOf(element)} ${element.getAttribute('title') ?? ''}`.toLowerCase();
        if (href.startsWith('tel:')) return 'phone';
        if (href.startsWith('mailto:')) return 'email';
        if (/\bfaqs?\b|frequently asked/.test(words) || /\/faqs?\b/.test(href)) return 'faq';
        if (/\bcontact\b/.test(words) || /\/contact/.test(href)) return 'contact';
        if (/\b(help|support)\b/.test(words) || /\/(help|support)\b/.test(href)) return 'help';
        if (/\b(live )?chat\b/.test(words)) return 'chat';
        if (element.matches('iframe[title*="chat" i], [id*="chat-widget" i], [class*="intercom" i], [class*="livechat" i]')) return 'chat';
        return undefined;
      };
      for (const element of document.querySelectorAll('a, button, iframe, [id*="chat-widget" i], [class*="intercom" i], [class*="livechat" i]')) {
        if (excluded(element) || !visible(element)) continue;
        const kind = helpKind(element);
        if (!kind || seen.has(kind)) continue;
        seen.add(kind);
        help.push({ kind, label: labelOf(element) || kind });
      }

      // 3.3.8: password fields that a password manager or pasting cannot fill, and puzzles at sign-in.
      const passwords = [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')].filter((element) => visible(element) && !excluded(element));
      const pasteBlocked: string[] = [];
      const autocompleteOff: string[] = [];
      for (const field of passwords) {
        const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
        field.dispatchEvent(paste);
        if (paste.defaultPrevented) pasteBlocked.push(selectorOf(field));
        const autocomplete = (field.getAttribute('autocomplete') ?? field.form?.getAttribute('autocomplete') ?? '').toLowerCase();
        if (autocomplete === 'off') autocompleteOff.push(selectorOf(field));
      }
      const puzzle = [...document.querySelectorAll('iframe[src*="captcha" i], iframe[src*="turnstile" i], .g-recaptcha, .h-captcha, .cf-turnstile, [class*="captcha" i]')].some((element) => visible(element));

      return {
        focus_not_obscured: { checked, hidden },
        dragging,
        help,
        authentication: { password_fields: passwords.length, paste_blocked: pasteBlocked.slice(0, listLimit), autocomplete_off: autocompleteOff.slice(0, listLimit), puzzle },
      };
    },
    { exclude, focusLimit: FOCUS_CHECK_LIMIT, listLimit: LIST_LIMIT },
  );
}
