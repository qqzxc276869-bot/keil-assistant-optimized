import * as vscode from 'vscode';
import { readKeilDownloadConfiguration } from './KeilProjectEditor';
import { canDetectProbe, debugDriverLabel, getProbeConnection, queryWindowsUsbDevices } from './KeilDownloadTools';

interface DownloadTarget {
    projectPath: string;
    targetName: string;
}

export class KeilDownloadStatus implements vscode.Disposable {
    private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 35);
    private selection?: DownloadTarget;
    private timer?: NodeJS.Timeout;
    private refreshing = false;
    private needsRefresh = false;

    constructor() {
        this.item.command = 'project.selectDownloadTool';
    }

    setTarget(selection?: DownloadTarget) {
        if (this.selection?.projectPath === selection?.projectPath && this.selection?.targetName === selection?.targetName) {
            return;
        }
        this.selection = selection;
        if (selection) {
            this.item.text = '$(plug) 下载工具';
            this.item.tooltip = '点击切换当前 Keil Target 的下载工具';
            this.item.show();
        } else {
            this.item.hide();
        }
        this.refresh();
    }

    refresh() {
        if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
        const selection = this.selection;
        if (!selection) { return; }
        if (this.refreshing) { this.needsRefresh = true; return; }
        this.refreshing = true;
        this.update(selection).finally(() => {
            this.refreshing = false;
            if (!this.selection) { return; }
            if (this.needsRefresh) {
                this.needsRefresh = false;
                this.refresh();
            } else {
                this.timer = setTimeout(() => this.refresh(), 5000);
                this.timer.unref();
            }
        });
    }

    private async update(selection: DownloadTarget): Promise<void> {
        try {
            const config = await readKeilDownloadConfiguration(selection.projectPath, selection.targetName);
            const title = selection.targetName + ' · 点击切换 Keil 下载工具';
            const devices = canDetectProbe(config.driver) ? await queryWindowsUsbDevices() : undefined;
            if (this.selection !== selection) { return; }
            if (config.mode === 'external' || !config.driver) {
                this.item.text = '$(plug) ' + (config.mode === 'external' ? '外部下载工具' : '选择下载工具');
                this.item.tooltip = title;
                return;
            }
            const state = getProbeConnection(config.driver, devices);
            this.item.text = '$(plug) ' + debugDriverLabel(config.driver) + ' · ' + state.text;
            this.item.tooltip = title + '\n' + state.detail + '\n目标板的 SWD/JTAG 通信情况可在 Keil 下载输出中查看。';
        } catch (error) {
            if (this.selection !== selection) { return; }
            this.item.text = '$(plug) 下载工具 · 状态未知';
            this.item.tooltip = (<Error>error).message;
        }
    }

    dispose() {
        this.selection = undefined;
        if (this.timer) { clearTimeout(this.timer); }
        this.item.dispose();
    }
}
