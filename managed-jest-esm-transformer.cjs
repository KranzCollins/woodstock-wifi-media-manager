// Jest 29 cannot load selected ESM dependencies through Node's require(esm).
// Convert their module syntax with the already-installed TypeScript compiler.
// The real dependency code and sanitizer still execute; no behavior is mocked.
const ts = require('typescript');

module.exports = {
  process(sourceText, sourcePath) {
    const result = ts.transpileModule(sourceText, {
      fileName: sourcePath,
      compilerOptions: {
        allowJs: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        sourceMap: true,
      },
    });
    return { code: result.outputText, map: result.sourceMapText };
  },
};
