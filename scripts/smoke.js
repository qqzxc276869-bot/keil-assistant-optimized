const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const EventEmitter = require('events');
const childProcess = require('child_process');
const originalSpawn = childProcess.spawn;
const extensionRoot = process.env.KEIL_ASSISTANT_EXTENSION_ROOT || path.resolve(__dirname, '..');

const scratchParent = path.resolve(__dirname, '..');
const testRoot = fs.mkdtempSync(path.join(scratchParent, '.keil-assistant-smoke-'));
const projectDir = path.join(testRoot, 'Projects', 'Board', 'MDK-ARM');
const projectPath = path.join(projectDir, 'Project.uvprojx');
fs.mkdirSync(projectDir, { recursive: true });
const existingStartupPath = path.join(projectDir, 'startup_stm32f103xe.s');
fs.writeFileSync(existingStartupPath, '; existing startup assembly\n');
fs.writeFileSync(projectPath, `<?xml version="1.0" encoding="UTF-8"?>
<Project><SchemaVersion>2.1</SchemaVersion><Targets><Target>
<TargetName>Target 1</TargetName>
<TargetOption><TargetCommonOption><OutputDirectory>Objects</OutputDirectory></TargetCommonOption>
<TargetArmAds><Cads><VariousControls><IncludePath marker="keep">../../../../Drivers/Include</IncludePath>
<Define marker="keep">USE_HAL_DRIVER,STM32F103xE</Define></VariousControls></Cads></TargetArmAds></TargetOption>
<Groups><Group><GroupName>Application</GroupName><Files><File>
<FileName>main.c</FileName><FilePath>../../../../Core/Src/main.c</FilePath>
</File><File><FileName>startup_stm32f103xe.s</FileName><FileType>2</FileType>
<FilePath>startup_stm32f103xe.s</FilePath></File></Files></Group></Groups></Target></Targets></Project>`);

const commands = new Map();
const state = new Map();
const events = [];
let provider;
let latestTask;
let latestProcess;
let dialogSelection;
let dialogSelections;
let lastOpenDialogOptions;
let quickPickSelection;
let taskStartError;
const taskEndListeners = new Set();
const outputLines = [];
childProcess.spawn = (executable, args, options) => {
    const handle = new EventEmitter();
    handle.stdout = new EventEmitter();
    handle.stderr = new EventEmitter();
    latestProcess = { executable, args, options, handle };
    events.push('process');
    return handle;
};
const finishTask = (task = latestTask) => {
    for (const listener of Array.from(taskEndListeners)) { listener({ execution: { task } }); }
};
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
        showOpenDialog: async (options) => {
            lastOpenDialogOptions = options;
            return dialogSelections || (dialogSelection ? [dialogSelection] : undefined);
        },
        showQuickPick: async (items) => {
            events.push('quickPick');
            return quickPickSelection ? items.find(quickPickSelection) : items[0];
        },
        showInputBox: async () => 'Board & IO',
        showErrorMessage: (message) => { events.push(`error:${message}`); },
        showWarningMessage: (message, ...options) => {
            events.push(`warning:${message}`);
            return options.find((option) => typeof option === 'string' && /remove/i.test(option));
        },
        showInformationMessage: (message) => { events.push(`info:${message}`); },
        createOutputChannel: () => ({
            append: (text) => outputLines.push(text),
            appendLine: (text) => outputLines.push(`${text}\n`),
            show() {}
        }),
        terminals: [],
        createTerminal: (options) => {
            const terminal = { name: options.name, show() {}, sendText() {}, hide() {}, dispose() {} };
            vscode.window.terminals.push(terminal);
            return terminal;
        }
    },
    env: { shell: 'powershell.exe', clipboard: { writeText() {} } },
    Task: class {
        constructor(definition, _scope, name) { this.definition = definition; this.name = name; }
    },
    TaskScope: { Global: 1 },
    ProcessExecution: class {
        constructor(executable, args, options) { this.executable = executable; this.args = args; this.options = options; }
    },
    tasks: {
        onDidEndTask: (listener) => {
            taskEndListeners.add(listener);
            return { dispose: () => taskEndListeners.delete(listener) };
        },
        executeTask: async (task) => {
            events.push('task');
            latestTask = task;
            if (taskStartError) {
                const error = taskStartError;
                taskStartError = undefined;
                throw error;
            }
            return { task };
        }
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

    const referenceTarget = projects[0].getTargets()[0];
    const referenceSource = referenceTarget.getFileGroups()[0].sources[0];
    const depPath = path.join(projectDir, 'Objects', 'main.d');
    fs.mkdirSync(path.dirname(depPath), { recursive: true });
    fs.writeFileSync(depPath, 'main.o:\n1: ../Inc/one.h\n');
    const originalReadFile = fs.readFileSync;
    let dependencyReads = 0;
    fs.readFileSync = (...args) => {
        if (path.resolve(args[0]) === depPath) { dependencyReads++; }
        return originalReadFile(...args);
    };
    try {
        referenceTarget.updateSourceRefs(false);
        assert.ok(referenceSource.children.some((source) => source.label === 'one.h'));
        referenceTarget.updateSourceRefs(false);
        assert.strictEqual(dependencyReads, 1, 'unchanged dependency files should not be read again');
        fs.writeFileSync(depPath, 'main.o:\n1: ../Inc/two-long.h\n');
        referenceTarget.updateSourceRefs(false);
        assert.ok(referenceSource.children.some((source) => source.label === 'two-long.h'));
        assert.strictEqual(dependencyReads, 2, 'changed dependency files should refresh');
        fs.unlinkSync(depPath);
        referenceTarget.updateSourceRefs(false);
        assert.strictEqual(referenceSource.children, undefined, 'removed dependency files should clear stale references');
    } finally {
        fs.readFileSync = originalReadFile;
    }

    await commands.get('project.build')();
    assert.ok(events.indexOf('save') < events.indexOf('task'), 'save should precede build');
    assert.strictEqual(latestTask.execution.options.cwd, projectDir);
    assert.strictEqual(latestTask.execution.args[latestTask.execution.args.indexOf('--prjPath') + 1], projectPath);
    const firstBuild = latestTask;
    const taskCount = () => events.filter((value) => value === 'task').length;
    const firstTaskCount = taskCount();
    await commands.get('project.rebuild')();
    await commands.get('project.download')();
    assert.strictEqual(taskCount(), firstTaskCount, 'rebuild and download must wait while a build owns the shared log');
    assert.ok(events.some((value) => value.startsWith('warning:Keil build is still running')));
    await projects[0].reload();
    await commands.get('project.build')(projects[0]);
    assert.strictEqual(taskCount(), firstTaskCount, 'a project reload must not release a still-running task lock');
    finishTask(firstBuild);
    assert.strictEqual(taskEndListeners.size, 0, 'task end listener should be disposed');
    await commands.get('project.build')(projects[0]);
    assert.strictEqual(taskCount(), firstTaskCount + 1, 'project tree build should use its active target after task end');
    finishTask();
    taskStartError = new Error('test task start failure');
    await commands.get('project.build')();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(events.some((value) => value.includes('failed to start: test task start failure')));
    assert.strictEqual(taskEndListeners.size, 0, 'failed start should dispose its task listener');
    const countAfterFailure = taskCount();
    await commands.get('project.build')();
    assert.strictEqual(taskCount(), countAfterFailure + 1, 'failed task start should release the shared log lock');
    finishTask();
    await commands.get('project.active')();
    await commands.get('project.switch')();
    await commands.get('item.copyValue')();
    assert.ok(events.some((value) => value.includes('Use Copy Value from a Keil project tree item')));

    const newSourcePath = path.join(testRoot, 'Core', 'Src', 'new.c');
    fs.mkdirSync(path.dirname(newSourcePath), { recursive: true });
    fs.writeFileSync(newSourcePath, 'void new_function(void) {}\n');
    await commands.get('project.addFile')(vscode.Uri.file(newSourcePath));
    assert.ok(fs.readFileSync(projectPath, 'utf8').includes('<FileName>new.c</FileName>'), 'saved C file should be added to .uvprojx');
    const target = provider.getChildren(projects[0])[0];
    const group = provider.getChildren(target).find((item) => item.label === 'Application');
    assert.ok(group, 'Application group should remain visible');
    assert.ok(provider.getChildren(group).some((item) => item.label === 'new.c'), 'Keil tree should refresh with the new file');

    await commands.get('project.createGroup')();
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

    dialogSelection = vscode.Uri.file(existingStartupPath);
    await commands.get('project.addFileToGroup')(groupAfterAdd);
    assert.ok(events.some((value) => value.includes('startup_stm32f103xe.s is already in Target 1 / Application')),
        'an existing startup assembly file should identify its original group');

    const secondStartupPath = path.join(projectDir, 'startup_extra.S');
    const assemblerPath = path.join(projectDir, 'board.asm');
    const hppPath = path.join(testRoot, 'Core', 'Cpp', 'board.hpp');
    fs.mkdirSync(path.dirname(hppPath), { recursive: true });
    fs.writeFileSync(secondStartupPath, '; second assembly file\n');
    fs.writeFileSync(assemblerPath, '; assembly file\n');
    fs.writeFileSync(hppPath, '#pragma once\n');
    dialogSelections = [secondStartupPath, assemblerPath, hppPath].map(vscode.Uri.file);
    const savesBeforeBatch = events.filter((value) => value === 'save').length;
    await commands.get('project.addFileToGroup')(groupAfterAdd);
    dialogSelections = undefined;
    assert.strictEqual(lastOpenDialogOptions.canSelectMany, true,
        'the Keil group file picker should allow multiple files');
    assert.ok(lastOpenDialogOptions.filters['Keil project files'].includes('s'),
        'the file picker should allow assembly sources');
    assert.strictEqual(events.filter((value) => value === 'save').length, savesBeforeBatch + 1,
        'one multi-file action should save VS Code files once');
    const afterBatchXml = fs.readFileSync(projectPath, 'utf8');
    for (const file of [secondStartupPath, assemblerPath, hppPath]) {
        assert.ok(afterBatchXml.includes(`<FileName>${path.basename(file)}</FileName>`),
            `${path.basename(file)} should be added in the same action`);
    }
    assert.ok(afterBatchXml.replace(/\\/g, '/').includes(path.relative(projectDir, path.dirname(hppPath)).replace(/\\/g, '/')),
        'adding an HPP file should add its directory to IncludePath');
    assert.ok(events.some((value) => value.includes('added 3, already listed 0')),
        'multi-file addition should report the number added');

    const cppPathToAdd = path.join(testRoot, 'Core', 'Cpp', 'feature.cpp');
    const libraryPath = path.join(projectDir, 'peripheral.lib');
    const unsupportedPath = path.join(projectDir, 'notes.txt');
    fs.writeFileSync(cppPathToAdd, 'void feature() {}\n');
    fs.writeFileSync(libraryPath, 'test library\n');
    fs.writeFileSync(unsupportedPath, 'not a Keil source\n');
    quickPickSelection = (choice) => choice.label === 'Board & IO';
    await commands.get('project.addFile')(vscode.Uri.file(cppPathToAdd),
        [cppPathToAdd, libraryPath, unsupportedPath].map(vscode.Uri.file));
    quickPickSelection = undefined;
    const afterExplorerBatch = fs.readFileSync(projectPath, 'utf8');
    assert.ok(afterExplorerBatch.includes('<FileName>feature.cpp</FileName>'));
    assert.ok(afterExplorerBatch.includes('<FileName>peripheral.lib</FileName>'));
    assert.ok(!afterExplorerBatch.includes('<FileName>notes.txt</FileName>'));
    assert.ok(events.some((value) => value.includes('added 2, already listed 0, skipped 1')),
        'Explorer multi-selection should add supported files and report skipped files');

    const paletteSourcePath = path.join(testRoot, 'Core', 'Src', 'palette.c');
    const paletteHeaderPath = path.join(testRoot, 'Core', 'MoreHeaders', 'palette.hxx');
    fs.mkdirSync(path.dirname(paletteHeaderPath), { recursive: true });
    fs.writeFileSync(paletteSourcePath, 'void palette(void) {}\n');
    fs.writeFileSync(paletteHeaderPath, '#pragma once\n');
    dialogSelections = [paletteSourcePath, paletteHeaderPath].map(vscode.Uri.file);
    quickPickSelection = (choice) => choice.label === 'Board & IO';
    await commands.get('project.addFile')();
    quickPickSelection = undefined;
    dialogSelections = undefined;
    assert.strictEqual(lastOpenDialogOptions.canSelectMany, true,
        'Command Palette add-file should open a multi-select file picker');
    const afterPaletteBatch = fs.readFileSync(projectPath, 'utf8');
    assert.ok(afterPaletteBatch.includes('<FileName>palette.c</FileName>'));
    assert.ok(afterPaletteBatch.includes('<FileName>palette.hxx</FileName>'));

    const secondHeaderPath = path.join(testRoot, 'Core', 'Inc', 'board2.h');
    fs.writeFileSync(secondHeaderPath, '#pragma once\n');
    dialogSelection = vscode.Uri.file(secondHeaderPath);
    quickPickSelection = (choice) => choice.label === 'Board & IO';
    await commands.get('project.addFileToGroup')();
    quickPickSelection = undefined;
    const groupWithSecondHeader = provider.getChildren(provider.getChildren(projects[0])[0])
        .find((item) => item.label === 'Board & IO');
    assert.ok(provider.getChildren(groupWithSecondHeader).some((item) => item.label === 'board2.h'),
        'command palette add-file should choose a group');
    quickPickSelection = (choice) => choice.label === 'board2.h';
    await commands.get('project.removeFile')();
    quickPickSelection = undefined;
    const groupWithoutSecondHeader = provider.getChildren(provider.getChildren(projects[0])[0])
        .find((item) => item.label === 'Board & IO');
    assert.ok(!provider.getChildren(groupWithoutSecondHeader).some((item) => item.label === 'board2.h'),
        'command palette remove-file should choose a Keil reference');
    assert.ok(fs.existsSync(secondHeaderPath), 'command palette removal must keep the disk file');

    const vscodeHeaderPath = path.join(testRoot, 'Core', 'Headers2', 'palette.h');
    fs.mkdirSync(path.dirname(vscodeHeaderPath), { recursive: true });
    fs.writeFileSync(vscodeHeaderPath, '#pragma once\n');
    await commands.get('project.addFile')(vscode.Uri.file(vscodeHeaderPath));
    const expectedInclude = path.relative(projectDir, path.dirname(vscodeHeaderPath)).replace(/\\/g, '/');
    assert.ok(fs.readFileSync(projectPath, 'utf8').replace(/\\/g, '/').includes(expectedInclude),
        'adding a header from VS Code should also add its directory to the Keil IncludePath');

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

    await commands.get('project.build')();
    const taskAtProjectClose = latestTask;
    await commands.get('project.close')(projects[0]);
    projects[0].close();
    latestTask = undefined;
    await commands.get('project.build')();
    assert.strictEqual(latestTask, undefined, 'F7 should not build a closed project');
    dialogSelection = vscode.Uri.file(projectPath);
    await commands.get('explorer.open')();
    const reopenedProject = provider.getChildren()[0];
    const countBeforeReopenBuild = taskCount();
    await commands.get('project.build')();
    assert.strictEqual(taskCount(), countBeforeReopenBuild,
        'closing and reopening a project must not overlap its still-running build');
    finishTask(taskAtProjectClose);
    await commands.get('project.build')();
    assert.strictEqual(taskCount(), countBeforeReopenBuild + 1,
        'task completion should release the lock after project close and reopen');
    finishTask();
    await commands.get('project.close')(reopenedProject);

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

    dialogSelection = vscode.Uri.file(projectPath);
    await commands.get('explorer.open')();
    assert.strictEqual(provider.getChildren().length, 2, 'two projects should be available for command palette selection');
    quickPickSelection = (choice) => typeof choice === 'string' || choice.project?.uvprjFile.path === secondPath;
    await commands.get('project.active')();
    await commands.get('project.switch')();
    quickPickSelection = (choice) => choice.project?.uvprjFile.path === projectPath;
    await commands.get('project.close')();
    assert.deepStrictEqual(provider.getChildren().map((project) => project.uvprjFile.path), [secondPath],
        'command palette close should remove the selected project only');
    quickPickSelection = undefined;

    vscode.workspace.workspaceFolders = [];
    await commands.get('project.build')();
    assert.strictEqual(latestProcess.options.cwd, path.dirname(secondPath),
        'without a VS Code workspace the Keil process must start in the project directory');
    const processCount = () => events.filter((value) => value === 'process').length;
    const initialProcessCount = processCount();
    await commands.get('project.rebuild')();
    assert.strictEqual(processCount(), initialProcessCount, 'no-workspace build should hold the shared log lock');
    latestProcess.handle.stdout.emit('data', Buffer.from('stdout sample\n'));
    latestProcess.handle.stderr.emit('data', Buffer.from('stderr sample\n'));
    latestProcess.handle.emit('close', 3, null);
    assert.ok(outputLines.join('').includes('stdout sample'));
    assert.ok(outputLines.join('').includes('stderr sample'));
    assert.ok(outputLines.join('').includes('exited with code 3'));
    await commands.get('project.download')();
    assert.strictEqual(processCount(), initialProcessCount + 1, 'process close should release the no-workspace task lock');
    latestProcess.handle.emit('close', 0, null);
    await commands.get('project.build')();
    latestProcess.handle.emit('error', new Error('test process start failure'));
    assert.ok(events.some((value) => value.includes('failed to start: test process start failure')));
    const countAfterProcessError = processCount();
    await commands.get('project.build')();
    assert.strictEqual(processCount(), countAfterProcessError + 1, 'process error should release the no-workspace task lock');
    latestProcess.handle.emit('close', 0, null);
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
    await commands.get('project.close')();
    c51Project.close();
    console.log('Smoke test passed: discovery, command palette, task lifecycle, build cwd, IntelliSense, watcher, project editing, close/F7.');
    await require('./test_project_edit').run(extensionRoot);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
    Module._load = originalLoad;
    childProcess.spawn = originalSpawn;
    const resolvedTestRoot = path.resolve(testRoot);
    if (path.dirname(resolvedTestRoot) === scratchParent &&
        path.basename(resolvedTestRoot).startsWith('.keil-assistant-smoke-')) {
        fs.rmSync(testRoot, { recursive: true, force: true });
    }
});
