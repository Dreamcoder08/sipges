import type { Locator } from '@playwright/test';

/**
 * Pieces of words split across two lines. Like support/text-fit.ts brokenWords, but a line may
 * end after a hyphen: «A-OBJ-» / «m1794…» in a long detail is a normal break, «Fec» / «ha» is not.
 */
export const splitPieces = (locator: Locator) =>
  locator.evaluate((root) => {
    const broken: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const piece of (node.textContent ?? '').matchAll(/[^\s-]+/g)) {
        const range = document.createRange();
        range.setStart(node, piece.index);
        range.setEnd(node, piece.index + piece[0].length);
        const lines = new Set(
          [...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)),
        );
        if (lines.size > 1) broken.push(piece[0]);
      }
    }
    return broken;
  });
