const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Load the production Zustand store without the native application bootstrap.
const filename = path.resolve(__dirname, '../../src/stores/chat-draft-store.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
}).outputText;
const loaded = { exports: {} };
vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`, { filename })(require, loaded, loaded.exports);
module.exports = loaded.exports;
