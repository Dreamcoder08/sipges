import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { ReportDocument } from '@mascli/kernel';
import type { ReportRenderer } from '../application/index.ts';

const HEADINGS = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
} as const;

/** Line breaks inside a block become Word breaks, as python-docx does for `\n`. */
const runs = (text: string, bold = false) =>
  text.split('\n').map((line, i) => new TextRun({ text: line, bold, break: i > 0 ? 1 : 0 }));

const cell = (text: string, bold = false) =>
  new TableCell({ children: [new Paragraph({ children: runs(text, bold) })] });

const toChildren = (report: ReportDocument) =>
  report.blocks.map((block) => {
    switch (block.kind) {
      case 'title':
        return new Paragraph({ children: runs(block.text), heading: HeadingLevel.TITLE });
      case 'heading':
        return new Paragraph({ children: runs(block.text), heading: HEADINGS[block.level] });
      case 'paragraph':
        return new Paragraph({ children: runs(block.text) });
      case 'bullet':
        return new Paragraph({ children: runs(block.text), bullet: { level: 0 } });
      case 'table':
        return new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({ tableHeader: true, children: block.header.map((h) => cell(h, true)) }),
            ...block.rows.map((row) => new TableRow({ children: row.map((v) => cell(v)) })),
          ],
        });
    }
  });

/** Office Open XML (DOCX) renderer built on the `docx` package; runs fully in memory. */
export const docxRenderer: ReportRenderer = {
  contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  async render(report) {
    const document = new Document({
      creator: 'MASCLI',
      sections: [{ children: toChildren(report) }],
    });
    return new Uint8Array(await Packer.toBuffer(document));
  },
};
