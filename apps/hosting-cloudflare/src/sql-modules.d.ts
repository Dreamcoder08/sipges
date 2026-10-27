// Wrangler bundles *.sql as Text modules (see "rules" in wrangler.jsonc).
declare module '*.sql' {
  const text: string;
  export default text;
}
