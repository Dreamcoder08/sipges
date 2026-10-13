import { strFromU8, unzipSync } from 'fflate';
import { getDocumentProxy } from 'unpdf';
import type { DocumentReader, DocxContent } from '../application/index.ts';

const DOCUMENT_PART = 'word/document.xml';
/** Upper bound for the uncompressed body part; a larger one is treated as a zip bomb. */
const MAX_DOCUMENT_XML_BYTES = 32 * 1024 * 1024;

type XmlNode = { readonly name: string; readonly children: (XmlNode | string)[] };

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, ref: string) => {
    if (ref.startsWith('#x')) return String.fromCodePoint(Number.parseInt(ref.slice(2), 16));
    if (ref.startsWith('#')) return String.fromCodePoint(Number.parseInt(ref.slice(1), 10));
    return ENTITIES[ref] ?? whole;
  });

/**
 * Minimal non-validating XML tree builder for WordprocessingML: elements and text only.
 * Comments, processing instructions and CDATA-free markup are all Word emits here.
 */
const parseXml = (xml: string): XmlNode => {
  const root: XmlNode = { name: '#root', children: [] };
  const stack: XmlNode[] = [root];
  const token = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>|([^<]+)/g;
  for (const match of xml.matchAll(token)) {
    const [, closing, name, selfClosing, text] = match;
    const parent = stack.at(-1);
    if (!parent) throw new Error('Malformed XML');
    if (text !== undefined) {
      parent.children.push(decodeEntities(text));
    } else if (name !== undefined) {
      if (closing) {
        if (parent.name !== name) throw new Error('Malformed XML');
        stack.pop();
      } else {
        const node: XmlNode = { name, children: [] };
        parent.children.push(node);
        if (!selfClosing) stack.push(node);
      }
    }
  }
  if (stack.length !== 1) throw new Error('Malformed XML');
  return root;
};

const elements = (node: XmlNode, name: string) =>
  node.children.filter((c): c is XmlNode => typeof c !== 'string' && c.name === name);

/** Properties and floating content (text boxes, drawings) are not paragraph text in python-docx. */
const SKIPPED_IN_PARAGRAPH = new Set([
  'w:pPr',
  'w:rPr',
  'w:drawing',
  'w:pict',
  'w:object',
  'mc:AlternateContent',
]);

/** python-docx `Paragraph.text`: run text, tabs as `\t`, breaks as `\n`. */
const paragraphText = (node: XmlNode): string => {
  let out = '';
  const walk = (n: XmlNode) => {
    for (const child of n.children) {
      if (typeof child === 'string') continue;
      if (child.name === 'w:t') out += child.children.filter((c) => typeof c === 'string').join('');
      else if (child.name === 'w:tab') out += '\t';
      else if (child.name === 'w:br' || child.name === 'w:cr') out += '\n';
      else if (!SKIPPED_IN_PARAGRAPH.has(child.name)) walk(child);
    }
  };
  walk(node);
  return out;
};

const docxContent = (xml: string): DocxContent => {
  const body = elements(parseXml(xml), 'w:document').flatMap((d) => elements(d, 'w:body'))[0];
  if (!body) throw new Error('Missing document body');
  return {
    paragraphs: elements(body, 'w:p').map(paragraphText),
    tables: elements(body, 'w:tbl').map((tbl) =>
      elements(tbl, 'w:tr').map((tr) =>
        elements(tr, 'w:tc').map((tc) => elements(tc, 'w:p').map(paragraphText).join('\n')),
      ),
    ),
  };
};

/** PDF text via pdf.js (unpdf) and DOCX text via fflate; nothing touches the filesystem. */
export const documentReader: DocumentReader = {
  async readPdf(bytes, maxPages) {
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
  },

  async readDocx(bytes) {
    const files = unzipSync(bytes, {
      filter: (file) => file.name === DOCUMENT_PART && file.originalSize <= MAX_DOCUMENT_XML_BYTES,
    });
    const part = files[DOCUMENT_PART];
    if (!part) throw new Error('Missing or oversized document part');
    return docxContent(strFromU8(part));
  },
};
