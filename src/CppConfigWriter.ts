import * as fs from 'fs';
import * as node_path from 'path';
import { applyEdits, getNodeValue, modify, parseTree, ParseError, FormattingOptions, Node } from 'jsonc-parser';

export interface CppConfiguration {
    name: string;
    includePath: string[];
    defines: string[];
    intelliSenseMode: string;
}

function sameStrings(left: unknown, right: string[]): boolean {
    return Array.isArray(left) && left.length === right.length &&
        left.every((value, index) => value === right[index]);
}

function change(text: string, path: (string | number)[], value: unknown, formattingOptions: FormattingOptions): string {
    return applyEdits(text, modify(text, path, value, { formattingOptions }));
}

function assertUniqueProperties(node: Node): void {
    if (node.type === 'object') {
        const seen = new Set<string>();
        for (const property of node.children || []) {
            const key = property.children && property.children[0] && property.children[0].value;
            if (typeof key !== 'string') { continue; }
            if (seen.has(key)) { throw new Error(`c_cpp_properties.json 中有重复的 JSONC 键：${key}`); }
            seen.add(key);
        }
    }
    for (const child of node.children || []) { assertUniqueProperties(child); }
}

/** Update only this extension's configurations, preserving JSONC comments and other settings. */
export function updateCppConfigurationsText(existing: string | undefined, configurations: CppConfiguration[]): string {
    const requestedNames = new Set<string>();
    for (const configuration of configurations) {
        if (requestedNames.has(configuration.name)) {
            throw new Error(`Keil C/C++ 配置名称重复：${configuration.name}`);
        }
        requestedNames.add(configuration.name);
    }
    if (existing === undefined) {
        return JSON.stringify({ configurations, version: 4 }, undefined, 4) + '\n';
    }

    const bom = existing.charCodeAt(0) === 0xFEFF ? '\uFEFF' : '';
    const input = bom ? existing.slice(1) : existing;
    const errors: ParseError[] = [];
    const tree = parseTree(input, errors, { allowTrailingComma: true });
    if (tree) { assertUniqueProperties(tree); }
    const document = tree && getNodeValue(tree);
    if (errors.length || !document || typeof document !== 'object' || Array.isArray(document) ||
        !Array.isArray(document.configurations)) {
        throw new Error('c_cpp_properties.json 的 JSONC 格式无效，或缺少 configurations 数组');
    }

    const eol = input.includes('\r\n') ? '\r\n' : '\n';
    const formattingOptions: FormattingOptions = { insertSpaces: true, tabSize: 4, eol };
    let result = input;
    const items: any[] = document.configurations.slice();

    for (const configuration of configurations) {
        const matches = items.map((item, index) => item && item.name === configuration.name ? index : -1)
            .filter((index) => index >= 0);
        if (matches.length > 1) {
            throw new Error(`c_cpp_properties.json 中存在同名配置：${configuration.name}`);
        }
        const index = matches.length ? matches[0] : -1;
        if (index < 0) {
            result = applyEdits(result, modify(result, ['configurations', items.length], configuration,
                { isArrayInsertion: true, formattingOptions }));
            items.push(configuration);
            continue;
        }

        const item = items[index];
        if (!sameStrings(item.includePath, configuration.includePath)) {
            result = change(result, ['configurations', index, 'includePath'], configuration.includePath, formattingOptions);
            item.includePath = configuration.includePath;
        }
        if (!sameStrings(item.defines, configuration.defines)) {
            result = change(result, ['configurations', index, 'defines'], configuration.defines, formattingOptions);
            item.defines = configuration.defines;
        }
    }

    return bom + result;
}

export function updateCppConfigurationsFile(path: string, configurations: CppConfiguration[]): boolean {
    const existing = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : undefined;
    const updated = updateCppConfigurationsText(existing, configurations);
    if (updated === existing) { return false; }
    fs.mkdirSync(node_path.dirname(path), { recursive: true });
    fs.writeFileSync(path, updated, 'utf8');
    return true;
}
