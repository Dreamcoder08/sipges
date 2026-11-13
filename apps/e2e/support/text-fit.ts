import type { Locator } from '@playwright/test';

/**
 * Words under `locator` that the layout split across two lines («Corroborad / a», an id cut in
 * half). Each word of the rendered text is measured with a DOM Range: one word, one line.
 */
export const brokenWords = (locator: Locator) =>
  locator.evaluate((root) => {
    const broken: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const word of (node.textContent ?? '').matchAll(/\S+/g)) {
        const range = document.createRange();
        range.setStart(node, word.index);
        range.setEnd(node, word.index + word[0].length);
        const lines = new Set(
          [...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)),
        );
        if (lines.size > 1) broken.push(word[0]);
      }
    }
    return broken;
  });
