// build the package in the current working directory

process.env.NODE_ENV = 'production';

const {createHash} = require('crypto');
const readFileSync = require('fs').readFileSync;
const unlinkSync = require('fs').unlinkSync;
const writeFileSync = require('fs').writeFileSync;
const resolve = require('path').resolve;
const dirname = require('path').dirname;
const relative = require('path').relative;
const {lsrSync} = require('lsr');
const babel = require('babel-core');
const {sync: spawnSync} = require('cross-spawn');
const mkdirp = require('mkdirp').sync;

const cwd = process.cwd();
const rootPkg = require('../package.json');
const pkg = require(cwd + '/package.json');

// .last_build
const buildHash = createHash('sha512');
const IGNORED_NAMES = ['.cache', 'lib', 'node_modules', '.last_build'];
lsrSync(cwd, {
  filter(entry) {
    return !IGNORED_NAMES.includes(entry.name);
  },
}).forEach(entry => {
  if (entry.isFile()) {
    buildHash.update(readFileSync(entry.fullPath));
  }
});
Object.keys(pkg.dependencies || {})
  .concat(Object.keys(pkg.devDependencies || {}))
  .sort()
  .filter(
    name =>
      !(rootPkg.dependencies || {})[name] &&
      !(rootPkg.devDependencies || {})[name],
  )
  .forEach(name => {
    buildHash.update(
      readFileSync(
        __dirname + '/../packages/' + name.split('/').pop() + '/.last_build',
      ),
    );
  });

const buildHashDigest = buildHash.digest('hex');
if (!process.argv.includes('--force')) {
  try {
    const lastBuild = readFileSync(cwd + '/.last_build', 'utf8');
    if (lastBuild.trim() === buildHashDigest) {
      process.exit(0);
    }
  } catch (ex) {
    if (ex.code !== 'ENOENT') {
      throw ex;
    }
  }
}

console.log('building ' + pkg.name);

lsrSync(cwd, {
  filter(entry) {
    return !IGNORED_NAMES.includes(entry.name);
  },
}).forEach(entry => {
  if (!entry.isFile()) return;
  if (/\@autogenerated\b/.test(readFileSync(entry.fullPath, 'utf8'))) {
    unlinkSync(entry.fullPath);
  }
});

// tsc -p tsconfig.build.json
const result = spawnSync(
  require.resolve('.bin/tsc'),
  ['-p', 'tsconfig.build.json'],
  {
    stdio: 'inherit',
  },
);
if (result.status !== 0) {
  console.error('Failed to build ' + cwd.split('/').pop());
  process.exit(1);
}

lsrSync(cwd + '/lib').forEach(entry => {
  if (entry.isFile() && /\.jsx?$/.test(entry.path)) {
    const isPublic = /\@public\b/.test(readFileSync(entry.fullPath, 'utf8'));
    writeFileSync(
      entry.fullPath.replace(/\.jsx$/, '.js'),
      babel.transformFileSync(entry.fullPath, {
        babelrc: false,
        presets: [
          pkg['@databases/target'] === 'browser'
            ? require.resolve('@moped/babel-preset/browser')
            : require.resolve('@moped/babel-preset/server'),
        ],
      }).code,
    );
    if (/\.jsx$/.test(entry.fullPath)) {
      unlinkSync(entry.fullPath);
    }
    if (isPublic) {
      const definition = readFileSync(
        entry.fullPath.replace(/\.jsx?$/, '.d.ts'),
        'utf8',
      );
      const publicFilename = resolve(
        cwd + '/' + entry.path.substr(2).replace(/\.jsx$/, '.js'),
      );
      const dir = dirname(publicFilename);
      mkdirp(dir);
      let requirePath = relative(dirname(publicFilename), entry.fullPath)
        .replace(/\.jsx?$/, '')
        .replace(/\\/g, '/');
      if (requirePath[0] !== '.') {
        requirePath = './' + requirePath;
      }
      writeFileSync(
        publicFilename,
        "// @autogenerated\n\nmodule.exports = require('" + requirePath + "');",
      );
      const hasDefaultExport = /export default/.test(definition);
      const hasNamedExport = /export (?:[^d]|d[^e]|de[^f]|def[^a]|defa[^u]|defau[^l]|defaul[^t]|default[^ ])/.test(
        definition,
      );

      writeFileSync(
        publicFilename.replace(/\.jsx?$/, '.d.ts'),
        `// @autogenerated\n\n${
          hasDefaultExport ? `import def from '${requirePath}';\n\n` : ''
        }${hasDefaultExport ? `export default def;\n` : ''}${
          hasNamedExport ? `export * from '${requirePath}';\n` : ''
        }`,
      );
    }
  }
});
writeFileSync(cwd + '/.last_build', buildHashDigest);
