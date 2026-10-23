const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const extensionRoot = process.env.KEIL_ASSISTANT_EXTENSION_ROOT || path.resolve(__dirname, '..');

const scratchParent = path.resolve(__dirname, '..');
const testRoot = fs.mkdtempSync(path.join(scratchParent, '.keil-assistant-smoke-'));
const projectDir = path.join(testRoot, 'Projects', 'Board', 'MDK-ARM');
const projectPath = path.join(projectDir, 'Project.uvprojx');
fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(projectPath, `<?xml version="1.0" encoding="UTF-8"?>
<Project><SchemaVersion>2.1</SchemaVersion><Targets><Target>
<TargetName>Target 1</TargetName>
<TargetOption><TargetCommonOption><OutputDirectory>Objects</OutputDirectory></TargetCommonOption>
<TargetArmAds><Cads><VariousControls><IncludePath>../../../../Drivers/Include</IncludePath>
<Define>USE_HAL_DRIVER,STM32F103xE</Define></VariousControls></Cads></TargetArmAds></TargetOption>
<Groups><Group><GroupName>Application</GroupName><Files><File>
<FileName>main.c</FileName><FilePath>../../../../Core/Src/main.c</FilePath>
</File></Files></Group></Groups></Target></Targets></Project>`);

const commands = new Map();
const state = new Map();
const events = [];
let provider;
let latestTask;
let latestTerminalOptions;
let dialogSelection;
const folder = { name: 'outer', uri: { fsPath: testRoot } };
const vscode = {
    Uri: { file: (filePath) => ({ scheme: 'file', fsPath: filePath }) },
    EventEmitter: class {
        constructor() { this.event = () => ({ dispose() {} }); }
        fire() {}
    },
    commands: {
        registerCommand: (name, callback) => { commands.set(name, callback); return { dispose() {} }; },
        executeCommand: (name) => { events.push(`command:${name}`); }
    },
    workspace: {
        workspaceFolders: [folder],
        getWorkspaceFolder: (uri) => uri.fsPath.startsWith(testRoot + path.sep) ? folder : undefined,
        findFiles: async () => [{ fsPath: projectPath }],
        getConfiguration: () => ({ get: (name) => {
            if (name === 'MDK.Uv4Path') { return process.execPath; }
            if (name === 'Project.ExcludeList' || name === 'Project.FileLocationList') { return []; }
            return undefined;
        } }),
        saveAll: async () => { events.push('save'); return true; }
    },
    window: {
        registerTreeDataProvider: (_name, treeProvider) => { provider = treeProvider; return { dispose() {} }; },
        showOpenDialog: async () => dialogSelection ? [dialogSelection] : undefined,
        showQuickPick: async () => { throw new Error('One nested project must load without a chooser'); },
        showInputBox: async () => 'Board & IO',
        showErrorMessage: (message) => { events.push(`error:${message}`); },
        showWarningMessage: (message, ...options) => {
            events.push(`warning:${message}`);
            return options.find((option) => typeof option === 'string' && /remove/i.test(option));
        },
        showInformationMessage: (message) => { events.push(`info:${message}`); },
        terminals: [],
        createTerminal: (options) => {
            latestTerminalOptions = options;
            const terminal = { name: options.name, show() {}, sendText() {}, hide() {}, dispose() {} };
            vscode.window.terminals.push(terminal);
            return terminal;
        }
    },
    env: { shell: 'powershell.exe', clipboard: { writeText() {} } },
    Task: class {
        constructor(_definition, _scope, name) { this.name = name; }
    },
    TaskScope: { Global: 1 },
    ProcessExecution: class {
        constructor(executable, args, options) { this.executable = executable; this.args = args; this.options = options; }
    },
    tasks: {
        executeTask: async (task) => { events.push('task'); latestTask = task; }
    }
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
};

async function main() {
    const extension = require(path.join(extensionRoot, 'dist', 'src', 'extension'));
    const context = {
        extensionPath: extensionRoot,
        subscriptions: [],
        workspaceState: {
            get: (key, fallback) => state.has(key) ? state.get(key) : fallback,
            update: async (key, value) => { state.set(key, value); }
        }
    };
    extension.activate(context);
    for (let i = 0; i < 100 && provider.getChildren().length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const projects = provider.getChildren();
    assert.strictEqual(projects.length, 1, 'nested project should load');
    assert.strictEqual(projects[0].uvprjFile.path, projectPath);
    const uncPath = '\\\\server\\share\\include\\board.h';
    assert.strictEqual(projects[0].toAbsolutePath(uncPath), path.normalize(uncPath),
        'UNC include paths must remain absolute');
    assert.ok(!events.some((value) => value === 'command:vscode.openFolder'), 'workspace should stay open');
    assert.deepStrictEqual(state.get('KeilAssistant.SelectedProjects'), [projectPath]);

    const cppPath = path.join(testRoot, '.vscode', 'c_cpp_properties.json');
    assert.ok(fs.existsSync(cppPath), 'IntelliSense config should be at workspace root');
    const cpp = JSON.parse(fs.readFileSync(cppPath, 'utf8'));
    assert.ok(cpp.configurations[0].defines.includes('STM32F103xE'));

    await commands.get('project.build')();
    assert.ok(events.indexOf('save') < events.indexOf('task'), 'save should precede build');
    assert.strictEqual(latestTask.execution.options.cwd, projectDir);
    assert.strictEqual(latestTask.execution.args[latestTask.execution.args.indexOf('--prjPath') + 1], projectPath);

    const newSourcePath = path.join(testRoot, 'Core', 'Src', 'new.c');
    fs.mkdirSync(path.dirname(newSourcePath), { recursive: true });
    fs.writeFileSync(newSourcePath, 'void new_function(void) {}\n');
    await commands.get('project.addFile')(vscode.Uri.file(newSourcePath));
    assert.ok(fs.readFileSync(projectPath, 'utf8').includes('<FileName>new.c</FileName>'), 'saved C file should be added to .uvprojx');
    const target = provider.getChildren(projects[0])[0];
    const group = provider.getChildren(target).find((item) => item.label === 'Application');
    assert.ok(group, 'Application group should remain visible');
    assert.ok(provider.getChildren(group).some((item) => item.label === 'new.c'), 'Keil tree should refresh with the new file');

    await commands.get('project.createGroup')(target);
    const targetWithGroup = provider.getChildren(projects[0])[0];
    const createdGroup = provider.getChildren(targetWithGroup).find((item) => item.label === 'Board & IO');
    assert.ok(createdGroup, 'created Keil group should appear after reload');
    assert.deepStrictEqual(provider.getChildren(createdGroup), [], 'new Keil group should be empty');
    assert.ok(fs.readFileSync(projectPath, 'utf8').includes('<GroupName>Board &amp; IO</GroupName>'));

    const groupedHeaderPath = path.join(testRoot, 'Core', 'Inc', 'board.h');
    fs.mkdirSync(path.dirname(groupedHeaderPath), { recursive: true });
    fs.writeFileSync(groupedHeaderPath, '#pragma once\n');
    dialogSelection = vscode.Uri.file(groupedHeaderPath);
    await commands.get('project.addFileToGroup')(createdGroup);
    const groupAfterAdd = provider.getChildren(provider.getChildren(projects[0])[0])
        .find((item) => item.label === 'Board & IO');
    assert.ok(provider.getChildren(groupAfterAdd).some((item) => item.label === 'board.h'),
        'adding a header from the Keil group should refresh the tree');

    const application = provider.getChildren(targetWithGroup).find((item) => item.label === 'Application');
    const newSource = provider.getChildren(application).find((item) => item.label === 'new.c');
    assert.ok(newSource, 'source to remove should be visible in the Keil tree');
    await commands.get('project.removeFile')(newSource);
    const targetAfterRemoval = provider.getChildren(projects[0])[0];
    const applicationAfterRemoval = provider.getChildren(targetAfterRemoval).find((item) => item.label === 'Application');
    assert.ok(!provider.getChildren(applicationAfterRemoval).some((item) => item.label === 'new.c'),
        'removed Keil reference should disappear after reload');
    assert.ok(fs.existsSync(newSourcePath), 'removing a Keil reference must not delete the source file');
    assert.ok(!fs.readFileSync(projectPath, 'utf8').includes('<FileName>new.c</FileName>'),
        'removed source should be absent from .uvprojx');

    const oldTarget = provider.getChildren(projects[0])[0];
    const originalRead = projects[0].uvprjFile.Read;
    projects[0].uvprjFile.Read = () => '<Project><Targets>';
    try {
        await assert.rejects(() => projects[0].reload(),
            'an incomplete Keil save should fail without clearing the loaded target');
    } finally {
        projects[0].uvprjFile.Read = originalRead;
    }
    assert.strictEqual(provider.getChildren(projects[0])[0], oldTarget,
        'reload failure must preserve the previously loaded project tree');
    await projects[0].reload();

    async function waitForGroup(groupName) {
        for (let attempt = 0; attempt < 50; attempt++) {
            const currentTarget = provider.getChildren(projects[0])[0];
            if (provider.getChildren(currentTarget).some((item) => item.label === groupName)) { return; }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`The project watcher missed an atomic save adding ${groupName}`);
    }
    function atomicGroupSave(groupName) {
        const current = fs.readFileSync(projectPath, 'utf8');
        const updated = current.replace('</Groups>', `<Group><GroupName>${groupName}</GroupName></Group></Groups>`);
        const temporary = `${projectPath}.tmp`;
        fs.writeFileSync(temporary, updated);
        fs.renameSync(temporary, projectPath);
    }
    atomicGroupSave('Watched One');
    await waitForGroup('Watched One');
    atomicGroupSave('Watched Two');
    await waitForGroup('Watched Two');

    await commands.get('project.close')(projects[0]);
    projects[0].close();
    latestTask = undefined;
    await commands.get('project.build')();
    assert.strictEqual(latestTask, undefined, 'F7 should not build a closed project');

    const secondPath = path.join(testRoot, 'Second.uvprojx');
    const secondXml = fs.readFileSync(projectPath, 'utf8')
        .replace(/<VariousControls>[\s\S]*?<\/VariousControls>/, '')
        .replace(/<Groups>[\s\S]*?<\/Groups>/, '');
    fs.writeFileSync(secondPath, secondXml);
    dialogSelection = vscode.Uri.file(secondPath);
    await commands.get('explorer.open')();
    const secondProject = provider.getChildren()[0];
    assert.strictEqual(secondProject.uvprjFile.path, secondPath,
        'projects with omitted controls and groups should still load');
    assert.deepStrictEqual(provider.getChildren(provider.getChildren(secondProject)[0]), [],
        'a Keil target with no Groups element should show an empty group list');
    await commands.get('project.createGroup')(provider.getChildren(secondProject)[0]);
    assert.ok(provider.getChildren(provider.getChildren(secondProject)[0]).some((item) => item.label === 'Board & IO'),
        'new group creation should work when the Groups element was absent');
    const updatedCpp = JSON.parse(fs.readFileSync(cppPath, 'utf8'));
    const configNames = updatedCpp.configurations.map((item) => item.name);
    assert.ok(configNames.includes('Projects/Board/MDK-ARM/Project.uvprojx: Target 1'));
    assert.ok(configNames.includes('Second.uvprojx: Target 1'));
    assert.strictEqual(new Set(configNames).size, configNames.length,
        'same-named targets in separate projects need separate IntelliSense configurations');

    vscode.workspace.workspaceFolders = [];
    await commands.get('project.build')();
    assert.strictEqual(latestTerminalOptions.cwd, path.dirname(secondPath),
        'without a VS Code workspace the Keil terminal must start in the project directory');
    const targetsBeforeClose = secondProject.getTargets();
    const pendingReload = secondProject.reload();
    await commands.get('project.close')(secondProject);
    await pendingReload;
    assert.strictEqual(secondProject.getTargets(), targetsBeforeClose,
        'an in-progress reload must not attach new targets after the project is closed');

    const c51Path = path.join(testRoot, 'Legacy.uvproj');
    fs.writeFileSync(c51Path, '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Project><Targets><Target><TargetName>C51 Target</TargetName>' +
        '<TargetOption><Target51><C51/></Target51></TargetOption></Target></Targets></Project>');
    dialogSelection = vscode.Uri.file(c51Path);
    await commands.get('explorer.open')();
    const c51Project = provider.getChildren()[0];
    assert.strictEqual(c51Project.uvprjFile.path, c51Path,
        'C51 projects with omitted controls and groups should still load');
    await commands.get('project.createGroup')(provider.getChildren(c51Project)[0]);
    assert.ok(provider.getChildren(provider.getChildren(c51Project)[0]).some((item) => item.label === 'Board & IO'));
    await commands.get('project.close')(c51Project);
    c51Project.close();
    console.log('Smoke test passed: discovery, build cwd, IntelliSense isolation, partial save, atomic watcher, project editing, close/F7.');
    await require('./test_project_edit').run(extensionRoot);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
    Module._load = originalLoad;
    const resolvedTestRoot = path.resolve(testRoot);
    if (path.dirname(resolvedTestRoot) === scratchParent &&
        path.basename(resolvedTestRoot).startsWith('.keil-assistant-smoke-')) {
        fs.rmSync(testRoot, { recursive: true, force: true });
    }
});
