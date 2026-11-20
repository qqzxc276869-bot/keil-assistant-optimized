import * as crypto from 'crypto';
import * as fs from 'fs';
import * as node_path from 'path';
import * as xml2js from 'xml2js';

export interface AddFileResult {
    status: 'added' | 'already-present';
    groupName: string;
}

// uVision's FileType values are stored in .uvproj/.uvprojx, independent of
// filename case. Keep this list shared with the VS Code file picker.
const KEIL_FILE_TYPES: { [extension: string]: string } = {
    '.c': '1',
    '.s': '2', '.asm': '2', '.a51': '2', '.a66': '2',
    '.lib': '4',
    '.h': '5', '.hpp': '5', '.hxx': '5', '.hh': '5', '.inc': '5',
    '.cpp': '8', '.cc': '8', '.cxx': '8', '.c++': '8'
};

export const SUPPORTED_KEIL_FILE_EXTENSIONS: readonly string[] = Object.keys(KEIL_FILE_TYPES);

export function getKeilFileType(sourcePath: string): string | undefined {
    return KEIL_FILE_TYPES[node_path.extname(sourcePath).toLowerCase()];
}

export interface ProjectEditResult {
    status: 'created' | 'already-present' | 'removed' | 'not-present';
}

interface XmlElement {
    name: string;
    start: number;
    openEnd: number;
    closeStart: number;
    end: number;
    selfClosing: boolean;
    children: XmlElement[];
}

function findTagEnd(xml: string, start: number): number {
    let quote = '';
    for (let i = start + 1; i < xml.length; i++) {
        const char = xml[i];
        if (quote) {
            if (char === quote) { quote = ''; }
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === '>') {
            return i;
        }
    }
    throw new Error('Keil 工程包含未结束的 XML 标签。');
}

// Locate only element boundaries. xml2js validates and interprets the XML;
// these offsets let us insert one file without reformatting the entire project.
function scanElements(xml: string): XmlElement[] {
    const roots: XmlElement[] = [];
    const stack: XmlElement[] = [];
    let cursor = 0;
    while (cursor < xml.length) {
        const start = xml.indexOf('<', cursor);
        if (start < 0) { break; }
        if (xml.startsWith('<!--', start) || xml.startsWith('<![CDATA[', start)) {
            const marker = xml.startsWith('<!--', start) ? '-->' : ']]>';
            const end = xml.indexOf(marker, start + 4);
            if (end < 0) { throw new Error('Keil 工程包含未结束的 XML 标记。'); }
            cursor = end + marker.length;
            continue;
        }
        if (xml.startsWith('<?', start)) {
            const end = xml.indexOf('?>', start + 2);
            if (end < 0) { throw new Error('Keil 工程包含未结束的 XML 标记。'); }
            cursor = end + 2;
            continue;
        }
        if (xml.startsWith('<!', start)) {
            throw new Error('Keil 工程使用了不支持的 XML 声明，未进行修改。');
        }

        const tagEnd = findTagEnd(xml, start);
        const tag = xml.slice(start + 1, tagEnd).trim();
        if (tag.startsWith('/')) {
            const name = tag.slice(1).trim();
            const current = stack.pop();
            if (!current || current.name !== name) {
                throw new Error('Keil 工程的 XML 节点不匹配。');
            }
            current.closeStart = start;
            current.end = tagEnd + 1;
        } else {
            const match = /^([A-Za-z_][\w:.-]*)/.exec(tag);
            if (!match) { throw new Error('Keil 工程包含无效的 XML 节点。'); }
            const element: XmlElement = {
                name: match[1], start, openEnd: tagEnd + 1, closeStart: tagEnd + 1,
                end: tagEnd + 1, selfClosing: /\/\s*$/.test(tag), children: []
            };
            if (stack.length) { stack[stack.length - 1].children.push(element); }
            else { roots.push(element); }
            if (!element.selfClosing) { stack.push(element); }
        }
        cursor = tagEnd + 1;
    }
    if (stack.length) { throw new Error('Keil 工程包含未关闭的 XML 节点。'); }
    return roots;
}

function direct(parent: XmlElement, name: string): XmlElement[] {
    return parent.children.filter((child) => child.name === name);
}

function one(parent: XmlElement, name: string): XmlElement {
    const found = direct(parent, name);
    if (found.length !== 1) {
        throw new Error(`Keil 工程中需要且只能有一个 <${name}> 节点。`);
    }
    return found[0];
}

function asArray<T>(value: T | T[] | undefined): T[] {
    return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function xmlEscape(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function lineIndent(xml: string, position: number): string | undefined {
    const lineStart = xml.lastIndexOf('\n', position - 1) + 1;
    const prefix = xml.slice(lineStart, position);
    return /^[ \t]*$/.test(prefix) ? prefix : undefined;
}

function indentUnit(xml: string, parent: XmlElement, child: XmlElement | undefined): string {
    const parentIndent = lineIndent(xml, parent.start);
    const childIndent = child && lineIndent(xml, child.start);
    if (parentIndent !== undefined && childIndent !== undefined && childIndent.startsWith(parentIndent)) {
        const extra = childIndent.slice(parentIndent.length);
        if (extra) { return extra; }
    }
    return '  ';
}

function insertBeforeClose(xml: string, element: XmlElement, block: string, eol: string, closingIndent: string): string {
    const lineStart = xml.lastIndexOf('\n', element.closeStart - 1) + 1;
    const beforeClose = xml.slice(lineStart, element.closeStart);
    if (lineStart > 0 && /^[ \t]*$/.test(beforeClose)) {
        return xml.slice(0, lineStart) + block + eol + xml.slice(lineStart);
    }
    return xml.slice(0, element.closeStart) + eol + block + eol + closingIndent + xml.slice(element.closeStart);
}

function expandSelfClosingElement(xml: string, element: XmlElement, block: string, eol: string,
    closingIndent: string): string {
    const opening = xml.slice(element.start, element.openEnd).replace(/\s*\/\s*>$/, '>');
    const replacement = `${opening}${eol}${block}${eol}${closingIndent}</${element.name}>`;
    return xml.slice(0, element.start) + replacement + xml.slice(element.end);
}

function projectPathKey(projectDir: string, reference: string): string {
    const normalized = reference.replace(/[\\/]/g, node_path.sep);
    const fullPath = node_path.resolve(projectDir, normalized);
    return process.platform === 'win32' ? fullPath.toLowerCase() : fullPath;
}

function buffersEqual(left: Buffer, right: Buffer): boolean {
    return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function readUtf8Project(projectPath: string): { buffer: Buffer, xml: string } {
    const buffer = fs.readFileSync(projectPath);
    return { buffer, xml: decodeUtf8Project(buffer) };
}

function decodeUtf8Project(buffer: Buffer): string {
    const xml = buffer.toString('utf8');
    const declaration = /^\uFEFF?<\?xml[^?]*encoding\s*=\s*["']([^"']+)["']/i.exec(xml);
    if (!buffersEqual(Buffer.from(xml, 'utf8'), buffer) || (declaration && !/^utf-?8$/i.test(declaration[1]))) {
        throw new Error('Keil 工程不是 UTF-8 编码，未进行修改。');
    }
    return xml;
}

function writeProjectChange(projectPath: string, original: Buffer | undefined, updated: string): void {
    const temporaryPath = `${projectPath}.keil-assistant-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(temporaryPath, updated, { encoding: 'utf8', flag: 'wx' });
        if (original === undefined) {
            fs.copyFileSync(temporaryPath, projectPath, fs.constants.COPYFILE_EXCL);
        } else if (buffersEqual(fs.readFileSync(projectPath), original)) {
            fs.renameSync(temporaryPath, projectPath);
        } else {
            throw new Error('编辑期间 Keil 工程发生变化，请重试。');
        }
    } finally {
        if (fs.existsSync(temporaryPath)) { fs.unlinkSync(temporaryPath); }
    }
}

function projectRoot(xml: string): XmlElement {
    const root = scanElements(xml).find((element) => element.name === 'Project');
    if (!root) { throw new Error('Keil 工程中缺少 <Project> 节点。'); }
    return root;
}

function targetElement(xml: string, targetCount: number, targetIndex: number): XmlElement {
    const targets = direct(one(projectRoot(xml), 'Targets'), 'Target');
    if (targets.length !== targetCount || !targets[targetIndex]) {
        throw new Error('无法安全地匹配 Keil 编译目标结构。');
    }
    return targets[targetIndex];
}

function elementRemovalRange(xml: string, element: XmlElement): { start: number, end: number } {
    const lineStart = xml.lastIndexOf('\n', element.start - 1) + 1;
    const lineEnd = xml.indexOf('\n', element.end);
    if (lineStart > 0 && /^[ \t]*$/.test(xml.slice(lineStart, element.start)) &&
        lineEnd >= 0 && /^[ \t\r]*$/.test(xml.slice(element.end, lineEnd))) {
        return { start: lineStart, end: lineEnd + 1 };
    }
    return { start: element.start, end: element.end };
}

/** Add multiple saved files to exactly one target and group in one project write. */
export async function addFilesToKeilProject(projectPath: string, targetName: string, groupName: string,
    sourcePaths: string[]): Promise<AddFileResult[]> {
    if (!sourcePaths.length) { return []; }
    const sources = sourcePaths.map((sourcePath) => {
        const fileType = getKeilFileType(sourcePath);
        if (!fileType) {
            throw new Error(`不支持的 Keil 文件类型：${node_path.basename(sourcePath)}`);
        }
        if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
            throw new Error(`源文件不存在：${sourcePath}`);
        }
        return { path: node_path.resolve(sourcePath), fileType };
    });
    const projectDir = node_path.dirname(projectPath);
    const { buffer, xml } = readUtf8Project(projectPath);
    const parser = new xml2js.Parser({ explicitArray: false });
    const document = await parser.parseStringPromise(xml);
    const targetData = asArray<any>(document.Project && document.Project.Targets && document.Project.Targets.Target);
    const targetIndex = targetData.findIndex((target) => target.TargetName === targetName);
    if (targetIndex < 0) { throw new Error(`找不到 Keil 编译目标：${targetName}`); }
    const target = targetData[targetIndex];
    const groupData = asArray<any>(target.Groups && target.Groups.Group);
    const matchingGroups = groupData.map((group, index) => group.GroupName === groupName ? index : -1)
        .filter((index) => index >= 0);
    if (matchingGroups.length !== 1) { throw new Error(`Keil 分组不存在或名称不唯一：${groupName}`); }
    const groupIndex = matchingGroups[0];

    const knownFiles = new Map<string, string>();
    for (const group of groupData) {
        for (const files of asArray<any>(group.Files)) {
            for (const file of asArray<any>(files.File)) {
                if (typeof file.FilePath === 'string') {
                    const key = projectPathKey(projectDir, file.FilePath);
                    if (!knownFiles.has(key)) { knownFiles.set(key, group.GroupName); }
                }
            }
        }
    }

    const results: AddFileResult[] = [];
    const additions: { path: string, fileType: string }[] = [];
    for (const source of sources) {
        const key = projectPathKey(projectDir, source.path);
        const existingGroup = knownFiles.get(key);
        if (existingGroup !== undefined) {
            results.push({ status: 'already-present', groupName: existingGroup });
        } else {
            knownFiles.set(key, groupName);
            additions.push(source);
            results.push({ status: 'added', groupName });
        }
    }
    if (!additions.length) { return results; }

    const groupElements = direct(one(targetElement(xml, targetData.length, targetIndex), 'Groups'), 'Group');
    if (groupElements.length !== groupData.length) {
        throw new Error('无法安全地匹配 Keil 分组结构。');
    }
    const groupElement = groupElements[groupIndex];
    const groupNameElement = one(groupElement, 'GroupName');
    const eol = xml.includes('\r\n') ? '\r\n' : '\n';
    const unit = indentUnit(xml, groupElement, groupNameElement);
    const groupIndent = lineIndent(xml, groupElement.start) || '';
    const filesElement = direct(groupElement, 'Files')[0];
    if (direct(groupElement, 'Files').length > 1) {
        throw new Error('所选 Keil 分组包含多个 <Files> 节点。');
    }
    const filesIndent = filesElement ? (lineIndent(xml, filesElement.start) || groupIndent + unit) : groupIndent + unit;
    const existingFile = filesElement && direct(filesElement, 'File')[0];
    const fileIndent = existingFile ? (lineIndent(xml, existingFile.start) || filesIndent + unit) : filesIndent + unit;
    const fieldIndent = fileIndent + unit;
    const fileBlocks = additions.map((source) => {
        const fileName = xmlEscape(node_path.basename(source.path));
        const relativePath = xmlEscape(node_path.relative(projectDir, source.path).replace(/\//g, '\\'));
        return `${fileIndent}<File>${eol}` +
            `${fieldIndent}<FileName>${fileName}</FileName>${eol}` +
            `${fieldIndent}<FileType>${source.fileType}</FileType>${eol}` +
            `${fieldIndent}<FilePath>${relativePath}</FilePath>${eol}` +
            `${fileIndent}</File>`;
    }).join(eol);

    let updated: string;
    if (!filesElement) {
        const filesBlock = `${filesIndent}<Files>${eol}${fileBlocks}${eol}${filesIndent}</Files>`;
        updated = insertBeforeClose(xml, groupElement, filesBlock, eol, groupIndent);
    } else if (filesElement.selfClosing) {
        updated = expandSelfClosingElement(xml, filesElement, fileBlocks, eol, filesIndent);
    } else {
        updated = insertBeforeClose(xml, filesElement, fileBlocks, eol, filesIndent);
    }

    const after = await parser.parseStringPromise(updated);
    const afterTargets = asArray<any>(after.Project.Targets.Target);
    const afterGroups = asArray<any>(afterTargets[targetIndex].Groups.Group);
    const afterFiles = asArray<any>(afterGroups[groupIndex].Files.File);
    for (const source of additions) {
        const storedPath = node_path.relative(projectDir, source.path).replace(/\//g, '\\');
        if (!afterFiles.some((file) => file.FileName === node_path.basename(source.path) &&
            file.FileType === source.fileType && file.FilePath === storedPath)) {
            throw new Error('无法验证修改后的 Keil 工程，未保存更改。');
        }
    }

    writeProjectChange(projectPath, buffer, updated);
    return results;
}

/** Preserve the single-file API for existing extension commands and callers. */
export async function addFileToKeilProject(projectPath: string, targetName: string, groupName: string,
    sourcePath: string): Promise<AddFileResult> {
    const results = await addFilesToKeilProject(projectPath, targetName, groupName, [sourcePath]);
    return results[0];
}

/** Create a virtual Keil group in one target. No disk folder is created. */
export async function createGroupInKeilProject(projectPath: string, targetName: string,
    groupName: string): Promise<ProjectEditResult> {
    const name = groupName.trim();
    if (!name || /[\u0000-\u001f]/.test(name)) {
        throw new Error('Keil 分组名不能为空，也不能包含控制字符。');
    }
    const { buffer, xml } = readUtf8Project(projectPath);
    const parser = new xml2js.Parser({ explicitArray: false });
    const document = await parser.parseStringPromise(xml);
    const targets = asArray<any>(document.Project && document.Project.Targets && document.Project.Targets.Target);
    const targetIndex = targets.findIndex((target) => target.TargetName === targetName);
    if (targetIndex < 0) { throw new Error(`找不到 Keil 编译目标：${targetName}`); }
    const groups = asArray<any>(targets[targetIndex].Groups && targets[targetIndex].Groups.Group);
    if (groups.some((group) => group.GroupName === name)) {
        return { status: 'already-present' };
    }

    const target = targetElement(xml, targets.length, targetIndex);
    const targetNameElement = one(target, 'TargetName');
    const eol = xml.includes('\r\n') ? '\r\n' : '\n';
    const unit = indentUnit(xml, target, targetNameElement);
    const targetIndent = lineIndent(xml, target.start) || '';
    const groupsElements = direct(target, 'Groups');
    if (groupsElements.length > 1) { throw new Error('Keil 编译目标包含多个 <Groups> 节点。'); }
    const groupsElement = groupsElements[0];
    if (groupsElement && direct(groupsElement, 'Group').length !== groups.length) {
        throw new Error('无法安全地匹配 Keil 分组结构。');
    }
    const groupsIndent = groupsElement ? (lineIndent(xml, groupsElement.start) || targetIndent + unit) : targetIndent + unit;
    const firstGroup = groupsElement && direct(groupsElement, 'Group')[0];
    const groupIndent = firstGroup ? (lineIndent(xml, firstGroup.start) || groupsIndent + unit) : groupsIndent + unit;
    const groupBlock = `${groupIndent}<Group>${eol}` +
        `${groupIndent}${unit}<GroupName>${xmlEscape(name)}</GroupName>${eol}` +
        `${groupIndent}</Group>`;

    let updated: string;
    if (!groupsElement) {
        const block = `${groupsIndent}<Groups>${eol}${groupBlock}${eol}${groupsIndent}</Groups>`;
        updated = insertBeforeClose(xml, target, block, eol, targetIndent);
    } else if (groupsElement.selfClosing) {
        updated = expandSelfClosingElement(xml, groupsElement, groupBlock, eol, groupsIndent);
    } else {
        updated = insertBeforeClose(xml, groupsElement, groupBlock, eol, groupsIndent);
    }

    const after = await parser.parseStringPromise(updated);
    const afterTargets = asArray<any>(after.Project.Targets.Target);
    const afterGroups = asArray<any>(afterTargets[targetIndex].Groups.Group);
    if (afterGroups.length !== groups.length + 1 || !afterGroups.some((group) => group.GroupName === name)) {
        throw new Error('无法验证新建的 Keil 分组，工程未保存。');
    }
    writeProjectChange(projectPath, buffer, updated);
    return { status: 'created' };
}

/** Remove a virtual group and its project references, leaving disk files untouched. */
export async function removeGroupFromKeilProject(projectPath: string, targetName: string,
    groupName: string): Promise<ProjectEditResult> {
    const { buffer, xml } = readUtf8Project(projectPath);
    const parser = new xml2js.Parser({ explicitArray: false });
    const document = await parser.parseStringPromise(xml);
    const targets = asArray<any>(document.Project && document.Project.Targets && document.Project.Targets.Target);
    const targetIndex = targets.findIndex((target) => target.TargetName === targetName);
    if (targetIndex < 0) { throw new Error(`找不到 Keil 编译目标：${targetName}`); }
    const groups = asArray<any>(targets[targetIndex].Groups && targets[targetIndex].Groups.Group);
    const matches = groups.map((group, index) => group.GroupName === groupName ? index : -1)
        .filter((index) => index >= 0);
    if (!matches.length) { return { status: 'not-present' }; }
    if (matches.length !== 1) { throw new Error(`Keil 分组名称不唯一：${groupName}`); }
    const target = targetElement(xml, targets.length, targetIndex);
    const groupElements = direct(one(target, 'Groups'), 'Group');
    if (groupElements.length !== groups.length) { throw new Error('无法安全地匹配 Keil 分组结构。'); }
    const range = elementRemovalRange(xml, groupElements[matches[0]]);
    const updated = xml.slice(0, range.start) + xml.slice(range.end);
    const after = await parser.parseStringPromise(updated);
    const afterTargets = asArray<any>(after.Project.Targets.Target);
    const afterGroupContainer = afterTargets[targetIndex].Groups;
    const afterGroups = asArray<any>(afterGroupContainer && typeof afterGroupContainer === 'object' ?
        afterGroupContainer.Group : undefined);
    if (afterGroups.length !== groups.length - 1 || afterGroups.some((group) => group.GroupName === groupName)) {
        throw new Error('无法验证已删除的 Keil 分组，工程未保存。');
    }
    writeProjectChange(projectPath, buffer, updated);
    return { status: 'removed' };
}

/** Remove one reference from a Keil group; the source file on disk is kept. */
export async function removeFileFromKeilProject(projectPath: string, targetName: string,
    groupName: string, sourcePath: string): Promise<ProjectEditResult> {
    const { buffer, xml } = readUtf8Project(projectPath);
    const parser = new xml2js.Parser({ explicitArray: false });
    const document = await parser.parseStringPromise(xml);
    const targets = asArray<any>(document.Project && document.Project.Targets && document.Project.Targets.Target);
    const targetIndex = targets.findIndex((target) => target.TargetName === targetName);
    if (targetIndex < 0) { throw new Error(`找不到 Keil 编译目标：${targetName}`); }
    const groups = asArray<any>(targets[targetIndex].Groups && targets[targetIndex].Groups.Group);
    const groupIndexes = groups.map((group, index) => group.GroupName === groupName ? index : -1)
        .filter((index) => index >= 0);
    if (groupIndexes.length !== 1) { throw new Error(`Keil 分组不存在或名称不唯一：${groupName}`); }
    const groupIndex = groupIndexes[0];
    const filesData = asArray<any>(groups[groupIndex].Files);
    if (filesData.length > 1) { throw new Error('所选分组包含多个 <Files> 节点。'); }
    const entries = filesData.length ? asArray<any>(filesData[0].File) : [];
    const projectDir = node_path.dirname(projectPath);
    const sourceKey = projectPathKey(projectDir, sourcePath);
    const matches = entries.map((file, index) =>
        typeof file.FilePath === 'string' && projectPathKey(projectDir, file.FilePath) === sourceKey ? index : -1)
        .filter((index) => index >= 0);
    if (matches.length === 0) { return { status: 'not-present' }; }
    if (matches.length > 1) { throw new Error('所选分组中存在该文件的重复引用。'); }

    const target = targetElement(xml, targets.length, targetIndex);
    const groupElements = direct(one(target, 'Groups'), 'Group');
    if (groupElements.length !== groups.length) {
        throw new Error('无法安全地匹配 Keil 分组结构。');
    }
    const filesElement = one(groupElements[groupIndex], 'Files');
    const fileElements = direct(filesElement, 'File');
    if (fileElements.length !== entries.length) {
        throw new Error('无法安全地匹配 Keil 文件结构。');
    }
    const range = elementRemovalRange(xml, fileElements[matches[0]]);
    const updated = xml.slice(0, range.start) + xml.slice(range.end);

    const after = await parser.parseStringPromise(updated);
    const afterTargets = asArray<any>(after.Project.Targets.Target);
    const afterGroups = asArray<any>(afterTargets[targetIndex].Groups.Group);
    const afterFilesData = asArray<any>(afterGroups[groupIndex].Files);
    const afterEntries = afterFilesData.length ? asArray<any>(afterFilesData[0].File) : [];
    if (afterEntries.some((file) => typeof file.FilePath === 'string' &&
        projectPathKey(projectDir, file.FilePath) === sourceKey)) {
        throw new Error('无法验证已移除的 Keil 文件引用，工程未保存。');
    }
    writeProjectChange(projectPath, buffer, updated);
    return { status: 'removed' };
}

function includePathText(value: any): string {
    if (typeof value === 'string') { return value; }
    if (value && typeof value === 'object' && (value._ === undefined || typeof value._ === 'string')) {
        return value._ || '';
    }
    if (value === undefined) { return ''; }
    throw new Error('所选 Keil 头文件路径包含不支持的 XML 内容。');
}

export interface KeilDownloadConfiguration {
    cpuDll: string;
    mode: 'debug' | 'external' | 'separate';
    driver: string;
}

function readOptionsBuffer(optionsPath: string): Buffer | undefined {
    try { return fs.readFileSync(optionsPath); }
    catch (error) {
        if ((<NodeJS.ErrnoException>error).code === 'ENOENT') { return undefined; }
        throw error;
    }
}

async function findNamedTarget(xml: string, optionsFile: boolean, name: string, allowMissing = false):
    Promise<{ data: any; index: number; count: number }> {
    const document = await xml2js.parseStringPromise(xml, { explicitArray: false });
    const root = optionsFile ? document.ProjectOpt : document.Project?.Targets;
    if (!root || typeof root !== 'object') { throw new Error('无法读取 Keil 工程的 Target 列表。'); }
    const targets = asArray<any>(root.Target);
    const matches = targets.map((target, index) => target.TargetName === name ? index : -1).filter((index) => index >= 0);
    if (matches.length > 1 || (!matches.length && !allowMissing)) {
        throw new Error('找不到唯一的 Keil Target：' + name);
    }
    const index = matches.length ? matches[0] : -1;
    return { data: targets[index], index, count: targets.length };
}

function keilOptionsPath(projectPath: string): string {
    if (node_path.extname(projectPath).toLowerCase() !== '.uvprojx') {
        throw new Error('切换下载工具适用于 Keil MDK 的 .uvprojx 工程。');
    }
    return projectPath.slice(0, -'.uvprojx'.length) + '.uvoptx';
}

function flashMode(utilities: any): KeilDownloadConfiguration['mode'] {
    if (includePathText(utilities?.Flash1?.UseExternalTool) === '1') { return 'external'; }
    return includePathText(utilities?.Flash1?.UseTargetDll) === '1' &&
        includePathText(utilities?.bUseTDR) === '1' ? 'debug' : 'separate';
}

export async function readKeilDownloadConfiguration(projectPath: string, targetName: string):
    Promise<KeilDownloadConfiguration> {
    const optionsPath = keilOptionsPath(projectPath);
    // Release the file handle before awaiting XML parsing. Windows can reject a
    // simultaneous atomic project rename while an asynchronous read is pending.
    const { xml: projectXml } = readUtf8Project(projectPath);
    const { data } = await findNamedTarget(projectXml, false, targetName);
    const options = data.TargetOption;
    const utilities = options?.Utilities;
    const mode = flashMode(utilities);
    const fallback = includePathText(utilities?.Flash2).trim();
    let driver = mode === 'external' ? '' : fallback;
    if (mode === 'debug') {
        const buffer = readOptionsBuffer(optionsPath);
        if (buffer) {
            const opt = await findNamedTarget(decodeUtf8Project(buffer), true, targetName, true);
            driver = includePathText(opt.data?.TargetOption?.DebugOpt?.pMon).trim() || fallback;
        }
    }
    return { cpuDll: (includePathText(options?.DllOption?.TargetDllName) ||
        includePathText(options?.DllOption?.SimDllName)).trim(), mode, driver };
}

function replaceElementText(xml: string, element: XmlElement, value: string): string {
    const content = xml.slice(element.openEnd, element.closeStart);
    if (element.children.length || content.includes('<')) {
        throw new Error('无法安全编辑 Keil 的 <' + element.name + '> 节点。');
    }
    const start = element.selfClosing ?
        xml.slice(element.start, element.openEnd).replace(/\s*\/\s*>$/, '>') :
        xml.slice(element.start, element.openEnd);
    return xml.slice(0, element.start) + start + xmlEscape(value) + '</' + element.name + '>' + xml.slice(element.end);
}

function optionsRoot(xml: string): XmlElement {
    const root = scanElements(xml).find((element) => element.name === 'ProjectOpt');
    if (!root) { throw new Error('Keil 选项中缺少 <ProjectOpt> 节点。'); }
    return root;
}

/** Change the debug dropdown and make Flash download follow it. Keep the other drivers' settings. */
export async function setKeilDownloadDriver(projectPath: string, targetName: string, dll: string,
    generateOptions: (device: string) => Promise<string>, beforeWrite: () => void = () => {}): Promise<boolean> {
    if (!/\.dll$/i.test(dll) || /[\u0000-\u001f]/.test(dll)) { throw new Error('无效的 Keil 下载驱动路径。'); }
    const optionsPath = keilOptionsPath(projectPath);
    const project = readUtf8Project(projectPath);
    const target = await findNamedTarget(project.xml, false, targetName);
    let nextProject = project.xml;
    if (flashMode(target.data.TargetOption?.Utilities) !== 'debug') {
        const record = targetElement(project.xml, target.count, target.index);
        const utilities = one(one(record, 'TargetOption'), 'Utilities');
        const flash = one(utilities, 'Flash1');
        const flags = [
            { element: one(flash, 'UseTargetDll'), value: '1' },
            { element: one(flash, 'UseExternalTool'), value: '0' },
            { element: one(utilities, 'bUseTDR'), value: '1' }
        ];
        for (const flag of flags.sort((a, b) => b.element.start - a.element.start)) {
            nextProject = replaceElementText(nextProject, flag.element, flag.value);
        }
    }

    const originalOptions = readOptionsBuffer(optionsPath);
    let optionsXml = originalOptions ? decodeUtf8Project(originalOptions) : '';
    const optTarget = optionsXml ? await findNamedTarget(optionsXml, true, targetName, true) : undefined;
    if (!optTarget?.data) {
        const device = includePathText(target.data.TargetOption?.TargetCommonOption?.Device).trim();
        if (!device) { throw new Error('Keil 工程没有设备名称，无法生成默认调试选项。'); }
        const generated = await generateOptions(device);
        const templateTarget = one(optionsRoot(generated), 'Target');
        const updatedTemplate = replaceElementText(generated, one(templateTarget, 'TargetName'), targetName);
        if (optionsXml) {
            // Add the new Target before top-level Group records, as required by Keil's options format.
            const named = one(optionsRoot(updatedTemplate), 'Target');
            const root = optionsRoot(optionsXml);
            const eol = optionsXml.includes('\r\n') ? '\r\n' : '\n';
            const block = updatedTemplate.slice(named.start, named.end).replace(/\r?\n/g, eol);
            const beforeGroup = direct(root, 'Group')[0];
            optionsXml = beforeGroup ?
                optionsXml.slice(0, beforeGroup.start) + block + eol + '  ' + optionsXml.slice(beforeGroup.start) :
                insertBeforeClose(optionsXml, root, '  ' + block, eol, '');
        } else {
            optionsXml = updatedTemplate;
        }
    }
    const opt = await findNamedTarget(optionsXml, true, targetName);
    const optionTargets = direct(optionsRoot(optionsXml), 'Target');
    if (optionTargets.length !== opt.count) { throw new Error('无法匹配 Keil 选项中的 Target。'); }
    const debug = one(one(optionTargets[opt.index], 'TargetOption'), 'DebugOpt');
    const nextOptions = replaceElementText(optionsXml, one(debug, 'pMon'), dll);
    const optionsChanged = !originalOptions || !buffersEqual(Buffer.from(nextOptions, 'utf8'), originalOptions);
    if (!optionsChanged && nextProject === project.xml) { return false; }
    beforeWrite();
    if (!buffersEqual(fs.readFileSync(projectPath), project.buffer)) {
        throw new Error('编辑期间 Keil 工程发生变化，请重试。');
    }
    if (optionsChanged) { writeProjectChange(optionsPath, originalOptions, nextOptions); }
    try {
        if (nextProject !== project.xml) { writeProjectChange(projectPath, project.buffer, nextProject); }
    } catch (error) {
        if (optionsChanged) {
            const written = Buffer.from(nextOptions, 'utf8');
            try {
                if (originalOptions) {
                    writeProjectChange(optionsPath, written, decodeUtf8Project(originalOptions));
                } else if (buffersEqual(fs.readFileSync(optionsPath), written)) {
                    fs.unlinkSync(optionsPath);
                }
            } catch (rollback) {
                throw new Error('写入下载模式失败，且 Keil 选项未能恢复：' + (<Error>rollback).message);
            }
        }
        throw error;
    }
    return true;
}

/** Add an existing directory to one target's compiler include paths. Other targets are untouched. */
export async function addIncludeDirectoryToKeilProject(projectPath: string, targetName: string,
    includeDir: string): Promise<ProjectEditResult> {
    const absoluteDir = node_path.resolve(includeDir);
    if (!fs.statSync(absoluteDir).isDirectory()) {
        throw new Error(`头文件路径不是文件夹：${includeDir}`);
    }
    const projectDir = node_path.dirname(projectPath);
    const storedPath = node_path.relative(projectDir, absoluteDir).replace(/\//g, '\\') || '.';
    if (/[;\u0000-\u001f]/.test(storedPath)) {
        throw new Error('该文件夹无法写入 Keil 头文件搜索路径列表。');
    }

    const { buffer, xml } = readUtf8Project(projectPath);
    const parser = new xml2js.Parser({ explicitArray: false });
    const document = await parser.parseStringPromise(xml);
    const targets = asArray<any>(document.Project && document.Project.Targets && document.Project.Targets.Target);
    const matchingTargets = targets.map((target, index) => target.TargetName === targetName ? index : -1)
        .filter((index) => index >= 0);
    if (matchingTargets.length !== 1) {
        throw new Error(`Keil 编译目标不存在或名称不唯一：${targetName}`);
    }
    const targetIndex = matchingTargets[0];
    const targetData = targets[targetIndex];
    const optionData = targetData.TargetOption;
    const armCads = optionData && optionData.TargetArmAds && optionData.TargetArmAds.Cads;
    const c51Cads = optionData && optionData.Target51 && optionData.Target51.C51;
    if ((armCads === undefined) === (c51Cads === undefined)) {
        throw new Error('所选 Keil 目标的 C 编译器选项不存在或不唯一。');
    }
    const isArm = armCads !== undefined;
    const cadsData = isArm ? armCads : c51Cads;
    const variousData = cadsData && cadsData.VariousControls;
    const includeData = variousData && variousData.IncludePath;
    const currentPath = includePathText(includeData);
    const desiredKey = projectPathKey(projectDir, absoluteDir);
    if (currentPath.split(';').some((entry) => entry.trim() &&
        projectPathKey(projectDir, entry.trim()) === desiredKey)) {
        return { status: 'already-present' };
    }

    const target = targetElement(xml, targets.length, targetIndex);
    const option = one(target, 'TargetOption');
    const compiler = one(option, isArm ? 'TargetArmAds' : 'Target51');
    const cads = one(compiler, isArm ? 'Cads' : 'C51');
    const variousElements = direct(cads, 'VariousControls');
    if (variousElements.length > 1) {
        throw new Error('所选 Keil 编译器包含多个 <VariousControls> 节点。');
    }
    const various = variousElements[0];
    const includeElements = various ? direct(various, 'IncludePath') : [];
    if (includeElements.length > 1) {
        throw new Error('所选 Keil 编译目标包含多个 <IncludePath> 节点。');
    }
    const includeElement = includeElements[0];
    const eol = xml.includes('\r\n') ? '\r\n' : '\n';
    const escapedPath = xmlEscape(storedPath);
    let updated: string;
    if (includeElement) {
        if (includeElement.children.length) {
            throw new Error('所选 Keil 头文件路径包含不支持的 XML 内容。');
        }
        if (includeElement.selfClosing) {
            const opening = xml.slice(includeElement.start, includeElement.openEnd).replace(/\s*\/\s*>$/, '>');
            updated = xml.slice(0, includeElement.start) + `${opening}${escapedPath}</IncludePath>` +
                xml.slice(includeElement.end);
        } else {
            const content = xml.slice(includeElement.openEnd, includeElement.closeStart);
            if (content.includes('<')) {
                throw new Error('所选 Keil 头文件路径包含不支持的 XML 内容。');
            }
            const trailing = /[ \t\r\n]*$/.exec(content)![0];
            const body = content.slice(0, content.length - trailing.length);
            const separator = body && !body.endsWith(';') ? ';' : '';
            updated = xml.slice(0, includeElement.openEnd) + body + separator + escapedPath + trailing +
                xml.slice(includeElement.closeStart);
        }
    } else if (various) {
        const variousIndent = lineIndent(xml, various.start) || '';
        const child = various.children[0];
        const unit = indentUnit(xml, various, child);
        const includeIndent = child ? (lineIndent(xml, child.start) || variousIndent + unit) : variousIndent + unit;
        const block = `${includeIndent}<IncludePath>${escapedPath}</IncludePath>`;
        updated = various.selfClosing
            ? expandSelfClosingElement(xml, various, block, eol, variousIndent)
            : insertBeforeClose(xml, various, block, eol, variousIndent);
    } else {
        const cadsIndent = lineIndent(xml, cads.start) || '';
        const child = cads.children[0];
        const unit = indentUnit(xml, cads, child);
        const variousIndent = child ? (lineIndent(xml, child.start) || cadsIndent + unit) : cadsIndent + unit;
        const includeIndent = variousIndent + unit;
        const block = `${variousIndent}<VariousControls>${eol}` +
            `${includeIndent}<IncludePath>${escapedPath}</IncludePath>${eol}` +
            `${variousIndent}</VariousControls>`;
        updated = cads.selfClosing
            ? expandSelfClosingElement(xml, cads, block, eol, cadsIndent)
            : insertBeforeClose(xml, cads, block, eol, cadsIndent);
    }

    const after = await parser.parseStringPromise(updated);
    const afterTargets = asArray<any>(after.Project.Targets.Target);
    const afterOptions = afterTargets[targetIndex].TargetOption;
    const afterCads = isArm ? afterOptions.TargetArmAds.Cads : afterOptions.Target51.C51;
    const afterPath = includePathText(afterCads.VariousControls.IncludePath);
    if (afterTargets.length !== targets.length ||
        afterTargets[targetIndex].TargetName !== targetName ||
        afterPath.split(';').filter((entry) => entry.trim() &&
            projectPathKey(projectDir, entry.trim()) === desiredKey).length !== 1) {
        throw new Error('无法验证修改后的 Keil 头文件路径，工程未保存。');
    }
    writeProjectChange(projectPath, buffer, updated);
    return { status: 'created' };
}
