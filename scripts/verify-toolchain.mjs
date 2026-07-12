import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeOnly = process.argv.includes('--runtime-only');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function fail(message) {
  console.error(`toolchain mismatch: ${message}`);
  process.exit(1);
}

function expectEqual(label, actual, expected) {
  if (actual !== expected) fail(`${label}: expected ${expected}, got ${actual ?? '(missing)'}`);
}

function npmVersion() {
  const npmExecPath = process.env.npm_execpath;
  const output = npmExecPath
    ? execFileSync(process.execPath, [npmExecPath, '--version'], { encoding: 'utf8' })
    : execFileSync('npm', ['--version'], { encoding: 'utf8' });
  return output.trim();
}

const pkg = readJson('package.json');
const kernelPkg = readJson('packages/kernel/package.json');
const lock = readJson('package-lock.json');
const expectedNode = fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim().replace(/^v/, '');
const packageManager = /^npm@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager ?? '');
if (!packageManager) fail('packageManager must be an exact npm@x.y.z version');
const expectedNpm = packageManager[1];
const expectedTypeScript = pkg.devDependencies?.typescript;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expectedTypeScript ?? '')) {
  fail('devDependencies.typescript must be an exact version');
}
const expectedNodeTypes = pkg.devDependencies?.['@types/node'];
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expectedNodeTypes ?? '')) {
  fail('devDependencies.@types/node must be an exact version');
}
expectEqual('@types/node major', expectedNodeTypes.split('.')[0], expectedNode.split('.')[0]);

const lockedTypeScriptPackages = [];
for (const [location, metadata] of Object.entries(lock.packages ?? {})) {
  const lockedSpec = metadata.devDependencies?.typescript;
  if ((location === '' || !location.includes('node_modules/')) && lockedSpec !== undefined) {
    expectEqual(`lockfile ${location || 'root'} TypeScript spec`, lockedSpec, expectedTypeScript);
  }
  const isProjectTypeScript = location === 'node_modules/typescript'
    || (!location.startsWith('node_modules/') && location.endsWith('/node_modules/typescript'));
  if (isProjectTypeScript) {
    expectEqual(`lockfile ${location} version`, metadata.version, expectedTypeScript);
    lockedTypeScriptPackages.push(location);
  }
}

// devEngines.runtime.version is an "exact || ^x.y.z" alternative list. The FIRST
// alternative is the canonical pin (.nvmrc, CI, release, Docker, @types/node major);
// later alternatives are tolerated local dev runtimes.
function satisfiesRuntimeAlternative(version, alternative) {
  const caret = alternative.startsWith('^');
  const base = caret ? alternative.slice(1) : alternative;
  if (!/^\d+\.\d+\.\d+$/.test(base)) fail(`unsupported devEngines runtime alternative: ${alternative}`);
  if (!caret) return version === base;
  const [major, minor, patch] = base.split('.').map(Number);
  const [vMajor, vMinor, vPatch] = version.split('.').map(Number);
  return vMajor === major && (vMinor > minor || (vMinor === minor && vPatch >= patch));
}

const runtimeAlternatives = (pkg.devEngines?.runtime?.version ?? '')
  .split('||').map((alternative) => alternative.trim()).filter(Boolean);
expectEqual('devEngines.runtime.name', pkg.devEngines?.runtime?.name, 'node');
expectEqual('devEngines.runtime canonical pin', runtimeAlternatives[0], expectedNode);
expectEqual('devEngines.packageManager.name', pkg.devEngines?.packageManager?.name, 'npm');
expectEqual('devEngines.packageManager.version', pkg.devEngines?.packageManager?.version, expectedNpm);
expectEqual('kernel TypeScript spec', kernelPkg.devDependencies?.typescript, expectedTypeScript);
expectEqual('lockfile root @types/node spec', lock.packages?.['']?.devDependencies?.['@types/node'], expectedNodeTypes);
expectEqual('lockfile @types/node version', lock.packages?.['node_modules/@types/node']?.version, expectedNodeTypes);

const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const dockerNode = /^ARG NODE_VERSION=(\d+\.\d+\.\d+)-bookworm-slim$/m.exec(dockerfile)?.[1];
const dockerNpm = /^ARG NPM_VERSION=(\d+\.\d+\.\d+)$/m.exec(dockerfile)?.[1];
expectEqual('Docker Node.js', dockerNode, expectedNode);
expectEqual('Docker npm', dockerNpm, expectedNpm);
if (!runtimeAlternatives.some((alternative) => satisfiesRuntimeAlternative(process.versions.node, alternative))) {
  fail(`Node.js: expected ${runtimeAlternatives.join(' || ')}, got ${process.versions.node}`);
}
expectEqual('npm', npmVersion(), expectedNpm);

if (!runtimeOnly) {
  for (const location of lockedTypeScriptPackages) {
    const installedTypeScript = readJson(`${location}/package.json`).version;
    expectEqual(`installed ${location}`, installedTypeScript, expectedTypeScript);
  }
  const kernelTypeScriptManifest = path.join(root, 'packages/kernel/node_modules/typescript/package.json');
  if (fs.existsSync(kernelTypeScriptManifest)) {
    expectEqual('installed kernel TypeScript', JSON.parse(fs.readFileSync(kernelTypeScriptManifest, 'utf8')).version, expectedTypeScript);
  }
  expectEqual('installed @types/node', readJson('node_modules/@types/node/package.json').version, expectedNodeTypes);
  console.log(`toolchain ok: node ${process.versions.node} (canonical ${expectedNode}), npm ${expectedNpm}, typescript ${expectedTypeScript}, @types/node ${expectedNodeTypes}`);
} else {
  console.log(`runtime toolchain ok: node ${process.versions.node} (canonical ${expectedNode}), npm ${expectedNpm}`);
}
