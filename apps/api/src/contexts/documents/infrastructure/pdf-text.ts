import { getDocumentProxy } from 'unpdf';
import type { PdfText } from '../application/index.ts';

/** Page texts via pdf.js (unpdf); refuses before reading any page beyond `maxPages`. */
export const extractPdfText = async (bytes: Uint8Array, maxPages: number): Promise<PdfText> => {
  // pdf.js transfers the buffer it is given, so it gets its own copy.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    if (pdf.numPages > maxPages) return { kind: 'too_many_pages' };
    const pages: string[] = [];
    for (let n = 1; n <= pdf.numPages; n += 1) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
          .join(''),
      );
      page.cleanup();
    }
    return { kind: 'pages', pages };
  } finally {
    await pdf.loadingTask.destroy();
  }
};
