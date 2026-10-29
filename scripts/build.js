const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const outputRoot = path.resolve(root, 'dist');

// Only remove the fixed generated output directory in this repository.
if (path.dirname(outputRoot) !== root || path.basename(outputRoot) !== 'dist') {
    throw new Error(`Refusing to clean unexpected build output: ${outputRoot}`);
}
if (fs.existsSync(outputRoot)) {
    const realRoot = fs.realpathSync(root);
    const realOutput = fs.realpathSync(outputRoot);
    if (realOutput !== path.join(realRoot, 'dist') || fs.lstatSync(outputRoot).isSymbolicLink()) {
        throw new Error(`Refusing to clean output outside the repository: ${outputRoot}`);
    }
    fs.rmSync(outputRoot, { recursive: true, force: true });
}

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
                    target: ts.ScriptTarget.ES2017,
                    sourceMap: true
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
            if (result.sourceMapText) {
                fs.writeFileSync(`${output}.map`, result.sourceMapText);
            }
            console.log(path.relative(root, output));
        }
    }
}

compileDirectory('lib');
compileDirectory('src');
