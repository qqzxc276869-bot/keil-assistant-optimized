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
    throw new Error('The Keil project contains an unfinished XML tag.');
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
            if (end < 0) { throw new Error('The Keil project contains unfinished XML markup.'); }
            cursor = end + marker.length;
            continue;
        }
        if (xml.startsWith('<?', start)) {
            const end = xml.indexOf('?>', start + 2);
            if (end < 0) { throw new Error('The Keil project contains unfinished XML markup.'); }
            cursor = end + 2;
            continue;
        }
        if (xml.startsWith('<!', start)) {
            throw new Error('This Keil project uses unsupported XML declarations; it was not changed.');
        }

        const tagEnd = findTagEnd(xml, start);
        const tag = xml.slice(start + 1, tagEnd).trim();
        if (tag.startsWith('/')) {
            const name = tag.slice(1).trim();
            const current = stack.pop();
            if (!current || current.name !== name) {
                throw new Error('The Keil project has mismatched XML elements.');
            }
            current.closeStart = start;
            current.end = tagEnd + 1;
        } else {
            const match = /^([A-Za-z_][\w:.-]*)/.exec(tag);
            if (!match) { throw new Error('The Keil project contains an invalid XML element.'); }
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
    if (stack.length) { throw new Error('The Keil project contains unclosed XML elements.'); }
    return roots;
}

function direct(parent: XmlElement, name: string): XmlElement[] {
    return parent.children.filter((child) => child.name === name);
}

function one(parent: XmlElement, name: string): XmlElement {
    const found = direct(parent, name);
    if (found.length !== 1) {
        throw new Error(`Expected one <${name}> element in the Keil project.`);
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
    const xml = buffer.toString('utf8');
    const declaration = /^\uFEFF?<\?xml[^?]*encoding\s*=\s*["']([^"']+)["']/i.exec(xml);
    if (!buffersEqual(Buffer.from(xml, 'utf8'), buffer) || (declaration && !/^utf-?8$/i.test(declaration[1]))) {
        throw new Error('The Keil project is not UTF-8; it was not changed.');
    }
    return { buffer, xml };
}

function writeProjectChange(projectPath: string, original: Buffer, updated: string): void {
    const temporaryPath = `${projectPath}.keil-assistant-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(temporaryPath, updated, { encoding: 'utf8', flag: 'wx' });
        if (!buffersEqual(fs.readFileSync(projectPath), original)) {
            throw new Error('The Keil project changed while editing it. Retry the command.');
        }
        fs.renameSync(temporaryPath, projectPath);
    } finally {
        if (fs.existsSync(temporaryPath)) { fs.unlinkSync(temporaryPath); }
    }
}

function projectRoot(xml: string): XmlElement {
    const root = scanElements(xml).find((element) => element.name === 'Project');
    if (!root) { throw new Error('The Keil project has no <Project> element.'); }
    return root;
}

function targetElement(xml: string, targetCount: number, targetIndex: number): XmlElement {
    const targets = direct(one(projectRoot(xml), 'Targets'), 'Target');
    if (targets.length !== targetCount || !targets[targetIndex]) {
        throw new Error('The Keil target structure could not be matched safely.');
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
            throw new Error(`Unsupported Keil file type: ${node_path.basename(sourcePath)}`);
        }
        if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
            throw new Error(`The source file does not exist: ${sourcePath}`);
        }
        return { path: node_path.resolve(sourcePath), fileType };
    });
    const projectDir = node_path.dirname(projectPath);
    const { buffer, xml } = readUtf8Project(projectPath);
    const parser = new xml2js.Parser({ explicitArray: false });
    const document = await parser.parseStringPromise(xml);
    const targetData = asArray<any>(document.Project && document.Project.Targets && document.Project.Targets.Target);
    const targetIndex = targetData.findIndex((target) => target.TargetName === targetName);
    if (targetIndex < 0) { throw new Error(`Keil target not found: ${targetName}`); }
    const target = targetData[targetIndex];
    const groupData = asArray<any>(target.Groups && target.Groups.Group);
    const matchingGroups = groupData.map((group, index) => group.GroupName === groupName ? index : -1)
        .filter((index) => index >= 0);
    if (matchingGroups.length !== 1) { throw new Error(`Keil group is missing or ambiguous: ${groupName}`); }
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
        throw new Error('The Keil group structure could not be matched safely.');
    }
    const groupElement = groupElements[groupIndex];
    const groupNameElement = one(groupElement, 'GroupName');
    const eol = xml.includes('\r\n') ? '\r\n' : '\n';
    const unit = indentUnit(xml, groupElement, groupNameElement);
    const groupIndent = lineIndent(xml, groupElement.start) || '';
    const filesElement = direct(groupElement, 'Files')[0];
    if (direct(groupElement, 'Files').length > 1) {
        throw new Error('The selected Keil group contains multiple <Files> elements.');
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
            throw new Error('The changed Keil project could not be verified; it was not saved.');
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
        throw new Error('Enter a non-empty Keil group name without control characters.');
    }
    const { buffer, xml } = readUtf8Project(projectPath);
    const parser = new xml2js.Parser({ explicitArray: false });
    const document = await parser.parseStringPromise(xml);
    const targets = asArray<any>(document.Project && document.Project.Targets && document.Project.Targets.Target);
    const targetIndex = targets.findIndex((target) => target.TargetName === targetName);
    if (targetIndex < 0) { throw new Error(`Keil target not found: ${targetName}`); }
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
    if (groupsElements.length > 1) { throw new Error('The Keil target contains multiple <Groups> elements.'); }
    const groupsElement = groupsElements[0];
    if (groupsElement && direct(groupsElement, 'Group').length !== groups.length) {
        throw new Error('The Keil group structure could not be matched safely.');
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
        throw new Error('The new Keil group could not be verified; the project was not saved.');
    }
    writeProjectChange(projectPath, buffer, updated);
    return { status: 'created' };
}

/** Remove one reference from a Keil group; the source file on disk is kept. */
export async function removeFileFromKeilProject(projectPath: string, targetName: string,
    groupName: string, sourcePath: string): Promise<ProjectEditResult> {
    const { buffer, xml } = readUtf8Project(projectPath);
    const parser = new xml2js.Parser({ explicitArray: false });
    const document = await parser.parseStringPromise(xml);
    const targets = asArray<any>(document.Project && document.Project.Targets && document.Project.Targets.Target);
    const targetIndex = targets.findIndex((target) => target.TargetName === targetName);
    if (targetIndex < 0) { throw new Error(`Keil target not found: ${targetName}`); }
    const groups = asArray<any>(targets[targetIndex].Groups && targets[targetIndex].Groups.Group);
    const groupIndexes = groups.map((group, index) => group.GroupName === groupName ? index : -1)
        .filter((index) => index >= 0);
    if (groupIndexes.length !== 1) { throw new Error(`Keil group is missing or ambiguous: ${groupName}`); }
    const groupIndex = groupIndexes[0];
    const filesData = asArray<any>(groups[groupIndex].Files);
    if (filesData.length > 1) { throw new Error('The selected group contains multiple <Files> elements.'); }
    const entries = filesData.length ? asArray<any>(filesData[0].File) : [];
    const projectDir = node_path.dirname(projectPath);
    const sourceKey = projectPathKey(projectDir, sourcePath);
    const matches = entries.map((file, index) =>
        typeof file.FilePath === 'string' && projectPathKey(projectDir, file.FilePath) === sourceKey ? index : -1)
        .filter((index) => index >= 0);
    if (matches.length === 0) { return { status: 'not-present' }; }
    if (matches.length > 1) { throw new Error('The selected group has duplicate references to this file.'); }

    const target = targetElement(xml, targets.length, targetIndex);
    const groupElements = direct(one(target, 'Groups'), 'Group');
    if (groupElements.length !== groups.length) {
        throw new Error('The Keil group structure could not be matched safely.');
    }
    const filesElement = one(groupElements[groupIndex], 'Files');
    const fileElements = direct(filesElement, 'File');
    if (fileElements.length !== entries.length) {
        throw new Error('The Keil file structure could not be matched safely.');
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
        throw new Error('The removed Keil file could not be verified; the project was not saved.');
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
    throw new Error('The selected Keil include path has unsupported XML content.');
}

/** Add an existing directory to one target's compiler include paths. Other targets are untouched. */
export async function addIncludeDirectoryToKeilProject(projectPath: string, targetName: string,
    includeDir: string): Promise<ProjectEditResult> {
    const absoluteDir = node_path.resolve(includeDir);
    if (!fs.statSync(absoluteDir).isDirectory()) {
        throw new Error(`The include path is not a directory: ${includeDir}`);
    }
    const projectDir = node_path.dirname(projectPath);
    const storedPath = node_path.relative(projectDir, absoluteDir).replace(/\//g, '\\') || '.';
    if (/[;\u0000-\u001f]/.test(storedPath)) {
        throw new Error('The include directory cannot be represented in a Keil include path list.');
    }

    const { buffer, xml } = readUtf8Project(projectPath);
    const parser = new xml2js.Parser({ explicitArray: false });
    const document = await parser.parseStringPromise(xml);
    const targets = asArray<any>(document.Project && document.Project.Targets && document.Project.Targets.Target);
    const matchingTargets = targets.map((target, index) => target.TargetName === targetName ? index : -1)
        .filter((index) => index >= 0);
    if (matchingTargets.length !== 1) {
        throw new Error(`Keil target is missing or ambiguous: ${targetName}`);
    }
    const targetIndex = matchingTargets[0];
    const targetData = targets[targetIndex];
    const optionData = targetData.TargetOption;
    const armCads = optionData && optionData.TargetArmAds && optionData.TargetArmAds.Cads;
    const c51Cads = optionData && optionData.Target51 && optionData.Target51.C51;
    if ((armCads === undefined) === (c51Cads === undefined)) {
        throw new Error('The selected Keil target has no unambiguous C compiler options.');
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
        throw new Error('The selected Keil compiler contains multiple <VariousControls> elements.');
    }
    const various = variousElements[0];
    const includeElements = various ? direct(various, 'IncludePath') : [];
    if (includeElements.length > 1) {
        throw new Error('The selected Keil target contains multiple <IncludePath> elements.');
    }
    const includeElement = includeElements[0];
    const eol = xml.includes('\r\n') ? '\r\n' : '\n';
    const escapedPath = xmlEscape(storedPath);
    let updated: string;
    if (includeElement) {
        if (includeElement.children.length) {
            throw new Error('The selected Keil include path has unsupported XML content.');
        }
        if (includeElement.selfClosing) {
            const opening = xml.slice(includeElement.start, includeElement.openEnd).replace(/\s*\/\s*>$/, '>');
            updated = xml.slice(0, includeElement.start) + `${opening}${escapedPath}</IncludePath>` +
                xml.slice(includeElement.end);
        } else {
            const content = xml.slice(includeElement.openEnd, includeElement.closeStart);
            if (content.includes('<')) {
                throw new Error('The selected Keil include path has unsupported XML content.');
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
        throw new Error('The changed Keil include path could not be verified; the project was not saved.');
    }
    writeProjectChange(projectPath, buffer, updated);
    return { status: 'created' };
}
