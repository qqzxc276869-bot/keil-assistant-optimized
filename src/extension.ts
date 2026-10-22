import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as xml2js from 'xml2js';
import * as event from 'events';
import * as fs from 'fs';
import * as node_path from 'path';
import * as child_process from 'child_process';

import { File } from '../lib/node_utility/File';
import { ResourceManager } from './ResourceManager';
import { FileWatcher } from '../lib/node_utility/FileWatcher';
import { Time } from '../lib/node_utility/Time';
import { CmdLineHandler } from './CmdLineHandler';
import { addFileToKeilProject, createGroupInKeilProject, removeFileFromKeilProject } from './KeilProjectEditor';

export function activate(context: vscode.ExtensionContext) {

    console.log('---- keil-assistant actived ----');

    // init resource
    ResourceManager.getInstance(context);

    const prjExplorer = new ProjectExplorer(context);
    const subscriber = context.subscriptions;

    subscriber.push(vscode.commands.registerCommand('explorer.open', async () => {

        const uri = await vscode.window.showOpenDialog({
            openLabel: 'Open a keil project',
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'keil project xml': ['uvproj', 'uvprojx']
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
            vscode.window.showErrorMessage(`open project failed !, msg: ${(<Error>error).message}`);
        }
    }));

    subscriber.push(vscode.commands.registerCommand('explorer.discover', () => prjExplorer.loadWorkspace(true)));

    subscriber.push(vscode.commands.registerCommand('project.addFile', (uri?: vscode.Uri) => prjExplorer.addFileFromVSCode(uri)));
    subscriber.push(vscode.commands.registerCommand('project.addFileToGroup', (item: FileGroup) => prjExplorer.addFileToGroup(item)));
    subscriber.push(vscode.commands.registerCommand('project.createGroup', (item?: IView) => prjExplorer.createGroup(item)));
    subscriber.push(vscode.commands.registerCommand('project.removeFile', (item: Source) => prjExplorer.removeFile(item)));

    subscriber.push(vscode.commands.registerCommand('project.close', (item: IView) => prjExplorer.closeProject(item.prjID)));

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

    subscriber.push(vscode.commands.registerCommand('item.copyValue', (item: IView) => vscode.env.clipboard.writeText(item.tooltip || '')));

    subscriber.push(vscode.commands.registerCommand('project.switch', (item: IView) => prjExplorer.switchTargetByProject(item)));
    
    subscriber.push(vscode.commands.registerCommand('project.active', (item: IView) => prjExplorer.activeProject(item)));

    prjExplorer.loadWorkspace();
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

function expandProjectLocation(location: string, folders: readonly vscode.WorkspaceFolder[]): string {
    return location
        .replace(/\$\{workspaceFolder(?::([^}]+))?\}/g, (_match, name: string | undefined) => {
            const folder = name ? folders.find((item) => item.name === name) : folders[0];
            return folder ? folder.uri.fsPath : '';
        })
        .replace(/\$\{env:([^}]+)\}/g, (_match, name: string) => process.env[name] || '');
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
            case '.inc':
                return 'CPPHeaderFile_16x';
            case '.cpp':
            case '.c++':
            case '.cxx':
            case '.cc':
                return 'CPP_16x';
            case '.s':
            case '.a51':
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

    // uVison info
    uVsionFileInfo: uVisonInfo;

    private activeTargetName: string | undefined;
    private prevUpdateTime: number | undefined;

    protected _event: event.EventEmitter;
    protected watcher: FileWatcher;
    protected targetList: Target[];

    constructor(_uvprjFile: File) {
        this._event = new event.EventEmitter();
        this.uVsionFileInfo = <uVisonInfo>{};
        this.targetList = [];
        this.vscodeDir = new File(_uvprjFile.dir + File.sep + '.vscode');
        this.vscodeDir.CreateDir();
        const logPath = this.vscodeDir.path + File.sep + 'keil-assistant.log';
        this.logger = new console.Console(fs.createWriteStream(logPath, { flags: 'a+' }));
        this.uvprjFile = _uvprjFile;
        this.watcher = new FileWatcher(this.uvprjFile);
        this.prjID = getMD5(process.platform === 'win32' ? _uvprjFile.path.toLowerCase() : _uvprjFile.path);
        this.label = _uvprjFile.noSuffixName;
        this.tooltip = _uvprjFile.path;
        this.logger.log('[info] Log at : ' + Time.GetInstance().GetTimeStamp() + '\r\n');
        this.watcher.OnChanged = () => {
            if (this.prevUpdateTime === undefined ||
                this.prevUpdateTime + 2000 < Date.now()) {
                this.prevUpdateTime = Date.now(); // reset update time
                setTimeout(() => this.onReload(), 300);
            }
        };
        this.watcher.OnRename = this.watcher.OnChanged;
        this.watcher.Watch();
    }

    on(event: 'dataChanged', listener: () => void): void;
    on(event: any, listener: () => void): void {
        this._event.on(event, listener);
    }

    private async onReload() {
        try {
            this.targetList.forEach((target) => target.close());
            this.targetList = [];
            await this.load();
            // An atomic project-file save replaces the watched file on Windows.
            // Reattach the watcher so later changes are still detected.
            this.watcher.Close();
            this.watcher.Watch();
            this.notifyUpdateView();
        } catch (err) {
            if (err.code && err.code === 'EBUSY') {
                this.logger.log(`[Warn] uVision project file '${this.uvprjFile.name}' is locked !, delay 500 ms and retry !`);
                setTimeout(() => this.onReload(), 500);
            } else {
                vscode.window.showErrorMessage(`reload project failed !, msg: ${err.message}`);
            }
        }
    }

    async reload() {
        this.prevUpdateTime = Date.now();
        await this.onReload();
    }

    async load() {

        const parser = new xml2js.Parser({ explicitArray: false });
        const doc = await parser.parseStringPromise({ toString: () => { return this.uvprjFile.Read(); } });
        const targets = doc['Project']['Targets']['Target'];

        // init uVsion info
        this.uVsionFileInfo.schemaVersion = doc['Project']['SchemaVersion'];

        if (Array.isArray(targets)) {
            for (const target of targets) {
                this.targetList.push(Target.getInstance(this, this.uVsionFileInfo, target));
            }
        } else {
            this.targetList.push(Target.getInstance(this, this.uVsionFileInfo, targets));
        }

        for (const target of this.targetList) {
            await target.load();
            target.on('dataChanged', () => this.notifyUpdateView());
        }
    }

    notifyUpdateView() {
        this._event.emit('dataChanged');
    }

    close() {
        this.watcher.Close();
        this.targetList.forEach((target) => target.close());
        this.logger.log('[info] project closed: ' + this.label);
    }

    toAbsolutePath(rePath: string): string {
        const path = rePath.replace(/\//g, File.sep);
        if (/^[a-z]:/i.test(path)) {
            return node_path.normalize(path);
        }
        return node_path.normalize(this.uvprjFile.dir + File.sep + path);
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

    private static warnedCppConfigs: Set<string> = new Set();

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
    private uv4LogLockFileWatcher: FileWatcher;

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
        this.cppConfigName = node_path.dirname(projectPath) === '.' ? this.targetName : `${projectPath.replace(/\\/g, '/')}: ${this.targetName}`;
        this.includes = new Set();
        this.defines = new Set();
        this.fGroups = [];
        this.uv4LogFile = new File(this.project.vscodeDir.path + File.sep + 'uv4.log');
        this.uv4LogLockFileWatcher = new FileWatcher(new File(this.uv4LogFile.path + '.lock'));

        if (!this.uv4LogLockFileWatcher.file.IsFile()) { // create file if not existed
            this.uv4LogLockFileWatcher.file.Write('');
        }

        this.uv4LogLockFileWatcher.Watch();
        this.uv4LogLockFileWatcher.OnChanged = () => this.updateSourceRefs();
        this.uv4LogLockFileWatcher.on('error', () => {

            this.uv4LogLockFileWatcher.Close();

            if (!this.uv4LogLockFileWatcher.file.IsFile()) { // create file if not existed
                this.uv4LogLockFileWatcher.file.Write('');
            }

            this.uv4LogLockFileWatcher.Watch();
        });
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

    private getDefCppProperties(): any {
        return {
            configurations: [
                {
                    name: this.cppConfigName,
                    includePath: undefined,
                    defines: undefined,
                    intelliSenseMode: '${default}'
                }
            ],
            version: 4
        };
    }

    private updateCppProperties() {

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this.project.uvprjFile.path));
        const configDir = new File(node_path.join(workspaceFolder ? workspaceFolder.uri.fsPath : this.project.uvprjFile.dir, '.vscode'));
        configDir.CreateDir();
        const proFile = new File(node_path.join(configDir.path, 'c_cpp_properties.json'));
        let obj: any;

        if (proFile.IsFile()) {
            try {
                obj = JSON.parse(proFile.Read());
            } catch (error) {
                this.project.logger.log(error);
                this.warnCppConfig(proFile.path);
                return;
            }
        } else {
            obj = this.getDefCppProperties();
        }

        const configList: any[] = obj['configurations'];
        if (!Array.isArray(configList)) {
            this.warnCppConfig(proFile.path);
            return;
        }
        const index = configList.findIndex((conf) => { return conf.name === this.cppConfigName; });

        if (index === -1) {
            configList.push({
                name: this.cppConfigName,
                includePath: Array.from(this.includes).concat(['${default}']),
                defines: Array.from(this.defines),
                intelliSenseMode: '${default}'
            });
        } else {
            configList[index]['includePath'] = Array.from(this.includes).concat(['${default}']);
            configList[index]['defines'] = Array.from(this.defines);
        }

        proFile.Write(JSON.stringify(obj, undefined, 4));
    }

    private warnCppConfig(path: string) {
        if (!Target.warnedCppConfigs.has(path)) {
            Target.warnedCppConfigs.add(path);
            vscode.window.showWarningMessage(`Keil Assistant could not update ${path}. Check its JSON format; the existing file was kept.`);
        }
    }

    async load(): Promise<void> {

        // check target is valid
        const err = this.checkProject(this.targetDOM);
        if (err) { throw err; }

        const incListStr: string = this.getIncString(this.targetDOM);
        const defineListStr: string = this.getDefineString(this.targetDOM);
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

        this.updateCppProperties();

        this.updateSourceRefs();
    }

    private runTask(name: string, commands: string[]) {

        const resManager = ResourceManager.getInstance();
        const builderPath = resManager.getBuilderExe();
        const uv4PathIndex = commands.indexOf('--uv4Path');
        const uv4Path = uv4PathIndex >= 0 ? commands[uv4PathIndex + 1] : undefined;
        if (!new File(builderPath).IsFile()) {
            vscode.window.showErrorMessage(`Keil Assistant builder was not found: ${builderPath}`);
            return;
        }
        if (!uv4Path || !new File(uv4Path).IsFile()) {
            vscode.window.showErrorMessage('Keil UV4.exe was not found. Set KeilAssistant.MDK.Uv4Path or KeilAssistant.C51.Uv4Path in VS Code settings.');
            return;
        }

        const args = ['-o', this.uv4LogFile.path].concat(commands);

        // use task
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {

            const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this.project.uvprjFile.path));
            const task = new vscode.Task({ type: 'keil-task' }, workspaceFolder || vscode.TaskScope.Global,
                `${name}: ${this.project.uvprjFile.name} / ${this.targetName}`, 'Keil Assistant');
            task.execution = new vscode.ProcessExecution(builderPath, args, { cwd: this.project.uvprjFile.dir });
            task.isBackground = false;
            task.problemMatchers = this.getProblemMatcher();
            task.presentationOptions = {
                echo: false,
                focus: false,
                clear: true
            };
            vscode.tasks.executeTask(task).then(undefined, (error) => {
                vscode.window.showErrorMessage(`Keil ${name} failed to start: ${error.message}`);
            });

        } else {

            const index = vscode.window.terminals.findIndex((ter) => {
                return ter.name === name;
            });

            if (index !== -1) {
                vscode.window.terminals[index].hide();
                vscode.window.terminals[index].dispose();
            }

            const isCmd = /cmd.exe$/i.test(vscode.env.shell);
            const quoteArg = (arg: string) => isCmd ? `"${arg.replace(/"/g, '""')}"` : `'${arg.replace(/'/g, "''")}'`;
            const commandLine = (isCmd ? '' : '& ') + [builderPath].concat(args).map(quoteArg).join(' ');
            const terminal = vscode.window.createTerminal(name);
            terminal.show();
            terminal.sendText(commandLine);
        }
    }

    build() {
        this.runTask('build', this.getBuildCommand());
    }

    rebuild() {
        this.runTask('rebuild', this.getRebuildCommand());
    }

    download() {
        this.runTask('download', this.getDownloadCommand());
    }

    updateSourceRefs() {
        const rePath = this.getOutputFolder(this.targetDOM);
        if (rePath) {
            const outPath = this.project.toAbsolutePath(rePath);
            this.fGroups.forEach((group) => {
                group.sources.forEach((source) => {
                    if (source.enable) { // if source not disabled
                        const refFile = File.fromArray([outPath, source.file.noSuffixName + '.d']);
                        if (refFile.IsFile()) {
                            const refFileList = this.parseRefLines(this.targetDOM, refFile.Read().split(/\r\n|\n/))
                                .map((rePath) => { return this.project.toAbsolutePath(rePath); });
                            source.children = refFileList.map((refFilePath) => {
                                return new Source(source.prjID, new File(refFilePath));
                            });
                        }
                    }
                });
            });
            this._event.emit('dataChanged');
        }
    }

    close() {
        this.uv4LogLockFileWatcher.Close();
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
            return new Error(`This uVision project is not a C51 project, but have a 'uvproj' suffix !`);
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
        return target51['VariousControls']['IncludePath'];
    }

    protected getDefineString(target: any): string {
        const target51 = target['TargetOption']['Target51']['C51'];
        return target51['VariousControls']['Define'];
    }

    protected getGroups(target: any): any[] {
        return target['Groups']['Group'] || [];
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

    private static armclangBuildinMacros: string[] | undefined;

    constructor(prjInfo: KeilProjectInfo, uvInfo: uVisonInfo, targetDOM: any) {
        super(prjInfo, uvInfo, targetDOM);
        if (targetDOM['uAC6'] === '1') {
            ArmTarget.initArmclangMacros();
        }
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

    private static initArmclangMacros() {
        if (ArmTarget.armclangBuildinMacros === undefined) {
            const armClangPath = node_path.dirname(node_path.dirname(ResourceManager.getInstance().getArmUV4Path()))
                + File.sep + 'ARM' + File.sep + 'ARMCLANG' + File.sep + 'bin' + File.sep + 'armclang.exe';
            ArmTarget.armclangBuildinMacros = ArmTarget.getArmClangMacroList(armClangPath);
        }
    }

    protected getSysDefines(target: any): string[] {
        if (target['uAC6'] === '1') { // ARMClang
            return ArmTarget.armclangMacros.concat(ArmTarget.armclangBuildinMacros || []);
        } else { // ARMCC
            return ArmTarget.armccMacros;
        }
    }

    private static getArmClangMacroList(armClangPath: string): string[] {
        try {
            const cmdLine = CmdLineHandler.quoteString(armClangPath, '"')
                + ' ' + ['--target=arm-arm-none-eabi', '-E', '-dM', '-', '<nul'].join(' ');

            const lines = child_process.execSync(cmdLine).toString().split(/\r\n|\n/);
            const resList: string[] = [];
            const mHandler = new MacroHandler();

            lines.filter((line) => { return line.trim() !== ''; })
                .forEach((line) => {
                    const value = mHandler.toExpression(line);
                    if (value) {
                        resList.push(value);
                    }
                });

            return resList;
        } catch (error) {
            return ['__GNUC__=4', '__GNUC_MINOR__=2', '__GNUC_PATCHLEVEL__=1'];
        }
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
        return dat['VariousControls']['IncludePath'];
    }

    protected getDefineString(target: any): string {
        const dat = target['TargetOption']['TargetArmAds']['Cads'];
        return dat['VariousControls']['Define'];
    }

    protected getGroups(target: any): any[] {
        return target['Groups']['Group'] || [];
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

class ProjectExplorer implements vscode.TreeDataProvider<IView> {

    private ItemClickCommand: string = 'Item.Click';
    private readonly savedProjectsKey = 'KeilAssistant.SelectedProjects';
    private readonly discoveryPromptedKey = 'KeilAssistant.DiscoveryPrompted';
    private readonly context: vscode.ExtensionContext;

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
                vscode.window.showErrorMessage(`Open Keil project failed: ${projectPath}. ${(<Error>error).message}`);
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
                vscode.window.showErrorMessage(`Open Keil project failed: ${nested[0]}. ${(<Error>error).message}`);
            }
        } else if (nested.length > 0 && (forcePrompt || !this.context.workspaceState.get<boolean>(this.discoveryPromptedKey, false))) {
            const choices = nested.map((path) => {
                const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(path));
                return { label: folder ? node_path.relative(folder.uri.fsPath, path) : path,
                    description: folder ? folder.name : '', projectPath: path };
            });
            const selected = await vscode.window.showQuickPick(choices, {
                canPickMany: true,
                placeHolder: 'Select Keil projects to load; the current VS Code workspace stays open'
            });
            await this.context.workspaceState.update(this.discoveryPromptedKey, true);
            if (selected) {
                for (const choice of selected) {
                    try {
                        await this.openProject(choice.projectPath);
                        await this.rememberProject(choice.projectPath);
                    } catch (error) {
                        vscode.window.showErrorMessage(`Open Keil project failed: ${choice.projectPath}. ${(<Error>error).message}`);
                    }
                }
            }
        } else if (forcePrompt && nested.length === 0) {
            vscode.window.showInformationMessage('No additional Keil projects were found in this workspace.');
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
            throw new Error(`Project file does not exist: ${fullPath}`);
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

    async activeProject(view: IView) {
        const project = this.prjList.get(view.prjID);
        if (project) {
            this.currentActiveProject?.deactive();
            this.currentActiveProject = project;
            this.currentActiveProject?.active();
            this.updateView();
        }
    }

    async switchTargetByProject(view: IView) {
        const prj = this.prjList.get(view.prjID);
        if (prj) {
            const tList = prj.getTargets();
            const targetName = await vscode.window.showQuickPick(tList.map((ele) => { return ele.targetName; }), {
                canPickMany: false,
                placeHolder: 'please select a target name for keil project'
            });
            if (targetName) {
                prj.setActiveTarget(targetName);
            }
        }
    }

    async createGroup(view?: IView) {
        try {
            const project = view ? this.prjList.get(view.prjID) : this.currentActiveProject;
            const target = view?.contextVal === 'Target' ? project?.getTargetByName(view.label) : project?.getActiveTarget();
            if (!project || !target) {
                vscode.window.showWarningMessage('Open a Keil project and select a target first.');
                return;
            }
            const name = await vscode.window.showInputBox({
                prompt: `New group in ${project.label} / ${target.targetName}`,
                placeHolder: 'Group name, for example Application/User',
                validateInput: (value) => {
                    if (!value.trim()) { return 'Enter a group name.'; }
                    if (/[\u0000-\u001f]/.test(value)) { return 'Control characters are not allowed.'; }
                    return undefined;
                }
            });
            if (name === undefined) { return; }
            if (!await vscode.workspace.saveAll()) { return; }
            const result = await createGroupInKeilProject(project.uvprjFile.path, target.targetName, name);
            if (result.status === 'already-present') {
                vscode.window.showInformationMessage(`Keil group ${name.trim()} already exists in ${target.targetName}.`);
            } else {
                await project.reload();
                vscode.window.showInformationMessage(`Created Keil group ${name.trim()} in ${target.targetName}.`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Could not create the Keil group: ${(<Error>error).message}`);
        }
    }

    async removeFile(item: Source) {
        if (!(item instanceof Source) || !item.targetName || !item.groupName) { return; }
        const project = this.prjList.get(item.prjID);
        if (!project) { return; }
        try {
            if (!await vscode.workspace.saveAll()) { return; }
            const result = await removeFileFromKeilProject(project.uvprjFile.path,
                item.targetName, item.groupName, item.file.path);
            if (result.status === 'not-present') {
                vscode.window.showInformationMessage(`${item.label} is no longer in ${item.targetName} / ${item.groupName}.`);
            } else {
                await project.reload();
                vscode.window.showInformationMessage(`Removed ${item.label} from the Keil project. The disk file was kept.`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Could not remove the file from the Keil project: ${(<Error>error).message}`);
        }
    }

    async addFileToGroup(item: FileGroup) {
        if (!(item instanceof FileGroup)) { return; }
        const project = this.prjList.get(item.prjID);
        const target = project?.getTargetByName(item.targetName);
        const group = target?.getFileGroups().find((candidate) => candidate.label === item.label);
        if (!project || !target || !group) { return; }
        try {
            const selected = await vscode.window.showOpenDialog({
                openLabel: `Add to ${item.label}`,
                canSelectFolders: false,
                canSelectMany: false,
                filters: { 'C source and header': ['c', 'h'] }
            });
            const sourcePath = selected && selected[0]?.fsPath;
            if (!sourcePath) { return; }
            if (!/\.(c|h)$/i.test(sourcePath) || !new File(sourcePath).IsFile()) {
                vscode.window.showWarningMessage('Choose a saved .c or .h file.');
                return;
            }
            if (/\.c$/i.test(sourcePath) && group.excludedFromBuild) {
                vscode.window.showWarningMessage('This Keil group is excluded from build. Choose a build-enabled group for the .c file.');
                return;
            }
            if (!await vscode.workspace.saveAll()) { return; }
            const result = await addFileToKeilProject(project.uvprjFile.path, target.targetName, group.label, sourcePath);
            if (result.status === 'already-present') {
                vscode.window.showInformationMessage(`${node_path.basename(sourcePath)} is already in ${target.targetName} / ${result.groupName}.`);
            } else {
                await project.reload();
                vscode.window.showInformationMessage(`Added ${node_path.basename(sourcePath)} to ${target.targetName} / ${group.label}.`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Could not add the file to the Keil group: ${(<Error>error).message}`);
        }
    }

    async addFileFromVSCode(uri?: vscode.Uri) {
        try {
            let sourceUri = uri;
            if (!sourceUri || sourceUri.scheme !== 'file') {
                const editorUri = vscode.window.activeTextEditor?.document.uri;
                sourceUri = editorUri && editorUri.scheme === 'file' ? editorUri : undefined;
            }
            if (!sourceUri) {
                const selected = await vscode.window.showOpenDialog({
                    openLabel: 'Add to Keil project',
                    canSelectFolders: false,
                    canSelectMany: false,
                    filters: { 'C source and header': ['c', 'h'] }
                });
                sourceUri = selected && selected[0];
            }
            if (!sourceUri) { return; }
            const sourcePath = sourceUri.fsPath;
            if (!/\.(c|h)$/i.test(sourcePath) || !new File(sourcePath).IsFile()) {
                vscode.window.showWarningMessage('Choose a saved .c or .h file to add to the Keil project.');
                return;
            }

            if (!this.prjList.size) { await this.loadWorkspace(); }
            const projects = Array.from(this.prjList.values());
            if (!projects.length) {
                vscode.window.showWarningMessage('Open a Keil .uvproj or .uvprojx project first.');
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
                    placeHolder: 'Select the Keil project for this file'
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
                })), { placeHolder: 'Select the Keil target to update' });
                target = selected?.target;
            }
            if (!target) { return; }

            const isCSource = /\.c$/i.test(sourcePath);
            const groups = target.getFileGroups().filter((group) => !isCSource || !group.excludedFromBuild);
            if (!groups.length) {
                vscode.window.showWarningMessage('No build-enabled Keil group is available in this target.');
                return;
            }
            let group: FileGroup | undefined;
            if (groups.length === 1) {
                group = groups[0];
            } else {
                const selected = await vscode.window.showQuickPick(groups.map((item) => ({
                    label: item.label,
                    description: item.excludedFromBuild ? 'Excluded from build' : '',
                    group: item
                })), { placeHolder: 'Select the Keil group for this file' });
                group = selected?.group;
            }
            if (!group) { return; }
            if (!await vscode.workspace.saveAll()) { return; }

            const result = await addFileToKeilProject(project.uvprjFile.path, target.targetName, group.label, sourcePath);
            if (result.status === 'already-present') {
                vscode.window.showInformationMessage(`${node_path.basename(sourcePath)} is already in ${target.targetName} / ${result.groupName}.`);
            } else {
                await project.reload();
                vscode.window.showInformationMessage(`Added ${node_path.basename(sourcePath)} to ${target.targetName} / ${group.label}.`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Could not add the file to the Keil project: ${(<Error>error).message}`);
        }
    }

    getTarget(view?: IView): Target | undefined {
        if (view) {
            const prj = this.prjList.get(view.prjID);
            if (prj) {
                const targets = prj.getTargets();
                const index = targets.findIndex((target) => { return target.targetName === view.label; });
                if (index !== -1) {
                    return targets[index];
                }
            }
        } else { // get active target
            if (this.currentActiveProject) {
                return this.currentActiveProject.getActiveTarget();
            } else {
                vscode.window.showWarningMessage('Not found any active project !');
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
                        vscode.window.showWarningMessage(`Not found file: ${source.file.path}`);
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
            return element.getChildViews();
        }
    }
}
