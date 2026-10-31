import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as xml2js from 'xml2js';
import * as event from 'events';
import * as fs from 'fs';
import * as node_path from 'path';
import * as child_process from 'child_process';

import { File } from '../lib/node_utility/File';
import { ResourceManager } from './ResourceManager';
import { Time } from '../lib/node_utility/Time';
import { addFilesToKeilProject, addIncludeDirectoryToKeilProject, createGroupInKeilProject,
    getKeilFileType, removeFileFromKeilProject, SUPPORTED_KEIL_FILE_EXTENSIONS } from './KeilProjectEditor';
import { CppConfiguration, updateCppConfigurationsFile } from './CppConfigWriter';

export function activate(context: vscode.ExtensionContext) {

    console.log('---- keil-assistant actived ----');

    // init resource
    ResourceManager.getInstance(context);

    const prjExplorer = new ProjectExplorer(context);
    const subscriber = context.subscriptions;

    subscriber.push(vscode.commands.registerCommand('explorer.open', async () => {

        const uri = await vscode.window.showOpenDialog({
            openLabel: '打开 Keil 工程',
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'Keil 工程文件': ['uvproj', 'uvprojx']
            }
        });

        try {
            if (uri && uri.length > 0) {

                // load project
                const uvPrjPath = uri[0].fsPath;
                await prjExplorer.openProject(uvPrjPath);
                await prjExplorer.rememberProject(uvPrjPath);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`打开 Keil 工程失败：${(<Error>error).message}`);
        }
    }));

    subscriber.push(vscode.commands.registerCommand('explorer.discover', () => prjExplorer.loadWorkspace(true)));

    subscriber.push(vscode.commands.registerCommand('project.addFile',
        (uri?: vscode.Uri, selectedUris?: vscode.Uri[]) => prjExplorer.addFileFromVSCode(uri, selectedUris)));
    subscriber.push(vscode.commands.registerCommand('project.addFileToGroup', (item?: FileGroup) => prjExplorer.addFileToGroup(item)));
    subscriber.push(vscode.commands.registerCommand('project.createGroup', (item?: IView) => prjExplorer.createGroup(item)));
    subscriber.push(vscode.commands.registerCommand('project.removeFile', (item?: Source) => prjExplorer.removeFile(item)));
    subscriber.push(vscode.commands.registerCommand('project.forgetAutoAddFolder', () => prjExplorer.forgetAutoAddFolder()));

    subscriber.push(vscode.workspace.onDidCreateFiles((event) => prjExplorer.trackCreatedFiles(event.files)));
    subscriber.push(vscode.workspace.onDidRenameFiles((event) => prjExplorer.trackRenamedFiles(event.files)));
    subscriber.push(vscode.workspace.onDidDeleteFiles((event) => prjExplorer.trackDeletedFiles(event.files)));
    let initialWorkspaceLoad: Promise<void> = Promise.resolve();
    subscriber.push(vscode.workspace.onDidSaveTextDocument((document) =>
        prjExplorer.autoAddSavedFile(document, initialWorkspaceLoad)));

    subscriber.push(vscode.commands.registerCommand('project.close', (item?: IView) => prjExplorer.closeProjectFromCommand(item)));

    subscriber.push(vscode.commands.registerCommand('project.build', async (item: IView) => {
        if (await vscode.workspace.saveAll()) {
            prjExplorer.getTarget(item)?.build();
        }
    }));

    subscriber.push(vscode.commands.registerCommand('project.rebuild', async (item: IView) => {
        if (await vscode.workspace.saveAll()) {
            prjExplorer.getTarget(item)?.rebuild();
        }
    }));

    subscriber.push(vscode.commands.registerCommand('project.download', (item: IView) => prjExplorer.getTarget(item)?.download()));

    subscriber.push(vscode.commands.registerCommand('item.copyValue', (item?: IView) => {
        if (item?.tooltip === undefined) {
            vscode.window.showInformationMessage('请在 Keil 工程树中选择条目后使用“复制条目内容”。');
            return;
        }
        return vscode.env.clipboard.writeText(item.tooltip);
    }));

    subscriber.push(vscode.commands.registerCommand('project.switch', (item?: IView) => prjExplorer.switchTargetByProject(item)));
    
    subscriber.push(vscode.commands.registerCommand('project.active', (item?: IView) => prjExplorer.activeProject(item)));

    initialWorkspaceLoad = prjExplorer.loadWorkspace();
}

export function deactivate() {
    console.log('---- keil-assistant closed ----');
}

//==================== Global Func===========================

function getMD5(data: string): string {
    const md5 = crypto.createHash('md5');
    md5.update(data);
    return md5.digest('hex');
}

function normalizedFileKey(path: string): string {
    const resolved = node_path.resolve(path);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathAtOrUnder(path: string, parent: string): boolean {
    const childKey = normalizedFileKey(path);
    const parentKey = normalizedFileKey(parent);
    return childKey === parentKey || childKey.startsWith(parentKey + node_path.sep);
}

function expandProjectLocation(location: string, folders: readonly vscode.WorkspaceFolder[]): string {
    return location
        .replace(/\$\{workspaceFolder(?::([^}]+))?\}/g, (_match, name: string | undefined) => {
            const folder = name ? folders.find((item) => item.name === name) : folders[0];
            return folder ? folder.uri.fsPath : '';
        })
        .replace(/\$\{env:([^}]+)\}/g, (_match, name: string) => process.env[name] || '');
}

function readXmlText(value: any): string {
    if (value === undefined || value === null) { return ''; }
    if (typeof value === 'string') { return value; }
    if (typeof value === 'object' && !Array.isArray(value) &&
        (value._ === undefined || typeof value._ === 'string')) {
        return value._ || '';
    }
    throw new Error('Keil 工程包含不支持的编译选项文本。');
}

//===============================

interface IView {

    label: string;

    prjID: string;

    icons?: { light: string, dark: string };

    tooltip?: string;

    contextVal?: string;

    getChildViews(): IView[] | undefined;
}

//===============================================

class Source implements IView {

    label: string;
    prjID: string;
    icons?: { light: string; dark: string; } | undefined;
    tooltip?: string | undefined;
    contextVal?: string | undefined = 'Source';

    //---
    readonly file: File;
    readonly enable: boolean;
    readonly targetName?: string;
    readonly groupName?: string;

    children: Source[] | undefined;

    constructor(pID: string, f: File, _enable: boolean = true, targetName?: string, groupName?: string) {
        this.prjID = pID;
        this.enable = _enable;
        this.file = f;
        this.targetName = targetName;
        this.groupName = groupName;
        if (targetName && groupName) { this.contextVal = 'ProjectSource'; }
        this.label = this.file.name;
        this.tooltip = f.path;

        let iconName = '';
        if (f.IsFile() === false) {
            iconName = 'FileWarning_16x';
        } else if (_enable === false) {
            iconName = 'FileExclude_16x';
        } else {
            iconName = this.getIconBySuffix(f.suffix.toLowerCase());
        }

        this.icons = {
            dark: iconName,
            light: iconName
        };
    }

    private getIconBySuffix(suffix: string): string {
        switch (suffix) {
            case '.c':
                return 'CFile_16x';
            case '.h':
            case '.hpp':
            case '.hxx':
            case '.hh':
            case '.inc':
                return 'CPPHeaderFile_16x';
            case '.cpp':
            case '.c++':
            case '.cxx':
            case '.cc':
                return 'CPP_16x';
            case '.s':
            case '.a51':
            case '.a66':
            case '.asm':
                return 'AssemblerSourceFile_16x';
            case '.lib':
            case '.a':
                return 'Library_16x';
            default:
                return 'Text_16x';
        }
    }

    getChildViews(): IView[] | undefined {
        return this.children;
    }
}

class FileGroup implements IView {

    label: string;
    prjID: string;
    tooltip?: string | undefined;
    contextVal?: string | undefined = 'FileGroup';
    icons?: { light: string; dark: string; };

    //----
    sources: Source[];
    readonly excludedFromBuild: boolean;
    readonly targetName: string;

    constructor(pID: string, gName: string, disabled: boolean, targetName: string) {
        this.label = gName;
        this.prjID = pID;
        this.sources = [];
        this.excludedFromBuild = disabled;
        this.targetName = targetName;
        this.tooltip = gName;
        const iconName = disabled ? 'FolderExclude_32x' : 'Folder_32x';
        this.icons = { light: iconName, dark: iconName };
    }

    getChildViews(): IView[] | undefined {
        return this.sources;
    }
}

interface KeilProjectInfo {

    prjID: string;

    vscodeDir: File;

    uvprjFile: File;

    logger: Console;

    toAbsolutePath(rePath: string): string;
}

interface uVisonInfo {
    schemaVersion: string | undefined;
}

class KeilProject implements IView, KeilProjectInfo {

    private static warnedCppConfigs: Set<string> = new Set();

    prjID: string;
    label: string;
    tooltip?: string | undefined;
    contextVal?: string | undefined = 'Project';
    icons?: { light: string; dark: string; } = {
        light: 'DeactiveApplication_16x',
        dark: 'DeactiveApplication_16x'
    };

    //-------------

    vscodeDir: File;
    uvprjFile: File;
    logger: Console;
    private logStream: fs.WriteStream;

    // uVison info
    uVsionFileInfo: uVisonInfo;

    private activeTargetName: string | undefined;
    private reloadTimer: NodeJS.Timeout | undefined;
    private watcherRestartTimer: NodeJS.Timeout | undefined;
    private watcherRestartAttempts = 0;
    private reloadPromise: Promise<void> | undefined;
    private reloadRequested = false;
    private closed = false;
    private buildLogWatcher: fs.FSWatcher | undefined;
    private buildWatcherRestartTimer: NodeJS.Timeout | undefined;
    private buildWatcherRestartAttempts = 0;
    private sourceRefreshTimer: NodeJS.Timeout | undefined;

    protected _event: event.EventEmitter;
    protected watcher: fs.FSWatcher | undefined;
    protected targetList: Target[];

    constructor(_uvprjFile: File) {
        this._event = new event.EventEmitter();
        this.uVsionFileInfo = <uVisonInfo>{};
        this.targetList = [];
        this.vscodeDir = new File(_uvprjFile.dir + File.sep + '.vscode');
        this.vscodeDir.CreateDir();
        const logPath = this.vscodeDir.path + File.sep + 'keil-assistant.log';
        this.logStream = fs.createWriteStream(logPath, { flags: 'a+' });
        this.logger = new console.Console(this.logStream);
        this.uvprjFile = _uvprjFile;
        this.prjID = getMD5(process.platform === 'win32' ? _uvprjFile.path.toLowerCase() : _uvprjFile.path);
        this.label = _uvprjFile.noSuffixName;
        this.tooltip = _uvprjFile.path;
        this.logger.log('[info] Log at : ' + Time.GetInstance().GetTimeStamp() + '\r\n');
        this.watchProjectDirectory();
        const logLock = new File(node_path.join(this.vscodeDir.path, 'uv4.log.lock'));
        if (!logLock.IsFile()) { logLock.Write(''); }
        this.watchBuildLogDirectory();
    }

    on(event: 'dataChanged', listener: () => void): void;
    on(event: any, listener: () => void): void {
        this._event.on(event, listener);
    }

    private watchProjectDirectory() {
        if (this.closed) { return; }
        // Watching the parent directory survives an atomic replacement of the project file.
        const watcher = fs.watch(this.uvprjFile.dir, (_event, filename) => {
            this.watcherRestartAttempts = 0;
            if (!filename || filename.toString().toLowerCase() === this.uvprjFile.name.toLowerCase()) {
                this.scheduleReload();
            }
        });
        this.watcher = watcher;
        watcher.on('error', (error) => {
            if (this.watcher !== watcher) { return; }
            this.logger.log(`[Warn] Keil project watcher failed: ${error.message}`);
            watcher.close();
            this.watcher = undefined;
            this.scheduleWatcherRestart();
        });
    }

    private scheduleWatcherRestart() {
        if (this.closed || this.watcherRestartTimer || this.watcherRestartAttempts >= 5) { return; }
        this.watcherRestartAttempts++;
        this.watcherRestartTimer = setTimeout(() => {
            this.watcherRestartTimer = undefined;
            try { this.watchProjectDirectory(); }
            catch (error) {
                this.logger.log(`[Warn] Could not restart Keil project watcher: ${error.message}`);
                this.scheduleWatcherRestart();
            }
        }, 1000);
    }

    private watchBuildLogDirectory() {
        if (this.closed) { return; }
        const watcher = fs.watch(this.vscodeDir.path, (_event, filename) => {
            this.buildWatcherRestartAttempts = 0;
            if (!filename || filename.toString().toLowerCase() === 'uv4.log.lock') {
                this.scheduleSourceRefresh();
            }
        });
        this.buildLogWatcher = watcher;
        watcher.on('error', (error) => {
            if (this.buildLogWatcher !== watcher) { return; }
            this.logger.log(`[Warn] Keil build log watcher failed: ${error.message}`);
            watcher.close();
            this.buildLogWatcher = undefined;
            this.scheduleBuildWatcherRestart();
        });
    }

    private scheduleBuildWatcherRestart() {
        if (this.closed || this.buildWatcherRestartTimer || this.buildWatcherRestartAttempts >= 5) { return; }
        this.buildWatcherRestartAttempts++;
        this.buildWatcherRestartTimer = setTimeout(() => {
            this.buildWatcherRestartTimer = undefined;
            try { this.watchBuildLogDirectory(); }
            catch (error) {
                this.logger.log(`[Warn] Could not restart Keil build log watcher: ${error.message}`);
                this.scheduleBuildWatcherRestart();
            }
        }, 1000);
    }

    private scheduleSourceRefresh() {
        if (this.closed) { return; }
        if (this.sourceRefreshTimer) { clearTimeout(this.sourceRefreshTimer); }
        this.sourceRefreshTimer = setTimeout(() => {
            this.sourceRefreshTimer = undefined;
            this.targetList.filter((target) => target.hasLoadedSourceRefs())
                .forEach((target) => target.updateSourceRefs());
        }, 150);
    }

    private scheduleReload() {
        if (this.closed) { return; }
        if (this.reloadTimer) { clearTimeout(this.reloadTimer); }
        this.reloadTimer = setTimeout(() => {
            this.reloadTimer = undefined;
            this.reload().catch((error) =>
                vscode.window.showErrorMessage(`重新加载 Keil 工程失败：${error.message}`));
        }, 300);
    }

    private async onReload() {
        let lastError: Error | undefined;
        for (let attempt = 0; attempt < 4 && !this.closed; attempt++) {
            try {
                await this.load();
                this.notifyUpdateView();
                return;
            } catch (error) {
                if (this.closed) { return; }
                lastError = error;
                if (attempt < 3) {
                    await new Promise((resolve) => setTimeout(resolve, 500));
                }
            }
        }
        if (lastError) { throw lastError; }
    }

    async reload() {
        if (this.closed) { return; }
        if (this.reloadTimer) {
            clearTimeout(this.reloadTimer);
            this.reloadTimer = undefined;
        }
        if (this.reloadPromise) {
            this.reloadRequested = true;
            return this.reloadPromise;
        }
        const task = this.onReload();
        this.reloadPromise = task;
        try { await task; }
        finally {
            this.reloadPromise = undefined;
            if (this.reloadRequested && !this.closed) {
                this.reloadRequested = false;
                this.scheduleReload();
            }
        }
    }

    async load() {

        const parser = new xml2js.Parser({ explicitArray: false });
        const doc = await parser.parseStringPromise({ toString: () => { return this.uvprjFile.Read(); } });
        const targets = doc['Project']['Targets']['Target'];

        // init uVsion info
        this.uVsionFileInfo.schemaVersion = doc['Project']['SchemaVersion'];

        const nextTargets: Target[] = [];
        try {
            for (const target of Array.isArray(targets) ? targets : [targets]) {
                nextTargets.push(Target.getInstance(this, this.uVsionFileInfo, target));
            }
            for (const target of nextTargets) {
                await target.load();
                target.on('dataChanged', () => this.notifyUpdateView());
            }
        } catch (error) {
            nextTargets.forEach((target) => target.close());
            throw error;
        }
        if (this.closed) {
            nextTargets.forEach((target) => target.close());
            throw new Error('重新加载时 Keil 工程已关闭。');
        }
        this.updateCppProperties(nextTargets);
        const previousTargets = this.targetList;
        this.targetList = nextTargets;
        previousTargets.forEach((target) => target.close());
        this.getActiveTarget()?.updateSourceRefs(false);
    }

    notifyUpdateView() {
        this._event.emit('dataChanged');
    }

    private updateCppProperties(targets: Target[]) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this.uvprjFile.path));
        const configDir = workspaceFolder ? workspaceFolder.uri.fsPath : this.uvprjFile.dir;
        const configPath = node_path.join(configDir, '.vscode', 'c_cpp_properties.json');
        try {
            updateCppConfigurationsFile(configPath, targets.map((target) => target.getCppConfiguration()));
        } catch (error) {
            this.logger.log(error);
            if (!KeilProject.warnedCppConfigs.has(configPath)) {
                KeilProject.warnedCppConfigs.add(configPath);
                vscode.window.showWarningMessage(`无法更新 ${configPath}。请检查 JSON 格式；原文件已保留。`);
            }
        }
    }

    close() {
        if (this.closed) { return; }
        this.closed = true;
        if (this.reloadTimer) { clearTimeout(this.reloadTimer); }
        if (this.watcherRestartTimer) { clearTimeout(this.watcherRestartTimer); }
        if (this.buildWatcherRestartTimer) { clearTimeout(this.buildWatcherRestartTimer); }
        if (this.sourceRefreshTimer) { clearTimeout(this.sourceRefreshTimer); }
        this.watcher?.close();
        this.buildLogWatcher?.close();
        this.targetList.forEach((target) => target.close());
        this.logger.log('[info] project closed: ' + this.label);
        this.logStream.end();
    }

    toAbsolutePath(rePath: string): string {
        const path = rePath.replace(/[\\/]/g, File.sep);
        return node_path.resolve(this.uvprjFile.dir, path);
    }

    active() {
        this.icons = { light: 'ActiveApplication_16x', dark: 'ActiveApplication_16x' };
    }

    deactive() {
        this.icons = { light: 'DeactiveApplication_16x', dark: 'DeactiveApplication_16x' };
    }

    getTargetByName(name: string): Target | undefined {
        const index = this.targetList.findIndex((t) => { return t.targetName === name; });
        if (index !== -1) {
            return this.targetList[index];
        }
    }

    setActiveTarget(tName: string) {
        if (tName !== this.activeTargetName) {
            this.activeTargetName = tName;
            this.getActiveTarget()?.updateSourceRefs(false);
            this.notifyUpdateView(); // notify data changed
        }
    }

    getActiveTarget(): Target | undefined {

        if (this.activeTargetName) {
            const target = this.getTargetByName(this.activeTargetName);
            if (target) {
                return target;
            }
        }

        if (this.targetList.length > 0) {
            return this.targetList[0];
        }
    }

    getChildViews(): IView[] | undefined {

        if (this.activeTargetName) {
            const target = this.getTargetByName(this.activeTargetName);
            if (target) {
                return [target];
            }
        }

        if (this.targetList.length > 0) {
            return [this.targetList[0]];
        }

        return undefined;
    }

    getTargets(): Target[] {
        return this.targetList;
    }
}

abstract class Target implements IView {

    private static runningTasks: Map<string, string> = new Map();
    private static processOutput: vscode.OutputChannel | undefined;

    prjID: string;
    label: string;
    tooltip?: string | undefined;
    contextVal?: string | undefined = 'Target';
    icons?: { light: string; dark: string; } = {
        light: 'Class_16x',
        dark: 'Class_16x'
    };

    //-------------

    readonly targetName: string;

    protected _event: event.EventEmitter;
    protected project: KeilProjectInfo;
    protected cppConfigName: string;
    protected targetDOM: any;
    protected uvInfo: uVisonInfo;
    protected fGroups: FileGroup[];
    protected includes: Set<string>;
    protected defines: Set<string>;

    private uv4LogFile: File;
    private sourceRefStamps = new Map<Source, { mtimeMs: number; ctimeMs: number; size: number }>();
    private sourceRefsLoaded = false;
    private closed = false;

    constructor(prjInfo: KeilProjectInfo, uvInfo: uVisonInfo, targetDOM: any) {
        this._event = new event.EventEmitter();
        this.project = prjInfo;
        this.targetDOM = targetDOM;
        this.uvInfo = uvInfo;
        this.prjID = prjInfo.prjID;
        this.targetName = targetDOM['TargetName'];
        this.label = this.targetName;
        this.tooltip = this.targetName;
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(prjInfo.uvprjFile.path));
        const projectPath = workspaceFolder ? node_path.relative(workspaceFolder.uri.fsPath, prjInfo.uvprjFile.path) : prjInfo.uvprjFile.name;
        this.cppConfigName = `${projectPath.replace(/\\/g, '/')}: ${this.targetName}`;
        this.includes = new Set();
        this.defines = new Set();
        this.fGroups = [];
        this.uv4LogFile = new File(this.project.vscodeDir.path + File.sep + 'uv4.log');
    }

    on(event: 'dataChanged', listener: () => void): void;
    on(event: any, listener: () => void): void {
        this._event.on(event, listener);
    }

    static getInstance(prjInfo: KeilProjectInfo, uvInfo: uVisonInfo, targetDOM: any): Target {
        if (prjInfo.uvprjFile.suffix.toLowerCase() === '.uvproj') {
            return new C51Target(prjInfo, uvInfo, targetDOM);
        } else {
            return new ArmTarget(prjInfo, uvInfo, targetDOM);
        }
    }

    getCppConfiguration(): CppConfiguration {
        return {
            name: this.cppConfigName,
            includePath: Array.from(this.includes).concat(['${default}']),
            defines: Array.from(this.defines),
            intelliSenseMode: '${default}'
        };
    }

    async load(): Promise<void> {

        // check target is valid
        const err = this.checkProject(this.targetDOM);
        if (err) { throw err; }

        const incListStr: string = this.getIncString(this.targetDOM) || '';
        const defineListStr: string = this.getDefineString(this.targetDOM) || '';
        const _groups: any = this.getGroups(this.targetDOM);
        const sysIncludes = this.getSystemIncludes(this.targetDOM);

        // set includes
        this.includes.clear();

        let incList = incListStr.split(';');
        if (sysIncludes) {
            incList = incList.concat(sysIncludes);
        }

        incList.forEach((path) => {
            const realPath = path.trim();
            if (realPath !== '') {
                this.includes.add(this.project.toAbsolutePath(realPath));
            }
        });

        // set defines
        this.defines.clear();

        // add user macros
        defineListStr.split(/,|\s+/).forEach((define) => {
            if (define.trim() !== '') {
                this.defines.add(define);
            }
        });

        // add system macros
        this.getSysDefines(this.targetDOM).forEach((define) => {
            this.defines.add(define);
        });

        // set file groups
        this.fGroups = [];

        let groups: any[];
        if (Array.isArray(_groups)) {
            groups = _groups;
        } else {
            groups = [_groups];
        }

        for (const group of groups) {
            if (!group || !group['GroupName']) { continue; }

                let isGroupExcluded = false;
                let fileList: any[];

                if (group['GroupOption']) { // check group is excluded
                    const gOption = group['GroupOption']['CommonProperty'];
                    if (gOption && gOption['IncludeInBuild'] === '0') {
                        isGroupExcluded = true;
                    }
                }

                const nGrp = new FileGroup(this.prjID, group['GroupName'], isGroupExcluded, this.targetName);

                if (Array.isArray(group['Files'])) {
                    fileList = [];
                    for (const files of group['Files']) {
                        if (Array.isArray(files['File'])) {
                            fileList = fileList.concat(files['File']);
                        }
                        else if (files['File'] !== undefined) {
                            fileList.push(files['File']);
                        }
                    }
                } else if (group['Files']) {
                    if (Array.isArray(group['Files']['File'])) {
                        fileList = group['Files']['File'];
                    }
                    else if (group['Files']['File'] !== undefined) {
                        fileList = [group['Files']['File']];
                    } else {
                        fileList = [];
                    }
                } else {
                    fileList = [];
                }

                for (const file of fileList) {
                    const f = new File(this.project.toAbsolutePath(file['FilePath']));

                    let isFileExcluded = isGroupExcluded;
                    if (isFileExcluded === false && file['FileOption']) { // check file is enable
                        const fOption = file['FileOption']['CommonProperty'];
                        if (fOption && fOption['IncludeInBuild'] === '0') {
                            isFileExcluded = true;
                        }
                    }

                    const nFile = new Source(this.prjID, f, !isFileExcluded, this.targetName, nGrp.label);
                    this.includes.add(f.dir);
                    nGrp.sources.push(nFile);
                }

                this.fGroups.push(nGrp);
        }

    }

    private runTask(name: string, commands: string[]) {

        const resManager = ResourceManager.getInstance();
        const builderPath = resManager.getBuilderExe();
        const uv4PathIndex = commands.indexOf('--uv4Path');
        const uv4Path = uv4PathIndex >= 0 ? commands[uv4PathIndex + 1] : undefined;
        if (!new File(builderPath).IsFile()) {
            vscode.window.showErrorMessage(`找不到 Keil Assistant 编译工具：${builderPath}`);
            return;
        }
        if (!uv4Path || !new File(uv4Path).IsFile()) {
            vscode.window.showErrorMessage('找不到 Keil UV4.exe。请在 VS Code 设置中配置 KeilAssistant.MDK.Uv4Path 或 KeilAssistant.C51.Uv4Path。');
            return;
        }

        const args = ['-o', this.uv4LogFile.path].concat(commands);
        // Targets in the same directory share uv4.log and may share build outputs.
        const logPath = node_path.resolve(this.uv4LogFile.path);
        const taskKey = process.platform === 'win32' ? logPath.toLowerCase() : logPath;
        const running = Target.runningTasks.get(taskKey);
        if (running) {
            vscode.window.showWarningMessage(`Keil 工程 ${this.project.uvprjFile.dir} 正在${running}，请等待完成后再${name}。`);
            return;
        }
        Target.runningTasks.set(taskKey, name);
        let released = false;
        const release = () => {
            if (released) { return; }
            released = true;
            Target.runningTasks.delete(taskKey);
        };

        // use task
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            let endSubscription: vscode.Disposable | undefined;
            try {
                const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this.project.uvprjFile.path));
                const runId = crypto.randomBytes(8).toString('hex');
                const task = new vscode.Task({ type: 'keil-task', runId }, workspaceFolder || vscode.TaskScope.Global,
                    `${name}: ${this.project.uvprjFile.name} / ${this.targetName}`, 'Keil 助手');
                task.execution = new vscode.ProcessExecution(builderPath, args, { cwd: this.project.uvprjFile.dir });
                task.isBackground = false;
                task.problemMatchers = this.getProblemMatcher();
                task.presentationOptions = {
                    echo: false,
                    focus: false,
                    clear: true
                };
                endSubscription = vscode.tasks.onDidEndTask((event) => {
                    if (event.execution.task.definition.runId !== runId) { return; }
                    if (endSubscription) { endSubscription.dispose(); }
                    release();
                    this.updateSourceRefs();
                });
                vscode.tasks.executeTask(task).then(undefined, (error) => {
                    if (endSubscription) { endSubscription.dispose(); }
                    release();
                    vscode.window.showErrorMessage(`Keil ${name}启动失败：${error.message}`);
                });
            } catch (error) {
                if (endSubscription) { endSubscription.dispose(); }
                release();
                vscode.window.showErrorMessage(`Keil ${name}启动失败：${(<Error>error).message}`);
            }

        } else {
            // VS Code cannot report completion of a command in an
            // interactive terminal, so use a process with a real exit event.
            try {
                const output = Target.processOutput ||
                    (Target.processOutput = vscode.window.createOutputChannel('Keil 助手'));
                output.appendLine(`${name}: ${this.project.uvprjFile.name} / ${this.targetName}`);
                output.show(true);
                const processHandle = child_process.spawn(builderPath, args, {
                    cwd: this.project.uvprjFile.dir,
                    windowsHide: true
                });
                processHandle.stdout?.on('data', (chunk) => output.append(chunk.toString()));
                processHandle.stderr?.on('data', (chunk) => output.append(chunk.toString()));
                processHandle.on('error', (error) => {
                    release();
                    output.appendLine(`Keil ${name}启动失败：${error.message}`);
                    vscode.window.showErrorMessage(`Keil ${name}启动失败：${error.message}`);
                });
                processHandle.on('close', (code, signal) => {
                    release();
                    output.appendLine(`Keil ${name}已结束，退出码 ${code === null ? '未知' : code}${signal ? `（信号 ${signal}）` : ''}。`);
                    this.updateSourceRefs();
                });
            } catch (error) {
                release();
                Target.processOutput?.appendLine(`Keil ${name}启动失败：${(<Error>error).message}`);
                vscode.window.showErrorMessage(`Keil ${name}启动失败：${(<Error>error).message}`);
            }
        }
    }

    build() {
        this.runTask('编译', this.getBuildCommand());
    }

    rebuild() {
        this.runTask('重新编译', this.getRebuildCommand());
    }

    download() {
        this.runTask('下载到设备', this.getDownloadCommand());
    }

    hasLoadedSourceRefs(): boolean {
        return this.sourceRefsLoaded;
    }

    updateSourceRefs(notify: boolean = true, selectedGroup?: FileGroup) {
        if (this.closed) { return; }
        const rePath = this.getOutputFolder(this.targetDOM);
        if (rePath) {
            this.sourceRefsLoaded = true;
            let changed = false;
            const outPath = this.project.toAbsolutePath(rePath);
            (selectedGroup ? [selectedGroup] : this.fGroups).forEach((group) => {
                group.sources.forEach((source) => {
                    if (source.enable) { // if source not disabled
                        const refFile = File.fromArray([outPath, source.file.noSuffixName + '.d']);
                        let stat: fs.Stats | undefined;
                        try { stat = fs.statSync(refFile.path); }
                        catch (error) { /* The dependency file may not exist yet. */ }
                        if (!stat || !stat.isFile()) {
                            if (this.sourceRefStamps.delete(source)) {
                                source.children = undefined;
                                changed = true;
                            }
                            return;
                        }
                        const stamp = this.sourceRefStamps.get(source);
                        if (stamp && stamp.mtimeMs === stat.mtimeMs && stamp.ctimeMs === stat.ctimeMs &&
                            stamp.size === stat.size) { return; }
                        try {
                            const refFileList = this.parseRefLines(this.targetDOM, refFile.Read().split(/\r\n|\n/))
                                .map((dependency) => this.project.toAbsolutePath(dependency));
                            source.children = refFileList.map((refFilePath) => new Source(source.prjID, new File(refFilePath)));
                            this.sourceRefStamps.set(source, {
                                mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size
                            });
                            changed = true;
                        } catch (error) {
                            this.project.logger.log(`[Warn] Could not read ${refFile.path}: ${(<Error>error).message}`);
                        }
                    }
                });
            });
            if (notify && changed) { this._event.emit('dataChanged'); }
        }
    }

    close() {
        this.closed = true;
        this.sourceRefStamps.clear();
    }

    getChildViews(): IView[] | undefined {
        return this.fGroups;
    }

    getFileGroups(): FileGroup[] {
        return this.fGroups;
    }

    protected abstract checkProject(target: any): Error | undefined;

    protected abstract getIncString(target: any): string;
    protected abstract getDefineString(target: any): string;
    protected abstract getSysDefines(target: any): string[];
    protected abstract getGroups(target: any): any[];
    protected abstract getSystemIncludes(target: any): string[] | undefined;

    protected abstract getOutputFolder(target: any): string | undefined;
    protected abstract parseRefLines(target: any, lines: string[]): string[];

    protected abstract getProblemMatcher(): string[];
    protected abstract getBuildCommand(): string[];
    protected abstract getRebuildCommand(): string[];
    protected abstract getDownloadCommand(): string[];
}

//===============================================

class C51Target extends Target {

    protected checkProject(target: any): Error | undefined {
        if (target['TargetOption']['Target51'] === undefined ||
            target['TargetOption']['Target51']['C51'] === undefined) {
            return new Error('该 .uvproj 文件不是有效的 Keil C51 工程。');
        }
    }

    protected parseRefLines(target: any, lines: string[]): string[] {
        return [];
    }

    protected getOutputFolder(target: any): string | undefined {
        return undefined;
    }

    protected getSysDefines(target: any): string[] {
        return [
            '__C51__',
            '__VSCODE_C51__',
            'reentrant=',
            'compact=',
            'small=',
            'large=',
            'data=',
            'idata=',
            'pdata=',
            'bdata=',
            'xdata=',
            'code=',
            'bit=char',
            'sbit=char',
            'sfr=char',
            'sfr16=int',
            'sfr32=int',
            'interrupt=',
            'using=',
            '_at_=',
            '_priority_=',
            '_task_='
        ];
    }

    protected getSystemIncludes(target: any): string[] | undefined {
        const exeFile = new File(ResourceManager.getInstance().getC51UV4Path());
        if (exeFile.IsFile()) {
            return [
                node_path.dirname(exeFile.dir) + File.sep + 'C51' + File.sep + 'INC'
            ];
        }
        return undefined;
    }

    protected getIncString(target: any): string {
        const target51 = target['TargetOption']['Target51']['C51'];
        const controls = target51['VariousControls'];
        return readXmlText(controls && controls['IncludePath']);
    }

    protected getDefineString(target: any): string {
        const target51 = target['TargetOption']['Target51']['C51'];
        const controls = target51['VariousControls'];
        return readXmlText(controls && controls['Define']);
    }

    protected getGroups(target: any): any[] {
        return (target['Groups'] && target['Groups']['Group']) || [];
    }

    protected getProblemMatcher(): string[] {
        return ['$c51'];
    }

    protected getBuildCommand(): string[] {
        return [
            '--uv4Path', ResourceManager.getInstance().getC51UV4Path(),
            '--prjPath', this.project.uvprjFile.path,
            '--targetName', this.targetName,
            '-c', '${uv4Path} -b ${prjPath} -j0 -t ${targetName}'
        ];
    }

    protected getRebuildCommand(): string[] {
        return [
            '--uv4Path', ResourceManager.getInstance().getC51UV4Path(),
            '--prjPath', this.project.uvprjFile.path,
            '--targetName', this.targetName,
            '-c', '${uv4Path} -r ${prjPath} -j0 -t ${targetName}'
        ];
    }

    protected getDownloadCommand(): string[] {
        return [
            '--uv4Path', ResourceManager.getInstance().getC51UV4Path(),
            '--prjPath', this.project.uvprjFile.path,
            '--targetName', this.targetName,
            '-c', '${uv4Path} -f ${prjPath} -j0 -t ${targetName}'
        ];
    }
}

class MacroHandler {

    private regMatchers = {
        'normal_macro': /^#define (\w+) (.*)$/,
        'func_macro': /^#define (\w+\([^\)]*\)) (.*)$/
    };

    toExpression(macro: string): string | undefined {

        let mList = this.regMatchers['normal_macro'].exec(macro);
        if (mList && mList.length > 2) {
            return `${mList[1]}=${mList[2]}`;
        }

        mList = this.regMatchers['func_macro'].exec(macro);
        if (mList && mList.length > 2) {
            return `${mList[1]}=`;
        }
    }
}

class ArmTarget extends Target {

    private static readonly armccMacros: string[] = [
        '__CC_ARM',
        '__arm__',
        '__align(x)=',
        '__ALIGNOF__(x)=',
        '__alignof__(x)=',
        '__asm(x)=',
        '__forceinline=',
        '__restrict=',
        '__global_reg(n)=',
        '__inline=',
        '__int64=long long',
        '__INTADDR__(expr)=0',
        '__irq=',
        '__packed=',
        '__pure=',
        '__smc(n)=',
        '__svc(n)=',
        '__svc_indirect(n)=',
        '__svc_indirect_r7(n)=',
        '__value_in_regs=',
        '__weak=',
        '__writeonly=',
        '__declspec(x)=',
        '__attribute__(x)=',
        '__nonnull__(x)=',
        '__register=',

        '__breakpoint(x)=',
        '__cdp(x,y,z)=',
        '__clrex()=',
        '__clz(x)=0U',
        '__current_pc()=0U',
        '__current_sp()=0U',
        '__disable_fiq()=',
        '__disable_irq()=',
        '__dmb(x)=',
        '__dsb(x)=',
        '__enable_fiq()=',
        '__enable_irq()=',
        '__fabs(x)=0.0',
        '__fabsf(x)=0.0f',
        '__force_loads()=',
        '__force_stores()=',
        '__isb(x)=',
        '__ldrex(x)=0U',
        '__ldrexd(x)=0U',
        '__ldrt(x)=0U',
        '__memory_changed()=',
        '__nop()=',
        '__pld(...)=',
        '__pli(...)=',
        '__qadd(x,y)=0',
        '__qdbl(x)=0',
        '__qsub(x,y)=0',
        '__rbit(x)=0U',
        '__rev(x)=0U',
        '__return_address()=0U',
        '__ror(x,y)=0U',
        '__schedule_barrier()=',
        '__semihost(x,y)=0',
        '__sev()=',
        '__sqrt(x)=0.0',
        '__sqrtf(x)=0.0f',
        '__ssat(x,y)=0',
        '__strex(x,y)=0U',
        '__strexd(x,y)=0',
        '__strt(x,y)=',
        '__swp(x,y)=0U',
        '__usat(x,y)=0U',
        '__wfe()=',
        '__wfi()=',
        '__yield()=',
        '__vfp_status(x,y)=0'
    ];

    private static readonly armclangMacros: string[] = [
        '__alignof__(x)=',
        '__asm(x)=',
        '__asm__(x)=',
        '__forceinline=',
        '__restrict=',
        '__volatile__=',
        '__inline=',
        '__inline__=',
        '__declspec(x)=',
        '__attribute__(x)=',
        '__nonnull__(x)=',
        '__unaligned=',
        '__promise(x)=',
        '__irq=',
        '__swi=',
        '__weak=',
        '__register=',
        '__pure=',
        '__value_in_regs=',

        '__breakpoint(x)=',
        '__current_pc()=0U',
        '__current_sp()=0U',
        '__disable_fiq()=',
        '__disable_irq()=',
        '__enable_fiq()=',
        '__enable_irq()=',
        '__force_stores()=',
        '__memory_changed()=',
        '__schedule_barrier()=',
        '__semihost(x,y)=0',
        '__vfp_status(x,y)=0',

        '__builtin_arm_nop()=',
        '__builtin_arm_wfi()=',
        '__builtin_arm_wfe()=',
        '__builtin_arm_sev()=',
        '__builtin_arm_sevl()=',
        '__builtin_arm_yield()=',
        '__builtin_arm_isb(x)=',
        '__builtin_arm_dsb(x)=',
        '__builtin_arm_dmb(x)=',

        '__builtin_bswap32(x)=0U',
        '__builtin_bswap16(x)=0U',
        '__builtin_arm_rbit(x)=0U',

        '__builtin_clz(x)=0U',
        '__builtin_arm_ldrex(x)=0U',
        '__builtin_arm_strex(x,y)=0U',
        '__builtin_arm_clrex()=',
        '__builtin_arm_ssat(x,y)=0U',
        '__builtin_arm_usat(x,y)=0U',
        '__builtin_arm_ldaex(x)=0U',
        '__builtin_arm_stlex(x,y)=0U'
    ];

    private static armclangMacroCache = new Map<string, string[]>();
    private static armclangMacroRequests = new Map<string, Promise<void>>();
    private static armclangFallback = ['__GNUC__=4', '__GNUC_MINOR__=2', '__GNUC_PATCHLEVEL__=1'];

    async load(): Promise<void> {
        if (this.targetDOM['uAC6'] === '1') {
            await ArmTarget.initArmclangMacros(this.armclangPath());
        }
        await super.load();
    }

    protected checkProject(): Error | undefined {
        return undefined;
    }

    protected getOutputFolder(target: any): string | undefined {
        try {
            return <string>target['TargetOption']['TargetCommonOption']['OutputDirectory'];
        } catch (error) {
            return undefined;
        }
    }

    private gnu_parseRefLines(lines: string[]): string[] {

        const resultList: Set<string> = new Set();

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            let _line = lines[lineIndex];

            let line = _line[_line.length - 1] === '\\' ? _line.substring(0, _line.length - 1) : _line; // remove char '\'
            let subLines = line.trim().split(/(?<![\\:]) /);

            if (lineIndex === 0) // first line
            {
                for (let i = 1; i < subLines.length; i++) // skip first sub line
                {
                    resultList.add(subLines[i].trim().replace(/\\ /g, " "));
                }
            }
            else  // other lines, first char is whitespace
            {
                subLines.forEach((item) => {
                    resultList.add(item.trim().replace(/\\ /g, " "));
                });
            }
        }

        return Array.from(resultList);
    }

    private ac5_parseRefLines(lines: string[], startIndex: number = 1): string[] {

        const resultList: Set<string> = new Set<string>();

        for (let i = startIndex; i < lines.length; i++) {
            let sepIndex = lines[i].indexOf(": ");
            if (sepIndex > 0) {
                const line: string = lines[i].substring(sepIndex + 1).trim();
                resultList.add(line);
            }
        }

        return Array.from(resultList);
    }

    protected parseRefLines(target: any, lines: string[]): string[] {
        if (target['uAC6'] === '1') { // ARMClang
            return this.gnu_parseRefLines(lines);
        } else { // ARMCC
            return this.ac5_parseRefLines(lines);
        }
    }

    private armclangPath(): string {
        return node_path.join(node_path.dirname(node_path.dirname(ResourceManager.getInstance().getArmUV4Path())),
            'ARM', 'ARMCLANG', 'bin', 'armclang.exe');
    }

    private static initArmclangMacros(path: string): Promise<void> {
        const cached = ArmTarget.armclangMacroCache.get(path);
        if (cached) { return Promise.resolve(); }
        const pending = ArmTarget.armclangMacroRequests.get(path);
        if (pending) { return pending; }
        const request = ArmTarget.getArmClangMacroList(path).then((macros) => {
            if (macros) { ArmTarget.armclangMacroCache.set(path, macros); }
        }).catch(() => {
            // Keep static macros and retry when the project loads again.
        }).then(() => {
            ArmTarget.armclangMacroRequests.delete(path);
        });
        ArmTarget.armclangMacroRequests.set(path, request);
        return request;
    }

    protected getSysDefines(target: any): string[] {
        if (target['uAC6'] === '1') { // ARMClang
            return ArmTarget.armclangMacros.concat(
                ArmTarget.armclangMacroCache.get(this.armclangPath()) || ArmTarget.armclangFallback);
        } else { // ARMCC
            return ArmTarget.armccMacros;
        }
    }

    private static getArmClangMacroList(armClangPath: string): Promise<string[] | undefined> {
        if (!new File(armClangPath).IsFile()) { return Promise.resolve(undefined); }
        return new Promise((resolve) => {
            const child = child_process.execFile(armClangPath,
                ['--target=arm-arm-none-eabi', '-E', '-dM', '-'],
                { timeout: 5000, maxBuffer: 2 * 1024 * 1024 },
                (error, stdout) => {
                    if (error) { resolve(undefined); return; }
                    try {
                        const mHandler = new MacroHandler();
                        const macros = stdout.split(/\r\n|\n/)
                            .map((line) => mHandler.toExpression(line))
                            .filter((value): value is string => !!value);
                        resolve(macros.length ? macros : undefined);
                    } catch (error) { resolve(undefined); }
                });
            if (child.stdin) { child.stdin.end(); }
        });
    }

    protected getSystemIncludes(target: any): string[] | undefined {
        const exeFile = new File(ResourceManager.getInstance().getArmUV4Path());
        if (exeFile.IsFile()) {
            const toolName = target['uAC6'] === '1' ? 'ARMCLANG' : 'ARMCC';
            const incDir = new File(`${node_path.dirname(exeFile.dir)}${File.sep}ARM${File.sep}${toolName}${File.sep}include`);
            if (incDir.IsDir()) {
                return [incDir.path].concat(
                    incDir.GetList(File.EMPTY_FILTER).map((dir) => { return dir.path; }));
            }
            return [incDir.path];
        }
        return undefined;
    }

    protected getIncString(target: any): string {
        const dat = target['TargetOption']['TargetArmAds']['Cads'];
        const controls = dat['VariousControls'];
        return readXmlText(controls && controls['IncludePath']);
    }

    protected getDefineString(target: any): string {
        const dat = target['TargetOption']['TargetArmAds']['Cads'];
        const controls = dat['VariousControls'];
        return readXmlText(controls && controls['Define']);
    }

    protected getGroups(target: any): any[] {
        return (target['Groups'] && target['Groups']['Group']) || [];
    }

    protected getProblemMatcher(): string[] {
        return ['$armcc', '$gcc'];
    }

    protected getBuildCommand(): string[] {
        return [
            '--uv4Path', ResourceManager.getInstance().getArmUV4Path(),
            '--prjPath', this.project.uvprjFile.path,
            '--targetName', this.targetName,
            '-c', '${uv4Path} -b ${prjPath} -j0 -t ${targetName}'
        ];
    }

    protected getRebuildCommand(): string[] {
        return [
            '--uv4Path', ResourceManager.getInstance().getArmUV4Path(),
            '--prjPath', this.project.uvprjFile.path,
            '--targetName', this.targetName,
            '-c', '${uv4Path} -r ${prjPath} -j0 -t ${targetName}'
        ];
    }

    protected getDownloadCommand(): string[] {
        return [
            '--uv4Path', ResourceManager.getInstance().getArmUV4Path(),
            '--prjPath', this.project.uvprjFile.path,
            '--targetName', this.targetName,
            '-c', '${uv4Path} -f ${prjPath} -j0 -t ${targetName}'
        ];
    }
}

//================================================

interface AutoAddDestination {
    project: KeilProject;
    target: Target;
    group: FileGroup;
}

interface AutoAddDirectoryMapping {
    projectPath: string;
    targetName: string;
    groupName: string;
}

interface QueuedAutoAdd {
    path: string;
    cancelled: boolean;
}

class ProjectExplorer implements vscode.TreeDataProvider<IView> {

    private ItemClickCommand: string = 'Item.Click';
    private readonly savedProjectsKey = 'KeilAssistant.SelectedProjects';
    private readonly discoveryPromptedKey = 'KeilAssistant.DiscoveryPrompted';
    private readonly autoAddMappingsKey = 'KeilAssistant.AutoAdd.DirectoryMappings';
    private readonly context: vscode.ExtensionContext;
    private readonly pendingCreatedFiles = new Set<string>();
    private readonly queuedAutoAdds = new Set<QueuedAutoAdd>();
    private autoAddQueue: Promise<void> = Promise.resolve();
    private readonly projectEditQueues = new Map<string, Promise<void>>();

    onDidChangeTreeData: vscode.Event<IView | undefined>;
    private viewEvent: vscode.EventEmitter<IView | undefined>;

    private prjList: Map<string, KeilProject>;
    private currentActiveProject: KeilProject | undefined;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.prjList = new Map();
        this.viewEvent = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.viewEvent.event;
        context.subscriptions.push(vscode.window.registerTreeDataProvider('project', this));
        context.subscriptions.push(vscode.commands.registerCommand(this.ItemClickCommand, (item) => this.onItemClick(item)));
    }

    private autoAddEnabled(uri: vscode.Uri): boolean {
        return vscode.workspace.getConfiguration('KeilAssistant', uri)
            .get<boolean>('Project.AutoAddNewFiles', true);
    }

    trackCreatedFiles(files: readonly vscode.Uri[]) {
        for (const uri of files) {
            if (uri.scheme === 'file' && getKeilFileType(uri.fsPath) && this.autoAddEnabled(uri)) {
                this.pendingCreatedFiles.add(normalizedFileKey(uri.fsPath));
            }
        }
    }

    trackRenamedFiles(files: ReadonlyArray<{ oldUri: vscode.Uri; newUri: vscode.Uri }>) {
        for (const file of files) {
            if (file.oldUri.scheme !== 'file') { continue; }
            const oldPath = normalizedFileKey(file.oldUri.fsPath);
            const newPath = file.newUri.scheme === 'file' ? normalizedFileKey(file.newUri.fsPath) : undefined;
            for (const pending of Array.from(this.pendingCreatedFiles)) {
                if (pending !== oldPath && !pending.startsWith(oldPath + node_path.sep)) { continue; }
                this.pendingCreatedFiles.delete(pending);
                if (newPath) {
                    const renamed = newPath + pending.slice(oldPath.length);
                    if (getKeilFileType(renamed)) { this.pendingCreatedFiles.add(renamed); }
                }
            }
            for (const queued of this.queuedAutoAdds) {
                const queuedPath = normalizedFileKey(queued.path);
                if (queuedPath !== oldPath && !queuedPath.startsWith(oldPath + node_path.sep)) { continue; }
                if (!newPath) { queued.cancelled = true; continue; }
                const renamed = newPath + queuedPath.slice(oldPath.length);
                if (getKeilFileType(renamed)) { queued.path = renamed; }
                else { queued.cancelled = true; }
            }
        }
    }

    trackDeletedFiles(files: readonly vscode.Uri[]) {
        for (const uri of files) {
            if (uri.scheme !== 'file') { continue; }
            const deletedPath = normalizedFileKey(uri.fsPath);
            for (const pending of Array.from(this.pendingCreatedFiles)) {
                if (pending === deletedPath || pending.startsWith(deletedPath + node_path.sep)) {
                    this.pendingCreatedFiles.delete(pending);
                }
            }
            for (const queued of this.queuedAutoAdds) {
                if (isPathAtOrUnder(queued.path, deletedPath)) { queued.cancelled = true; }
            }
        }
    }

    autoAddSavedFile(document: vscode.TextDocument, initialLoad: Promise<void>): Promise<void> {
        if (document.uri.scheme !== 'file') { return Promise.resolve(); }
        const sourcePath = document.uri.fsPath;
        const key = normalizedFileKey(sourcePath);
        if (!this.pendingCreatedFiles.has(key) || document.isDirty) { return Promise.resolve(); }
        this.pendingCreatedFiles.delete(key);
        if (!this.autoAddEnabled(document.uri)) { return Promise.resolve(); }
        const queued: QueuedAutoAdd = { path: sourcePath, cancelled: false };
        this.queuedAutoAdds.add(queued);
        const task = this.autoAddQueue.then(async () => {
            try {
                await initialLoad;
                if (!queued.cancelled) { await this.addNewSavedFile(queued); }
            } finally {
                this.queuedAutoAdds.delete(queued);
            }
        });
        this.autoAddQueue = task.then(() => undefined, (error) => {
            vscode.window.showErrorMessage(`无法自动将 ${node_path.basename(queued.path)} 加入 Keil 工程：${(<Error>error).message}`);
        });
        return this.autoAddQueue;
    }

    private getAutoAddMappings(): Record<string, AutoAddDirectoryMapping> {
        const stored = this.context.workspaceState.get<Record<string, AutoAddDirectoryMapping>>(this.autoAddMappingsKey, {});
        return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    }

    async forgetAutoAddFolder() {
        const mappings = this.getAutoAddMappings();
        const folders = Object.keys(mappings).sort();
        if (!folders.length) {
            vscode.window.showInformationMessage('还没有保存过自动添加文件夹的分组记录。');
            return;
        }
        const selected = await vscode.window.showQuickPick(folders.map((folder) => ({
            label: folder,
            description: `${mappings[folder].projectPath} / ${mappings[folder].targetName} / ${mappings[folder].groupName}`
        })), { placeHolder: '选择要清除分组记录的文件夹' });
        if (!selected) { return; }
        const updated = { ...mappings };
        delete updated[selected.label];
        await this.context.workspaceState.update(this.autoAddMappingsKey, updated);
        vscode.window.showInformationMessage(`已清除 ${selected.label} 的自动添加分组记录。`);
    }

    private autoAddChoices(sourcePath: string): { exact: AutoAddDestination[]; related: AutoAddDestination[] } {
        const directory = normalizedFileKey(node_path.dirname(sourcePath));
        const sourceWorkspace = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(sourcePath));
        const isBuildInput = getKeilFileType(sourcePath) !== '5';
        const exact: AutoAddDestination[] = [];
        const related: AutoAddDestination[] = [];
        for (const project of this.prjList.values()) {
            const projectWorkspace = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.uvprjFile.path));
            const sameWorkspace = !!sourceWorkspace && !!projectWorkspace &&
                normalizedFileKey(sourceWorkspace.uri.fsPath) === normalizedFileKey(projectWorkspace.uri.fsPath);
            const insideProjectDirectory = isPathAtOrUnder(sourcePath, project.uvprjFile.dir);
            for (const target of project.getTargets()) {
                const inIncludeDirectory = target.getCppConfiguration().includePath.some((includePath) =>
                    includePath !== '${default}' && normalizedFileKey(includePath) === directory);
                for (const group of target.getFileGroups()) {
                    if (isBuildInput && group.excludedFromBuild) { continue; }
                    const sameSourceDirectory = group.sources.some((source) =>
                        normalizedFileKey(source.file.dir) === directory);
                    const choice = { project, target, group };
                    if (sameSourceDirectory) { exact.push(choice); }
                    if (sameWorkspace || insideProjectDirectory || inIncludeDirectory || sameSourceDirectory) {
                        related.push(choice);
                    }
                }
            }
        }
        return { exact, related };
    }

    private async chooseAutoAddDestination(sourcePath: string,
        queued: QueuedAutoAdd): Promise<AutoAddDestination | undefined> {
        const directory = normalizedFileKey(node_path.dirname(sourcePath));
        const { exact, related } = this.autoAddChoices(sourcePath);
        const mappings = this.getAutoAddMappings();
        const mapping = mappings[directory];
        if (!related.length && !mapping) { return undefined; }
        if (mapping) {
            const remembered = related.find((choice) =>
                normalizedFileKey(choice.project.uvprjFile.path) === normalizedFileKey(mapping.projectPath) &&
                choice.target.targetName === mapping.targetName && choice.group.label === mapping.groupName);
            if (remembered) { return remembered; }
            vscode.window.showWarningMessage(`已跳过自动添加 ${node_path.basename(sourcePath)}：` +
                `原先记录的分组不可用。请打开 ${mapping.projectPath}，或运行“清除自动添加的文件夹分组记录”。`);
            return undefined;
        }
        const choices = exact.length ? exact : related;
        if (exact.length === 1) { return exact[0]; }
        const selected = await vscode.window.showQuickPick(choices.map((choice) => ({
            label: choice.group.label,
            description: `${choice.project.label} / ${choice.target.targetName} — ${choice.project.uvprjFile.path}`,
            choice
        })), { placeHolder: `选择 ${node_path.dirname(sourcePath)} 中新文件所属的 Keil 分组` });
        if (!selected || queued.cancelled || normalizedFileKey(queued.path) !== normalizedFileKey(sourcePath)) {
            return undefined;
        }
        await this.context.workspaceState.update(this.autoAddMappingsKey, {
            ...this.getAutoAddMappings(),
            [directory]: {
                projectPath: selected.choice.project.uvprjFile.path,
                targetName: selected.choice.target.targetName,
                groupName: selected.choice.group.label
            }
        });
        return selected.choice;
    }

    private async addNewSavedFile(queued: QueuedAutoAdd) {
        for (let attempt = 0; attempt < 3 && !queued.cancelled; attempt++) {
            const sourcePath = queued.path;
            if (!new File(sourcePath).IsFile() || !getKeilFileType(sourcePath)) { return; }
            const chosen = await this.chooseAutoAddDestination(sourcePath, queued);
            if (queued.cancelled) { return; }
            if (normalizedFileKey(queued.path) !== normalizedFileKey(sourcePath)) { continue; }
            if (!chosen) { return; }
            const project = this.prjList.get(chosen.project.prjID);
            const target = project?.getTargetByName(chosen.target.targetName);
            const group = target?.getFileGroups().find((item) => item.label === chosen.group.label);
            if (!project || !target || !group || !new File(sourcePath).IsFile()) { return; }
            const applied = await this.addSelectedFiles(project, target, group, [sourcePath], [], true, queued);
            if (applied || queued.cancelled) { return; }
        }
    }

    private async serializeProjectEdit<T>(project: KeilProject, edit: () => Promise<T>): Promise<T> {
        const key = project.prjID;
        const previous = this.projectEditQueues.get(key) || Promise.resolve();
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => { release = resolve; });
        this.projectEditQueues.set(key, gate);
        await previous;
        try {
            if (this.prjList.get(key) !== project) {
                throw new Error('所选 Keil 工程已关闭。');
            }
            return await edit();
        } finally {
            release();
            if (this.projectEditQueues.get(key) === gate) { this.projectEditQueues.delete(key); }
        }
    }

    async loadWorkspace(forcePrompt: boolean = false) {
        const folders = vscode.workspace.workspaceFolders || [];
        const excludeList = ResourceManager.getInstance().getProjectExcludeList().map((entry) => entry.replace(/\\/g, '/').toLowerCase());
        const normalize = (path: string) => node_path.resolve(path);
        const key = (path: string) => process.platform === 'win32' ? normalize(path).toLowerCase() : normalize(path);
        const isExcluded = (path: string) => {
            const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(path));
            const relative = folder ? node_path.relative(folder.uri.fsPath, path).replace(/\\/g, '/').toLowerCase() : '';
            return excludeList.includes(node_path.basename(path).toLowerCase()) || excludeList.includes(relative);
        };
        const candidates = new Map<string, string>();
        const add = (path: string, respectExclude: boolean = true) => {
            const fullPath = normalize(path);
            if (/\.uvprojx?$/i.test(fullPath) && (!respectExclude || !isExcluded(fullPath)) && new File(fullPath).IsFile()) {
                candidates.set(key(fullPath), fullPath);
            }
        };

        for (const folder of folders) {
            const root = new File(folder.uri.fsPath);
            if (root.IsDir()) {
                root.GetList([/\.uvprojx?$/i], File.EMPTY_FILTER).forEach((file) => add(file.path));
            }
        }

        const explicitPaths = ResourceManager.getInstance().getProjectFileLocationList()
            .concat(this.context.workspaceState.get<string[]>(this.savedProjectsKey, []));
        for (const projectPath of explicitPaths) {
            const expanded = expandProjectLocation(projectPath, folders);
            add(node_path.isAbsolute(expanded) ? expanded : node_path.join(folders[0] ? folders[0].uri.fsPath : process.cwd(), expanded), false);
        }

        for (const projectPath of candidates.values()) {
            try {
                await this.openProject(projectPath);
            } catch (error) {
                vscode.window.showErrorMessage(`打开 Keil 工程失败：${projectPath}。${(<Error>error).message}`);
            }
        }

        if (folders.length === 0) {
            return;
        }

        const found = await vscode.workspace.findFiles('**/*.{uvproj,uvprojx,UVPROJ,UVPROJX}',
            '**/{.git,node_modules,Objects,Listings,build,dist}/**');
        const nested = found.map((uri) => normalize(uri.fsPath))
            .filter((path) => !isExcluded(path) && !this.prjList.has(getMD5(key(path))))
            .filter((path) => new File(path).IsFile());

        if (nested.length === 1 && !forcePrompt) {
            try {
                await this.openProject(nested[0]);
                await this.rememberProject(nested[0]);
            } catch (error) {
                vscode.window.showErrorMessage(`打开 Keil 工程失败：${nested[0]}。${(<Error>error).message}`);
            }
        } else if (nested.length > 0 && (forcePrompt || !this.context.workspaceState.get<boolean>(this.discoveryPromptedKey, false))) {
            const choices = nested.map((path) => {
                const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(path));
                return { label: folder ? node_path.relative(folder.uri.fsPath, path) : path,
                    description: folder ? folder.name : '', projectPath: path };
            });
            const selected = await vscode.window.showQuickPick(choices, {
                canPickMany: true,
                placeHolder: '选择要加载的 Keil 工程；当前 VS Code 工作区不会切换'
            });
            await this.context.workspaceState.update(this.discoveryPromptedKey, true);
            if (selected) {
                for (const choice of selected) {
                    try {
                        await this.openProject(choice.projectPath);
                        await this.rememberProject(choice.projectPath);
                    } catch (error) {
                        vscode.window.showErrorMessage(`打开 Keil 工程失败：${choice.projectPath}。${(<Error>error).message}`);
                    }
                }
            }
        } else if (forcePrompt && nested.length === 0) {
            vscode.window.showInformationMessage('当前工作区没有找到其他 Keil 工程。');
        }
    }

    async rememberProject(path: string) {
        const selected = this.context.workspaceState.get<string[]>(this.savedProjectsKey, []);
        const fullPath = node_path.resolve(path);
        if (!selected.some((entry) => entry.toLowerCase() === fullPath.toLowerCase())) {
            await this.context.workspaceState.update(this.savedProjectsKey, selected.concat(fullPath));
        }
    }

    async openProject(path: string): Promise<KeilProject | undefined> {

        const fullPath = node_path.resolve(path);
        const file = new File(fullPath);
        if (!/\.uvprojx?$/i.test(fullPath) || !file.IsFile()) {
            throw new Error(`Keil 工程文件不存在：${fullPath}`);
        }
        const prjID = getMD5(process.platform === 'win32' ? fullPath.toLowerCase() : fullPath);
        if (this.prjList.has(prjID)) {
            return this.prjList.get(prjID);
        }

        const nPrj = new KeilProject(file);
        if (!this.prjList.has(nPrj.prjID)) {

            try {
                await nPrj.load();
            } catch (error) {
                nPrj.close();
                throw error;
            }
            nPrj.on('dataChanged', () => this.updateView());
            this.prjList.set(nPrj.prjID, nPrj);

            if (this.currentActiveProject == undefined) {
                this.currentActiveProject = nPrj;
                this.currentActiveProject.active();
            }

            this.updateView();

            return nPrj;
        }
    }

    async closeProject(pID: string) {
        const prj = this.prjList.get(pID);
        if (prj) {
            const wasActive = this.currentActiveProject === prj;
            prj.deactive();
            prj.close();
            this.prjList.delete(pID);
            const selected = this.context.workspaceState.get<string[]>(this.savedProjectsKey, []);
            await this.context.workspaceState.update(this.savedProjectsKey,
                selected.filter((path) => node_path.resolve(path).toLowerCase() !== prj.uvprjFile.path.toLowerCase()));
            if (wasActive) {
                this.currentActiveProject = this.prjList.values().next().value;
                this.currentActiveProject?.active();
            }
            this.updateView();
        }
    }

    private async chooseProject(view?: IView): Promise<KeilProject | undefined> {
        if (view) {
            const project = this.prjList.get(view.prjID);
            if (!project) { vscode.window.showWarningMessage('所选 Keil 工程已关闭。'); }
            return project;
        }
        const projects = Array.from(this.prjList.values());
        if (projects.length === 0) {
            vscode.window.showWarningMessage('请先打开 Keil 工程。');
            return undefined;
        }
        if (projects.length === 1) { return projects[0]; }
        const selected = await vscode.window.showQuickPick(projects.map((project) => ({
            label: project.label,
            description: project.uvprjFile.path,
            project
        })), { placeHolder: '选择 Keil 工程' });
        return selected?.project;
    }

    async closeProjectFromCommand(view?: IView) {
        const project = await this.chooseProject(view);
        if (project) { await this.closeProject(project.prjID); }
    }

    async activeProject(view?: IView) {
        const project = await this.chooseProject(view);
        if (project) {
            this.currentActiveProject?.deactive();
            this.currentActiveProject = project;
            this.currentActiveProject?.active();
            this.updateView();
        }
    }

    async switchTargetByProject(view?: IView) {
        const prj = await this.chooseProject(view);
        if (prj) {
            const tList = prj.getTargets();
            if (tList.length === 0) {
                vscode.window.showWarningMessage(`${prj.label} 中没有 Keil 编译目标。`);
                return;
            }
            const targetName = await vscode.window.showQuickPick(tList.map((ele) => { return ele.targetName; }), {
                canPickMany: false,
                placeHolder: '选择 Keil 编译目标'
            });
            if (targetName) {
                prj.setActiveTarget(targetName);
            }
        }
    }

    async createGroup(view?: IView) {
        try {
            const project = await this.chooseProject(view);
            const target = view?.contextVal === 'Target' ? project?.getTargetByName(view.label) : project?.getActiveTarget();
            if (!project || !target) {
                vscode.window.showWarningMessage('请先打开 Keil 工程并选择编译目标。');
                return;
            }
            const name = await vscode.window.showInputBox({
                prompt: `在 ${project.label} / ${target.targetName} 中新建分组`,
                placeHolder: '输入分组名，例如 Application/User',
                validateInput: (value) => {
                    if (!value.trim()) { return '请输入分组名。'; }
                    if (/[\u0000-\u001f]/.test(value)) { return '分组名不能包含控制字符。'; }
                    return undefined;
                }
            });
            if (name === undefined) { return; }
            await this.serializeProjectEdit(project, async () => {
                if (!await vscode.workspace.saveAll()) { return; }
                const result = await createGroupInKeilProject(project.uvprjFile.path, target.targetName, name);
                if (result.status === 'already-present') {
                    vscode.window.showInformationMessage(`${target.targetName} 中已存在 Keil 分组 ${name.trim()}。`);
                } else {
                    await project.reload();
                    vscode.window.showInformationMessage(`已在 ${target.targetName} 中新建 Keil 分组 ${name.trim()}。`);
                }
            });
        } catch (error) {
            vscode.window.showErrorMessage(`新建 Keil 分组失败：${(<Error>error).message}`);
        }
    }

    async removeFile(item?: Source) {
        if (!(item instanceof Source)) {
            const choices = Array.from(this.prjList.values()).reduce<Array<{ label: string; description: string; source: Source }>>(
                (list, project) => {
                    project.getTargets().forEach((target) => target.getFileGroups().forEach((group) =>
                        group.sources.forEach((source) => list.push({
                            label: source.label,
                            description: `${project.label} / ${target.targetName} / ${group.label} — ${source.file.path}`,
                            source
                        }))));
                    return list;
                }, []);
            if (choices.length === 0) {
                vscode.window.showWarningMessage('已打开的 Keil 工程中没有可移除的文件引用。');
                return;
            }
            const selected = await vscode.window.showQuickPick(choices, {
                placeHolder: '选择要移除的工程文件引用（不会删除磁盘文件）'
            });
            item = selected?.source;
        }
        if (!item) { return; }
        if (!item.targetName || !item.groupName) {
            vscode.window.showWarningMessage('请选择 Keil 分组中直接列出的文件。');
            return;
        }
        const project = this.prjList.get(item.prjID);
        if (!project) {
            vscode.window.showWarningMessage('所选 Keil 工程已关闭。');
            return;
        }
        const source = item;
        try {
            await this.serializeProjectEdit(project, async () => {
                if (!await vscode.workspace.saveAll()) { return; }
                const result = await removeFileFromKeilProject(project.uvprjFile.path,
                    source.targetName!, source.groupName!, source.file.path);
                if (result.status === 'not-present') {
                    vscode.window.showInformationMessage(`${source.label} 已不在 ${source.targetName} / ${source.groupName} 中。`);
                } else {
                    await project.reload();
                    vscode.window.showInformationMessage(`已从 Keil 工程移除 ${source.label} 的引用，磁盘文件已保留。`);
                }
            });
        } catch (error) {
            vscode.window.showErrorMessage(`从 Keil 工程移除文件引用失败：${(<Error>error).message}`);
        }
    }

    private collectKeilFiles(uris: readonly vscode.Uri[]): { paths: string[]; skipped: string[] } {
        const paths: string[] = [];
        const skipped: string[] = [];
        const seen = new Set<string>();
        for (const uri of uris) {
            if (!uri || uri.scheme !== 'file') {
                skipped.push('非本地文件');
                continue;
            }
            const sourcePath = uri.fsPath;
            const key = node_path.resolve(sourcePath);
            const normalizedKey = process.platform === 'win32' ? key.toLowerCase() : key;
            if (seen.has(normalizedKey)) { continue; }
            seen.add(normalizedKey);
            if (!new File(sourcePath).IsFile()) {
                skipped.push(`${node_path.basename(sourcePath)}（不是已保存的文件）`);
            } else if (!getKeilFileType(sourcePath)) {
                skipped.push(`${node_path.basename(sourcePath)}（不支持的文件类型）`);
            } else {
                paths.push(sourcePath);
            }
        }
        return { paths, skipped };
    }

    private reportSkippedFiles(skipped: string[]): string {
        const examples = skipped.slice(0, 3).join('、');
        return skipped.length > 3 ? `${examples}，另有 ${skipped.length - 3} 项` : examples;
    }

    private isCHeaderFile(sourcePath: string): boolean {
        return /\.(h|hpp|hxx|hh)$/i.test(sourcePath);
    }

    private async addSelectedFiles(project: KeilProject, target: Target, group: FileGroup,
        sourcePaths: string[], initiallySkipped: string[], alreadySaved: boolean = false,
        queued?: QueuedAutoAdd): Promise<boolean> {
        return this.serializeProjectEdit(project, async () => {
            if (queued && (queued.cancelled || normalizedFileKey(queued.path) !== normalizedFileKey(sourcePaths[0]) ||
                !new File(sourcePaths[0]).IsFile())) { return false; }
            await this.addSelectedFilesNow(project, target, group, sourcePaths, initiallySkipped, alreadySaved);
            return true;
        });
    }

    private async addSelectedFilesNow(project: KeilProject, target: Target, group: FileGroup,
        sourcePaths: string[], initiallySkipped: string[], alreadySaved: boolean) {
        const skipped = initiallySkipped.slice();
        const paths = sourcePaths.filter((sourcePath) => {
            if (group.excludedFromBuild && getKeilFileType(sourcePath) !== '5') {
                skipped.push(`${node_path.basename(sourcePath)}（分组已排除编译）`);
                return false;
            }
            return true;
        });
        if (!paths.length) {
            vscode.window.showWarningMessage(`没有添加文件：${this.reportSkippedFiles(skipped)}`);
            return;
        }
        if (!alreadySaved && !await vscode.workspace.saveAll()) { return; }

        const results = await addFilesToKeilProject(project.uvprjFile.path, target.targetName, group.label, paths);
        const headerDirs = new Map<string, string>();
        paths.forEach((sourcePath) => {
            if (!this.isCHeaderFile(sourcePath)) { return; }
            const directory = node_path.dirname(sourcePath);
            const key = process.platform === 'win32' ? directory.toLowerCase() : directory;
            headerDirs.set(key, directory);
        });
        let includeChanged = 0;
        const includeErrors: string[] = [];
        for (const directory of headerDirs.values()) {
            try {
                const includeResult = await addIncludeDirectoryToKeilProject(project.uvprjFile.path,
                    target.targetName, directory);
                if (includeResult.status === 'created') { includeChanged++; }
            } catch (error) {
                includeErrors.push(`${directory}: ${(<Error>error).message}`);
            }
        }

        const added = results.filter((result) => result.status === 'added').length;
        if (added || includeChanged) {
            try { await project.reload(); }
            catch (error) {
                vscode.window.showWarningMessage(`Keil 工程已更新，但工程树刷新失败：${(<Error>error).message}`);
                return;
            }
        }
        if (paths.length === 1 && skipped.length === 0 && includeErrors.length === 0) {
            const fileName = node_path.basename(paths[0]);
            const result = results[0];
            if (result.status === 'already-present') {
                vscode.window.showInformationMessage(`${fileName} 已在 ${target.targetName} / ${result.groupName} 分组中${includeChanged ? '；已将头文件目录加入 IncludePath' : ''}。`);
            } else {
                vscode.window.showInformationMessage(`已将 ${fileName} 加入 ${target.targetName} / ${group.label} 分组${includeChanged ? '，并将其目录加入 IncludePath' : ''}。`);
            }
            return;
        }

        const already = results.map((result, index) => result.status === 'already-present'
            ? `${node_path.basename(paths[index])} (${result.groupName})` : undefined)
            .filter((item): item is string => !!item);
        const summary = `Keil ${target.targetName} / ${group.label}：新增 ${added} 个，已存在 ${already.length} 个` +
            `${includeChanged ? `，新增头文件目录 ${includeChanged} 个` : ''}` +
            `${skipped.length ? `，跳过 ${skipped.length} 个` : ''}。`;
        const details = [
            already.length ? `已存在：${this.reportSkippedFiles(already)}。` : '',
            skipped.length ? `已跳过：${this.reportSkippedFiles(skipped)}。` : '',
            includeErrors.length ? `IncludePath 更新失败：${this.reportSkippedFiles(includeErrors)}。` : ''
        ].filter(Boolean).join(' ');
        if (skipped.length || includeErrors.length) {
            vscode.window.showWarningMessage(`${summary} ${details}`);
        } else {
            vscode.window.showInformationMessage(`${summary} ${details}`);
        }
    }

    async addFileToGroup(item?: FileGroup) {
        if (!(item instanceof FileGroup)) {
            const choices = Array.from(this.prjList.values()).reduce<Array<{ label: string; description: string; group: FileGroup }>>(
                (list, project) => {
                    project.getTargets().forEach((target) => target.getFileGroups().forEach((group) => list.push({
                        label: group.label,
                        description: `${project.label} / ${target.targetName}${group.excludedFromBuild ? ' — 已排除编译' : ''}`,
                        group
                    })));
                    return list;
                }, []);
            if (choices.length === 0) {
                vscode.window.showWarningMessage('没有可用的 Keil 分组，请先新建分组。');
                return;
            }
            const selected = await vscode.window.showQuickPick(choices, {
                placeHolder: '选择要添加文件的 Keil 分组'
            });
            item = selected?.group;
        }
        if (!item) { return; }
        const project = this.prjList.get(item.prjID);
        const target = project?.getTargetByName(item.targetName);
        const groupName = item.label;
        const group = target?.getFileGroups().find((candidate) => candidate.label === groupName);
        if (!project || !target || !group) {
            vscode.window.showWarningMessage('所选 Keil 分组已不可用。');
            return;
        }
        try {
            const selected = await vscode.window.showOpenDialog({
                openLabel: `添加到 ${item.label}`,
                canSelectFolders: false,
                canSelectMany: true,
                filters: { 'Keil 工程文件': Array.from(SUPPORTED_KEIL_FILE_EXTENSIONS, (extension) => extension.slice(1)) }
            });
            if (!selected || !selected.length) { return; }
            const { paths, skipped } = this.collectKeilFiles(selected);
            if (!paths.length) {
                vscode.window.showWarningMessage(`请选择已保存的 Keil 源文件、汇编文件、库文件或头文件。${this.reportSkippedFiles(skipped)}`);
                return;
            }
            await this.addSelectedFiles(project, target, group, paths, skipped);
        } catch (error) {
            vscode.window.showErrorMessage(`将文件添加到 Keil 分组失败：${(<Error>error).message}`);
        }
    }

    async addFileFromVSCode(uri?: vscode.Uri, selectedUris?: vscode.Uri[]) {
        try {
            let sourceUris = selectedUris && selectedUris.length ? selectedUris :
                uri && uri.scheme === 'file' ? [uri] : [];
            if (!sourceUris.length) {
                const selected = await vscode.window.showOpenDialog({
                    openLabel: '添加到 Keil 工程',
                    canSelectFolders: false,
                    canSelectMany: true,
                    filters: { 'Keil 工程文件': Array.from(SUPPORTED_KEIL_FILE_EXTENSIONS, (extension) => extension.slice(1)) }
                });
                sourceUris = selected || [];
            }
            if (!sourceUris.length) { return; }
            const { paths, skipped } = this.collectKeilFiles(sourceUris);
            if (!paths.length) {
                vscode.window.showWarningMessage(`请选择已保存的 Keil 源文件、汇编文件、库文件或头文件。${this.reportSkippedFiles(skipped)}`);
                return;
            }

            if (!this.prjList.size) { await this.loadWorkspace(); }
            const projects = Array.from(this.prjList.values());
            if (!projects.length) {
                vscode.window.showWarningMessage('请先打开 Keil .uvproj 或 .uvprojx 工程。');
                return;
            }

            let project: KeilProject | undefined;
            if (projects.length === 1) {
                project = projects[0];
            } else {
                const choices = projects.map((item) => ({
                    label: item.label,
                    description: item.uvprjFile.path,
                    project: item
                }));
                const selected = await vscode.window.showQuickPick(choices, {
                    placeHolder: '选择文件所属的 Keil 工程'
                });
                project = selected?.project;
            }
            if (!project) { return; }

            const targets = project.getTargets();
            let target: Target | undefined;
            if (targets.length === 1) {
                target = targets[0];
            } else {
                const selected = await vscode.window.showQuickPick(targets.map((item) => ({
                    label: item.targetName,
                    target: item
                })), { placeHolder: '选择要更新的 Keil 编译目标' });
                target = selected?.target;
            }
            if (!target) { return; }

            const hasBuildInput = paths.some((sourcePath) => getKeilFileType(sourcePath) !== '5');
            const groups = target.getFileGroups().filter((group) => !hasBuildInput || !group.excludedFromBuild);
            if (!groups.length) {
                vscode.window.showWarningMessage(hasBuildInput
                    ? '此编译目标中没有可参与编译的 Keil 分组。'
                    : '此编译目标中没有 Keil 分组，请先新建分组。');
                return;
            }
            let group: FileGroup | undefined;
            if (groups.length === 1) {
                group = groups[0];
            } else {
                const selected = await vscode.window.showQuickPick(groups.map((item) => ({
                    label: item.label,
                    description: item.excludedFromBuild ? '已排除编译' : '',
                    group: item
                })), { placeHolder: '选择文件所属的 Keil 分组' });
                group = selected?.group;
            }
            if (!group) { return; }
            await this.addSelectedFiles(project, target, group, paths, skipped);
        } catch (error) {
            vscode.window.showErrorMessage(`将文件添加到 Keil 工程失败：${(<Error>error).message}`);
        }
    }

    getTarget(view?: IView): Target | undefined {
        if (view) {
            const prj = this.prjList.get(view.prjID);
            if (prj) {
                const targetName = view.contextVal === 'Target' ? view.label :
                    view instanceof FileGroup ? view.targetName :
                    view instanceof Source ? view.targetName : undefined;
                const target = targetName ? prj.getTargetByName(targetName) : prj.getActiveTarget();
                if (target) { return target; }
                vscode.window.showWarningMessage(`${prj.label} 中没有可用的 Keil 编译目标。`);
            } else {
                vscode.window.showWarningMessage('所选 Keil 工程已关闭。');
            }
        } else { // get active target
            if (this.currentActiveProject) {
                const target = this.currentActiveProject.getActiveTarget();
                if (target) { return target; }
                vscode.window.showWarningMessage(`${this.currentActiveProject.label} 中没有可用的 Keil 编译目标。`);
            } else {
                vscode.window.showWarningMessage('请先打开 Keil 工程。');
            }
        }
    }

    updateView() {
        this.viewEvent.fire(undefined);
    }

    //----------------------------------

    itemClickInfo: any = undefined;

    private async onItemClick(item: IView) {
        switch (item.contextVal) {
            case 'Source':
            case 'ProjectSource':
                {
                    const source = <Source>item;
                    const file = new File(node_path.normalize(source.file.path));

                    if (file.IsFile()) { // file exist, open it

                        let isPreview: boolean = true;

                        if (this.itemClickInfo &&
                            this.itemClickInfo.name === file.path &&
                            this.itemClickInfo.time + 260 > Date.now()) {
                            isPreview = false;
                        }

                        // reset prev click info
                        this.itemClickInfo = {
                            name: file.path,
                            time: Date.now()
                        };

                        vscode.window.showTextDocument(vscode.Uri.parse(file.ToUri()), { preview: isPreview });

                    } else {
                        vscode.window.showWarningMessage(`找不到文件：${source.file.path}`);
                    }
                }
                break;
            default:
                break;
        }
    }

    getTreeItem(element: IView): vscode.TreeItem | Thenable<vscode.TreeItem> {

        const res = new vscode.TreeItem(element.label);

        res.contextValue = element.contextVal;
        res.tooltip = element.tooltip;
        res.collapsibleState = element.getChildViews() === undefined ?
            vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed;

        if (element instanceof Source) {
            res.command = {
                title: element.label,
                command: this.ItemClickCommand,
                arguments: [element]
            };
        }

        if (element.icons) {
            const light = ResourceManager.getInstance().getIconByName(element.icons.light);
            const dark = ResourceManager.getInstance().getIconByName(element.icons.dark);
            if (light && dark) {
                res.iconPath = { light: vscode.Uri.file(light), dark: vscode.Uri.file(dark) };
            }
        }
        return res;
    }

    getChildren(element?: IView | undefined): vscode.ProviderResult<IView[]> {
        if (element === undefined) {
            return Array.from(this.prjList.values());
        } else {
            if (element instanceof FileGroup) {
                const target = this.prjList.get(element.prjID)?.getTargetByName(element.targetName);
                if (target && target.getFileGroups().includes(element)) {
                    target.updateSourceRefs(false, element);
                }
            }
            return element.getChildViews();
        }
    }
}
