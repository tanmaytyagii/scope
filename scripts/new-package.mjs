// one-off helper: writes package.json + tsconfigs for a workspace package
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// New packages join the lockstep version of the others.
const VERSION = JSON.parse(readFileSync('packages/core/package.json', 'utf8')).version;

const [dir, name, description, deps = '', refs = ''] = process.argv.slice(2);
mkdirSync(`${dir}/src`, { recursive: true });
const pkgPath = `${dir}/package.json`;
const existing = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : {};
const dependencies = {};
for (const d of deps.split(',').filter(Boolean)) {
  const [n, v] = d.includes('@', 1)
    ? [d.slice(0, d.lastIndexOf('@')), d.slice(d.lastIndexOf('@') + 1)]
    : [d, VERSION];
  dependencies[n] = v;
}
const pkg = {
  name,
  version: VERSION,
  description,
  license: 'Apache-2.0',
  repository: { type: 'git', url: 'git+https://github.com/tanmaytyagii/scope.git', directory: dir },
  type: 'module',
  sideEffects: false,
  exports: {
    '.': {
      'scope-source': './src/index.ts',
      types: './dist/index.d.ts',
      default: './dist/index.js',
    },
  },
  files: ['dist'],
  engines: { node: '>=22.16.0' },
  scripts: { build: 'tsc -b tsconfig.build.json' },
  ...existing,
  dependencies: { ...(existing.dependencies ?? {}), ...dependencies },
};
if (Object.keys(pkg.dependencies).length === 0) delete pkg.dependencies;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
const depth = dir.split('/').length;
const up = '../'.repeat(depth);
writeFileSync(
  `${dir}/tsconfig.json`,
  `${JSON.stringify({ extends: `${up}tsconfig.base.json`, compilerOptions: { noEmit: true, customConditions: ['scope-source'] }, include: ['src'] }, null, 2)}\n`,
);
const references = refs
  .split(',')
  .filter(Boolean)
  .map((r) => ({ path: `${up}${r}/tsconfig.build.json` }));
writeFileSync(
  `${dir}/tsconfig.build.json`,
  `${JSON.stringify({ extends: `${up}tsconfig.base.json`, compilerOptions: { composite: true, rootDir: 'src', outDir: 'dist', tsBuildInfoFile: 'dist/.tsbuildinfo' }, include: ['src'], exclude: ['src/**/*.test.ts', 'src/**/__tests__/**'], ...(references.length ? { references } : {}) }, null, 2)}\n`,
);
