const path = require('path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'tsconfig.json');
const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
if (loaded.error) {
    throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
}

const config = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root);
const program = ts.createProgram(config.fileNames, Object.assign({}, config.options, {
    noEmit: true,
    skipLibCheck: true,
    useUnknownInCatchVariables: false
}));
const diagnostics = config.errors.concat(ts.getPreEmitDiagnostics(program));
if (diagnostics.length > 0) {
    console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: () => root,
        getNewLine: () => '\n'
    }));
    process.exitCode = 1;
} else {
    console.log('TypeScript check passed.');
}
