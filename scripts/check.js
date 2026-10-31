const path = require('path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const manifest = require(path.join(root, 'package.json'));
const activationEvents = new Set(manifest.activationEvents);
const missingCommandEvents = manifest.contributes.commands
    .map((command) => `onCommand:${command.command}`)
    .filter((event) => !activationEvents.has(event));
if (missingCommandEvents.length > 0) {
    throw new Error(`Missing activation events for VS Code: ${missingCommandEvents.join(', ')}`);
}
const untranslatedCommands = manifest.contributes.commands
    .filter((command) => !/[\u3400-\u9fff]/.test(command.title))
    .map((command) => command.command);
if (untranslatedCommands.length > 0) {
    throw new Error(`Command titles need Chinese labels: ${untranslatedCommands.join(', ')}`);
}
const untranslatedSettings = (manifest.contributes.configuration || [])
    .reduce((list, section) => list.concat(Object.entries(section.properties || {})), [])
    .filter(([, setting]) => !/[\u3400-\u9fff]/.test(setting.markdownDescription || ''))
    .map(([name]) => name);
if (untranslatedSettings.length > 0) {
    throw new Error(`Setting descriptions need Chinese labels: ${untranslatedSettings.join(', ')}`);
}
if (!(manifest.contributes.menus['view/title'] || []).some((item) =>
    item.command === 'project.forgetAutoAddFolder' && item.when === 'view == project' && item.group !== 'navigation')) {
    throw new Error('The folder mapping command must appear in the Keil project view overflow menu.');
}
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
