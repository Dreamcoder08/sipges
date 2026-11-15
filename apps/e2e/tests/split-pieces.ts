import type { Locator, Page } from '@playwright/test';

/**
 * Pieces of words split across two lines. Like support/text-fit.ts brokenWords, but a line may
 * end after a hyphen: «A-OBJ-» / «m1794…» in a long detail is a normal break, «Fec» / «ha» is not.
 * A piece wider than the box it sits in (a long unspaced name on a phone) cannot keep to one line,
 * so breaking it is the right outcome and is not reported.
 */
export const splitPieces = (locator: Locator) =>
  locator.evaluate((root) => {
    const broken: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      let box = node.parentElement;
      while (box && getComputedStyle(box).display.startsWith('inline')) box = box.parentElement;
      const style = box ? getComputedStyle(box) : null;
      const room = box
        ? box.clientWidth -
          parseFloat(style?.paddingLeft ?? '0') -
          parseFloat(style?.paddingRight ?? '0')
        : Infinity;
      for (const piece of (node.textContent ?? '').matchAll(/[^\s-]+/g)) {
        const range = document.createRange();
        range.setStart(node, piece.index);
        range.setEnd(node, piece.index + piece[0].length);
        const rects = [...range.getClientRects()].filter((r) => r.width > 0);
        const lines = new Set(rects.map((r) => Math.round(r.top)));
        const width = rects.reduce((sum, r) => sum + r.width, 0);
        if (lines.size > 1 && width <= room) broken.push(piece[0]);
      }
    }
    return broken;
  });

/**
 * Glyphs wider than this machine's fonts, as CI's are: rc13 layouts that fitted locally ran 2 to
 * 15 px past a 360 px phone on the CI runners. Set through the CSSOM, which the CSP allows (an
 * injected <style> would not be).
 */
export const widerGlyphs = (page: Page) =>
  page.evaluate(() => {
    document.documentElement.style.letterSpacing = '0.06em';
  });
