// pdf-text.ts of the TypeScript API: one read, driven from Rust by __start, __step and __output.
let result = null;
let running = true;
const read = async (buffer, maxPages) => {
  const pdf = await __pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    useWasm: false,
    verbosity: 0,
  }).promise;
  try {
    if (pdf.numPages > maxPages) return { kind: 'too_many_pages' };
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n += 1) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      pages.push(
        content.items.map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : '')).join(''),
      );
      page.cleanup();
    }
    return { kind: 'pages', pages };
  } finally {
    await pdf.loadingTask.destroy();
  }
};
globalThis.__start = (buffer, maxPages) => {
  read(buffer, maxPages).then(
    (value) => { result = value; running = false; },
    () => { result = { kind: 'unreadable' }; running = false; },
  );
};
globalThis.__step = () => {
  if (!running) return 0;
  const timer = __nextTimer();
  if (timer === null) return -1;
  timer();
  return 1;
};
globalThis.__output = () => JSON.stringify(result);
