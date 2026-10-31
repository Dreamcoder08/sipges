import { strFromU8, unzipSync } from 'fflate';
import type { DocumentReader, DocxContent } from '../application/index.ts';
import { createPdfWorkerPool } from './pdf-worker-pool.ts';
import { extractPdfText } from './pdf-text.ts';

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

const readDocx: DocumentReader['readDocx'] = async (bytes) => {
  const files = unzipSync(bytes, {
    filter: (file) => file.name === DOCUMENT_PART && file.originalSize <= MAX_DOCUMENT_XML_BYTES,
  });
  const part = files[DOCUMENT_PART];
  if (!part) throw new Error('Missing or oversized document part');
  return docxContent(strFromU8(part));
};

/**
 * PDF parsing blocks for hundreds of ms on large files, so it runs off the event loop (T12).
 * The pool starts with the first PDF, so importing this module never spawns threads.
 */
let pdfWorkers: ReturnType<typeof createPdfWorkerPool> | undefined;

/** PDF text via pdf.js (unpdf) in worker threads and DOCX text via fflate; no filesystem. */
export const documentReader: DocumentReader = {
  readPdf: (bytes, maxPages) => (pdfWorkers ??= createPdfWorkerPool()).read(bytes, maxPages),
  readDocx,
};

/**
 * The same reader parsing PDFs on the calling thread, for runtimes without worker threads
 * (Cloudflare Workers), where the per-request CPU limit bounds a hostile PDF instead.
 */
export const inlineDocumentReader: DocumentReader = {
  readPdf: (bytes, maxPages) => extractPdfText(bytes, maxPages),
  readDocx,
};
