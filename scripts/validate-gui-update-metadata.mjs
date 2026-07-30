import { readFile } from 'node:fs/promises';
import path from 'node:path';

const [tag, metadataPath, artifactPath, ...flags] = process.argv.slice(2);
if (!tag || !metadataPath || !artifactPath) {
  throw new Error(
    'Usage: validate-gui-update-metadata <vTag> <metadata.yml> <artifact> [--allow-package-mismatch]',
  );
}

const allowPackageMismatch = flags.includes('--allow-package-mismatch');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const tagVersion = tag.replace(/^v/, '');
if (!allowPackageMismatch && tagVersion !== packageJson.version) {
  throw new Error(`Release tag ${tag} does not match package version ${packageJson.version}.`);
}
if (allowPackageMismatch && tagVersion !== packageJson.version) {
  process.stdout.write(
    `Note: tag ${tag} differs from package.json ${packageJson.version} (rebuild-for-existing-release mode).\n`,
  );
}

const metadata = await readFile(metadataPath, 'utf8');
const artifactName = path.basename(artifactPath);
const escapedName = artifactName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
if (!new RegExp(`(?:url|path):\\s*['"]?${escapedName}['"]?`).test(metadata)) {
  throw new Error(`${path.basename(metadataPath)} does not reference ${artifactName}.`);
}
const sha512Values = [...metadata.matchAll(/sha512:\s*['"]?([A-Za-z0-9+/=]+)['"]?/g)]
  .map(match => match[1]);
if (sha512Values.length === 0 || sha512Values.some(value => value.length < 80)) {
  throw new Error(`${path.basename(metadataPath)} is missing a valid SHA-512 digest.`);
}

process.stdout.write(
  `Validated ${path.basename(metadataPath)} for ${artifactName} at ${tag}.\n`,
);
