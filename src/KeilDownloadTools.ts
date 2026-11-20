import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';

export interface KeilDebugDriver {
    dll: string;
    label: string;
}

export function driverKey(dll: string): string {
    return path.win32.normalize(dll.trim()).toLowerCase();
}

export function parseKeilDebugDrivers(ini: string, cpuDll: string): KeilDebugDriver[] {
    const sections = new Map<string, string[]>();
    let lines: string[] = [];
    for (const line of ini.split(/\r?\n/)) {
        const heading = /^\s*\[([^\]]+)\]/.exec(line);
        if (heading) {
            lines = [];
            sections.set(heading[1].toUpperCase(), lines);
        } else {
            lines.push(line);
        }
    }
    const cpuName = path.win32.basename(cpuDll).toLowerCase();
    for (const section of ['ARMADS', 'ARM']) {
        const entries = sections.get(section) || [];
        const cpuMappings = entries.map((line) => /^\s*CPUDLL\d+\s*=\s*(.+?)\s*\(([^)]*)\)/i.exec(line))
            .filter((match): match is RegExpExecArray => !!match);
        const mapping = cpuMappings.find((match) => match[1].replace(/"/g, '').toLowerCase() === cpuName);
        if (!mapping && cpuName && cpuMappings.length) { continue; }
        const allowed = mapping && new Set(mapping[2].toUpperCase().split(',').map((id) => id.trim()));
        const drivers: KeilDebugDriver[] = [];
        for (const line of entries) {
            const match = /^\s*(TDRV\d+)\s*=\s*(.+?)\s*\(\s*"([^"]+)"\s*\)/i.exec(line);
            if (match && (!allowed || allowed.has(match[1].toUpperCase()))) {
                drivers.push({ dll: match[2].trim().replace(/^"|"$/g, '').replace(/\//g, '\\'), label: match[3] });
            }
        }
        if (drivers.length) { return drivers; }
    }
    return [];
}

export async function getInstalledDebugDrivers(uv4Path: string, cpuDll: string): Promise<KeilDebugDriver[]> {
    if (!path.isAbsolute(uv4Path) || !fs.existsSync(uv4Path)) {
        throw new Error('请先在 VS Code 设置中配置 KeilAssistant.MDK.Uv4Path。');
    }
    const installation = path.dirname(path.dirname(uv4Path));
    const ini = await fs.promises.readFile(path.join(installation, 'TOOLS.INI'), 'utf8');
    const drivers = parseKeilDebugDrivers(ini, cpuDll);
    const existing = await Promise.all(drivers.map(async (driver) => {
        const file = path.resolve(installation, 'ARM', driver.dll.replace(/[\\/]/g, path.sep));
        try { return (await fs.promises.stat(file)).isFile(); }
        catch (error) { return false; }
    }));
    return drivers.filter((_driver, index) => existing[index]);
}

export async function generateKeilDefaultOptions(uv4Path: string, device: string): Promise<string> {
    if (!/^[a-z0-9][a-z0-9_.+(): -]*$/i.test(device)) { throw new Error('Keil 设备名称无法用于生成默认选项。'); }
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'keil-assistant-options-'));
    try {
        const project = path.join(directory, 'Defaults.uvprojx');
        await new Promise<void>((resolve, reject) => {
            execFile(uv4Path, ['-np', device, project, '-j0'], { cwd: directory, windowsHide: true, timeout: 15000 },
                (error) => error ? reject(new Error('Keil 无法为 ' + device + ' 生成默认调试选项。')) : resolve());
        });
        return await fs.promises.readFile(path.join(directory, 'Defaults.uvoptx'), 'utf8');
    } finally {
        // Only the scratch directory created for this one invocation is removed.
        const files = fs.promises as typeof fs.promises & {
            rm?: (path: string, options: { recursive: boolean; force: boolean }) => Promise<void>;
        };
        try {
            if (files.rm) { await files.rm(directory, { recursive: true, force: true }); }
            else { await files.rmdir(directory, { recursive: true }); }
        }
        catch (error) { /* A stalled external program can keep the temporary files open. */ }
    }
}

interface ProbeFamily {
    label: string;
    driver: RegExp;
    name: RegExp;
    usb?: RegExp;
}

// The fixed USB IDs are from the ST-Link, SEGGER and Keil USB driver INFs.
const probeFamilies: ProbeFamily[] = [
    { label: 'ST-Link', driver: /st[- ]?link/i, name: /\bst[- ]?link\b/i,
        usb: /^VID_0483&PID_(?:374[8abdef]|375[23457])(?:&MI_00)?$/i },
    { label: 'J-Link', driver: /jl2cm3|jltagdi|jlink|j-link|j-trace/i, name: /\bj[- ]?(?:link|trace)\b/i,
        usb: /^VID_1366&PID_(?:010[1-8]|10[126][0-9a-f])(?:&MI_[0-9a-f]{2})?$/i },
    { label: 'CMSIS-DAP', driver: /cmsis[_ -](?:agdi|dap)/i, name: /\bcmsis[-_ ]dap\b/i },
    { label: 'ULINKplus', driver: /ulpl2cm3|ulinkplus/i, name: /\bulink\s*plus\b/i,
        usb: /^VID_C251&PID_2750(?:&MI_00)?$/i },
    { label: 'ULINKpro', driver: /ulp2|ulink\s*pro/i, name: /\bulink\s*pro\b/i,
        usb: /^VID_C251&PID_27[34]0$/i },
    { label: 'ULINK2/ME', driver: /ul2(?:cm3|v8m|arm)|ulink2/i, name: /\bulink(?:2|[- ]me)\b/i,
        usb: /^VID_C251&PID_2728$/i },
    { label: 'Nu-Link', driver: /nu[_ -]?link/i, name: /\bnu[_ -]?link\b/i },
    { label: 'PEmicro', driver: /pemicro/i, name: /\bp[& ]?e\s*micro/i },
    { label: 'SiLabs UDA', driver: /slab_cm_keil|silabs uda/i, name: /\b(?:silabs|silicon labs).*debug adapter\b/i },
    { label: 'USB-Blaster', driver: /ablstcm|altera blaster/i, name: /\busb[- ]blaster\b/i },
    { label: 'TI XDS', driver: /xds2cm3|ti xds/i, name: /\bxds(?:100|110|200|2xx|560)\b/i }
];

function probeFamily(dll: string): ProbeFamily | undefined {
    return probeFamilies.find((family) => family.driver.test(path.win32.basename(dll)));
}

export function isModelDriver(dll: string): boolean {
    return /^DbgFM(?:v8m)?\.dll$/i.test(path.win32.basename(dll));
}

export function debugDriverLabel(dll: string): string {
    return probeFamily(dll)?.label || (isModelDriver(dll) ? 'Cortex-M 仿真' : path.win32.basename(dll));
}

export interface WindowsUsbDevice {
    id: string;
    name: string;
    problem?: number;
}

export function parseWindowsUsbDevices(output: string): WindowsUsbDevice[] | undefined {
    if (!output.includes('DEVPKEY_Device_InstanceId')) { return undefined; }
    const devices: WindowsUsbDevice[] = [];
    for (const block of output.split(/\r?\n[ \t]*\r?\n/)) {
        const id = /DEVPKEY_Device_InstanceId \[[^\]\r\n]+\]:[ \t]*\r?\n[ \t]*([^\r\n]+)/i.exec(block)?.[1];
        if (!id || !/^(?:USB|HID)\\VID_/i.test(id)) { continue; }
        const names = ['BusReportedDeviceDesc', 'FriendlyName', 'DeviceDesc'].map((property) =>
            new RegExp('DEVPKEY_Device_' + property + ' \\[[^\\]\\r\\n]+\\]:[ \\t]*\\r?\\n[ \\t]*([^\\r\\n]+)', 'i')
                .exec(block)?.[1].trim()).filter((name): name is string => !!name);
        const problem = /DEVPKEY_Device_ProblemCode \[UINT32\]:[ \t]*\r?\n[ \t]*(0x[\da-f]+)/i.exec(block);
        devices.push({ id: id.trim(), name: Array.from(new Set(names)).join(' / '),
            problem: problem ? Number(problem[1]) : undefined });
    }
    return devices;
}

function windowsQuery(executable: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(executable, args, { windowsHide: true, timeout: 7000, maxBuffer: 4 * 1024 * 1024 },
            (error, stdout) => error ? reject(error) : resolve(stdout));
    });
}

const usbQuery = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    '$devices = @(Get-CimInstance Win32_PnPEntity -Filter "Present = TRUE" -Property Name,PNPDeviceID,ConfigManagerErrorCode |',
    "  Where-Object { $_.PNPDeviceID -match '^(USB|HID)\\\\VID_' } |",
    '  ForEach-Object { @{ id=$_.PNPDeviceID; name=$_.Name; problem=$_.ConfigManagerErrorCode } })',
    'ConvertTo-Json -Compress -InputObject $devices'
].join('\n');

export async function queryWindowsUsbDevices(): Promise<WindowsUsbDevice[] | undefined> {
    if (process.platform !== 'win32') { return undefined; }
    const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    try {
        const output = await windowsQuery(path.join(system, 'pnputil.exe'), ['/enum-devices', '/connected', '/bus', 'USB', '/properties']);
        const devices = parseWindowsUsbDevices(output);
        if (devices) { return devices; }
    } catch (error) { /* Older Windows versions do not support every property switch. */ }
    try {
        const output = await windowsQuery(path.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
            ['-NoProfile', '-NonInteractive', '-Command', usbQuery]);
        const result = JSON.parse(output.trim());
        if (Array.isArray(result)) { return result; }
    } catch (error) { /* Report an unknown connection when Windows cannot enumerate devices. */ }
    return undefined;
}

export function canDetectProbe(dll: string): boolean {
    return !!probeFamily(dll);
}

export function getProbeConnection(dll: string, devices: WindowsUsbDevice[] | undefined):
    { text: string; detail: string } {
    if (isModelDriver(dll)) { return { text: '仿真', detail: '该驱动用于 Cortex-M 仿真。' }; }
    const family = probeFamily(dll);
    if (!family) { return { text: 'USB 状态未知', detail: '此驱动暂无法自动识别 USB 设备。' }; }
    if (!devices) { return { text: 'USB 状态未知', detail: '无法读取 Windows 当前的 USB 设备。' }; }
    const matches = devices.filter((device) => {
        const usbId = device.id.split('\\')[1] || '';
        return family.name.test(device.name) || family.usb?.test(usbId);
    });
    if (!matches.length) {
        return { text: '未检测到 USB', detail: 'Windows 未识别到与所选驱动匹配的 USB 下载器。' };
    }
    const working = matches.find((device) => !device.problem);
    if (working) {
        return { text: 'USB 已连接', detail: working.name || 'Windows 已检测到下载器。' };
    }
    return { text: 'USB 设备异常', detail: 'Windows 设备管理器错误代码 ' + matches[0].problem };
}
