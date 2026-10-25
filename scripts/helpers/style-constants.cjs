/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Use the production style constants in strict UI harnesses; only native platform selection is simulated.
module.exports = Object.fromEntries(['typography', 'theme'].map((name) => {
  const filename = path.resolve(__dirname, '../../src/constants', `${name}.ts`);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename })((id) => {
    assert.equal(id, 'react-native');
    return { Platform: { OS: 'android', select: (options) => options.android ?? options.default } };
  }, module, module.exports);
  return [`@/constants/${name}`, module.exports];
}));
