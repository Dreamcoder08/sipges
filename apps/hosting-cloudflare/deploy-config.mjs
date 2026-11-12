// Writes wrangler.deploy.jsonc: wrangler.jsonc plus the values of whoever deploys it, so no
// account value is committed (docs/deployment/own-instance.md). The deploy job runs it with
// --check first, before installing or building, so a missing variable stops the job early.
//   SIPGES_PUBLIC_HOST     the Worker's public host, e.g. sipges.<subdomain>.workers.dev
//   SIPGES_HYPERDRIVE_ID   the id of the Hyperdrive configuration pointing at the owner's Neon
// Usage: node deploy-config.mjs [--check] [--out <file>]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PUBLIC_HOST = 'SIPGES_PUBLIC_HOST';
export const HYPERDRIVE_ID = 'SIPGES_HYPERDRIVE_ID';

const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const HYPERDRIVE = /^[0-9a-f]{32}$/;

/** JSONC: drops whole-line comments and trailing commas, which is all these files use. */
export const parseJsonc = (text) =>
  JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));

/** The value of a required variable. Values are never echoed: only the name is reported. */
const required = (env, name, pattern, shape) => {
  const value = env[name];
  if (!value?.trim())
    throw new Error(`Missing GitHub Actions variable ${name}: see docs/deployment/own-instance.md`);
  // The smoke test URL and `wrangler hyperdrive update` use the raw value, so it is not trimmed.
  if (value !== value.trim())
    throw new Error(`${name} must not have leading or trailing whitespace`);
  if (!pattern.test(value)) throw new Error(`${name} must be ${shape}`);
  if (name === HYPERDRIVE_ID && /^0+$/.test(value))
    throw new Error(`${name} is the all-zero placeholder of wrangler.jsonc, not a Hyperdrive id`);
  return value;
};

export const readDeployValues = (env) => ({
  host: required(env, PUBLIC_HOST, HOST, 'a bare host name, such as sipges.example.workers.dev'),
  hyperdriveId: required(env, HYPERDRIVE_ID, HYPERDRIVE, '32 lowercase hexadecimal characters'),
});

/** wrangler.jsonc with the owner's Hyperdrive id and public host in place of the local defaults. */
export const renderDeployConfig = (text, { host, hyperdriveId }) => {
  const config = parseJsonc(text);
  return {
    ...config,
    hyperdrive: config.hyperdrive.map((binding) => ({ ...binding, id: hyperdriveId })),
    vars: { ...config.vars, SIPGES_ALLOWED_HOSTS: host },
  };
};

/** `--out <file>` and, where the command has it, `--check`; anything else is a usage error. */
export const parseArgs = (args, usage, { check = false } = {}) => {
  const fail = () => {
    throw new Error(usage);
  };
  let out;
  let checkOnly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && out === undefined) {
      out = args[++i];
      if (!out || out.startsWith('--')) fail();
    } else if (check && args[i] === '--check') checkOnly = true;
    else fail();
  }
  return { out, check: checkOnly };
};

const USAGE = 'Usage: node deploy-config.mjs [--check] [--out <file>]';

const main = (args) => {
  const local = (name) => new URL(name, import.meta.url);
  const options = parseArgs(args, USAGE, { check: true });
  const values = readDeployValues(process.env);
  if (options.check) return;
  const out = options.out ?? local('wrangler.deploy.jsonc');
  const config = renderDeployConfig(readFileSync(local('wrangler.jsonc'), 'utf8'), values);
  writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
  console.log('Wrote wrangler.deploy.jsonc');
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
