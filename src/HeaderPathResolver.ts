import * as fs from 'fs';
import * as node_path from 'path';

export interface HeaderCandidate {
    headerPath: string;
    includeDirectory: string;
}

export interface HeaderSearchResult {
    candidates: HeaderCandidate[];
    complete: boolean;
}

function pathKey(path: string): string {
    const resolved = node_path.resolve(path);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isAtOrUnder(path: string, parent: string): boolean {
    const childKey = pathKey(path);
    const parentKey = pathKey(parent);
    return childKey === parentKey || childKey.startsWith(parentKey + node_path.sep);
}

/** Only compiler errors are used; inactive #include branches are not guessed at. */
export function missingHeadersFromBuildLog(log: string): string[] {
    const found = new Map<string, string>();
    for (const line of log.split(/\r?\n/)) {
        if (!/\berror\b|\bfatal\b/i.test(line)) { continue; }
        const match = /cannot open source input file\s*["']([^"']+)["']/i.exec(line) ||
            /fatal error:\s*([^:\r\n]+?)\s*:\s*No such file or directory/i.exec(line) ||
            /can't open file\s*["']([^"']+)["']/i.exec(line);
        const name = match && match[1].trim();
        if (!name || node_path.isAbsolute(name) || /^[a-z]:[\\/]/i.test(name)) { continue; }
        const parts = name.replace(/\\/g, '/').split('/');
        if (parts.some((part) => !part || part === '.' || part === '..') ||
            !/\.(h|hpp|hxx|hh|inc)$/i.test(parts[parts.length - 1])) { continue; }
        found.set(name.toLowerCase(), name);
    }
    return Array.from(found.values());
}

/** Prefer the smallest tree containing the Keil project and its listed files. */
export function headerSearchRoots(projectPath: string, sourcePaths: string[], workspaceRoot?: string): string[] {
    const projectDir = node_path.dirname(node_path.resolve(projectPath));
    const boundedWorkspace = workspaceRoot && isAtOrUnder(projectDir, workspaceRoot) ?
        node_path.resolve(workspaceRoot) : undefined;
    let knownRoot = projectDir;
    for (const sourcePath of sourcePaths) {
        if (boundedWorkspace && !isAtOrUnder(sourcePath, boundedWorkspace)) { continue; }
        let common = knownRoot;
        while (!isAtOrUnder(sourcePath, common)) {
            const parent = node_path.dirname(common);
            if (parent === common) { break; }
            common = parent;
        }
        // An external Keil pack must not turn a build into a drive-wide search.
        if (common !== node_path.parse(common).root) { knownRoot = common; }
    }
    const fallback = boundedWorkspace || node_path.dirname(projectDir);
    const seen = new Set<string>();
    return [knownRoot, fallback].filter((root) => {
        const key = pathKey(root);
        if (seen.has(key)) { return false; }
        seen.add(key);
        return true;
    });
}

const IGNORED_DIRECTORIES = new Set(['.git', '.svn', '.vscode', 'node_modules', 'obj', 'objects',
    'listings', 'debug', 'release']);

/** Match the complete include suffix, so "lcd/lcd.h" adds its parent folder. */
export async function findHeaderCandidates(root: string, includeName: string,
    maxEntries: number = 30000): Promise<HeaderSearchResult> {
    const parts = includeName.replace(/\\/g, '/').split('/');
    const suffix = '/' + parts.join('/').toLowerCase();
    const basename = parts[parts.length - 1].toLowerCase();
    const candidates: HeaderCandidate[] = [];
    const stack = [node_path.resolve(root)];
    let visited = 0;
    let complete = true;
    while (stack.length) {
        const directory = stack.pop()!;
        let entries: fs.Dirent[];
        try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
        catch (error) {
            complete = false;
            continue;
        }
        for (const entry of entries) {
            if (++visited > maxEntries) { return { candidates, complete: false }; }
            const fullPath = node_path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) { stack.push(fullPath); }
            } else if (entry.isFile() && entry.name.toLowerCase() === basename &&
                fullPath.replace(/\\/g, '/').toLowerCase().endsWith(suffix)) {
                let includeDirectory = fullPath;
                for (const _part of parts) { includeDirectory = node_path.dirname(includeDirectory); }
                candidates.push({ headerPath: fullPath, includeDirectory });
            }
        }
    }
    candidates.sort((a, b) => a.headerPath.localeCompare(b.headerPath));
    return { candidates, complete };
}
