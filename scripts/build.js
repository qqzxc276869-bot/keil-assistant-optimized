const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const outputRoot = path.join(root, 'dist');

function compileDirectory(directory) {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
        const relative = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            compileDirectory(relative);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
            const input = path.join(root, relative);
            const output = path.join(outputRoot, relative.replace(/\.ts$/, '.js'));
            const result = ts.transpileModule(fs.readFileSync(input, 'utf8'), {
                fileName: input,
                reportDiagnostics: true,
                compilerOptions: {
                    module: ts.ModuleKind.CommonJS,
                    target: ts.ScriptTarget.ES2017
                }
            });
            const errors = (result.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
            if (errors.length > 0) {
                throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
                    getCanonicalFileName: (name) => name,
                    getCurrentDirectory: () => root,
                    getNewLine: () => '\n'
                }));
            }
            fs.mkdirSync(path.dirname(output), { recursive: true });
            fs.writeFileSync(output, result.outputText);
            console.log(path.relative(root, output));
        }
    }
}

compileDirectory('lib');
compileDirectory('src');
