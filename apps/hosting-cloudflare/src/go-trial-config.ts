const VARIABLE = 'SIPGES_GO_HYPERDRIVE_ID';

type Hyperdrive = { readonly binding: string; readonly id: string };

/** JSONC: drops whole-line comments and trailing commas, which is all these files use. */
const parseJsonc = (text: string): Record<string, unknown> =>
  JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')) as Record<
    string,
    unknown
  >;

/** wrangler.go.jsonc plus the Hyperdrive of the trial, which must not be production's. */
export const renderGoConfig = (goText: string, productionText: string, id: string | undefined) => {
  if (id === undefined || !/^[0-9a-f]{32}$/.test(id))
    throw new Error(`${VARIABLE} must be a Hyperdrive id, 32 lowercase hexadecimal characters`);
  if (/^0+$/.test(id)) throw new Error(`${VARIABLE} is the all-zero placeholder`);
  const production = parseJsonc(productionText).hyperdrive as readonly Hyperdrive[];
  if (production.some((binding) => binding.id === id))
    throw new Error(`${VARIABLE} is the production Hyperdrive; the trial uses its own branch`);
  const config = { ...parseJsonc(goText), hyperdrive: [{ binding: 'HYPERDRIVE', id }] };
  return `${JSON.stringify(config, null, 2)}\n`;
};
