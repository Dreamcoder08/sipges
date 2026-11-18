// Reads releases with the Node updater's readRelease and prints, as one JSON array, "OK" or the
// refusal message for each: node read-release.mjs <release.mjs> <public key PEM> <release dir>...
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import console from 'node:console';

const [releaseMjs, keyFile, ...dirs] = process.argv.slice(2);
const { loadPublicKey, readRelease } = await import(releaseMjs);
const key = loadPublicKey(await readFile(keyFile, 'utf8'));
const out = [];
for (const dir of dirs) {
  try {
    await readRelease(dir, key);
    out.push('OK');
  } catch (error) {
    out.push(error.message);
  }
}
console.log(JSON.stringify(out));
