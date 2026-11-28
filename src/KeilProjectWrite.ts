import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export class ProjectChangedError extends Error {
    constructor() { super('编辑期间 Keil 工程发生变化，请重试。'); }
}

export function isWindowsFileBusy(error: NodeJS.ErrnoException): boolean {
    return process.platform === 'win32' &&
        (error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES');
}

function busyMessage(file: string): string {
    return `无法写入 ${path.basename(file)}。请检查文件的只读属性，或等 Keil 保存、编译或调试结束后重试。`;
}

// A Windows reader can share writing but deny the delete access required by rename.
// Ask for exclusive write access to the existing file only after atomic replace fails.
async function writeSharedFile(file: string, original: Buffer, temporary: string): Promise<void> {
    const backup = temporary + '.original';
    const script = fs.readFileSync(path.resolve(__dirname, '../../bin/WriteSharedProject.ps1'), 'utf8');
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32',
        'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const env = { ...process.env, KEIL_EDIT_FILE: file, KEIL_EDIT_NEW: temporary, KEIL_EDIT_BACKUP: backup,
        KEIL_EDIT_HASH: crypto.createHash('sha256').update(original).digest('hex') };
    await new Promise<void>((resolve, reject) => {
        execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
            { env, windowsHide: true, timeout: 15000 }, (error, _stdout, stderr) => {
                if (!error) { resolve(); return; }
                if (error.code === 2) { reject(new ProjectChangedError()); return; }
                if (fs.existsSync(backup)) {
                    reject(new Error(`写入中断，原始工程的备份位于 ${backup}。请核对工程内容。`));
                } else if (error.code === 3) {
                    reject(new Error(busyMessage(file)));
                } else {
                    reject(new Error(`无法保存 ${path.basename(file)}：${stderr.trim() || error.message}`));
                }
            });
    });
}

export async function writeProjectChange(file: string, original: Buffer | undefined, updated: string,
    beforeWrite?: () => void): Promise<void> {
    const temporary = `${file}.keil-assistant-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, updated, { encoding: 'utf8', flag: 'wx' });
    try {
        if (original === undefined) {
            beforeWrite?.();
            fs.copyFileSync(temporary, file, fs.constants.COPYFILE_EXCL);
            return;
        }
        for (const delay of [0, 80, 200, 400]) {
            if (delay) { await new Promise((resolve) => setTimeout(resolve, delay)); }
            beforeWrite?.();
            if (!fs.readFileSync(file).equals(original)) { throw new ProjectChangedError(); }
            try { fs.renameSync(temporary, file); return; }
            catch (error) {
                if (!isWindowsFileBusy(error)) { throw error; }
            }
        }
        beforeWrite?.();
        await writeSharedFile(file, original, temporary);
    } finally {
        if (fs.existsSync(temporary)) { fs.unlinkSync(temporary); }
    }
}
