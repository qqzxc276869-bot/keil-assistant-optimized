const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTarget = (name, useDebug) => [
    '<Target><TargetName>', name, '</TargetName><TargetOption>',
    '<TargetCommonOption><Device>STM32F103ZE</Device><FlashDriverDll>keep algorithm</FlashDriverDll></TargetCommonOption>',
    '<DllOption><TargetDllName>SARMCM3.DLL</TargetDllName></DllOption>',
    '<Utilities><Flash1><UseTargetDll>', useDebug ? '1' : '0', '</UseTargetDll>',
    '<UseExternalTool>', useDebug ? '0' : '1', '</UseExternalTool>',
    '<DriverSelection>4096</DriverSelection></Flash1><bUseTDR>', useDebug ? '1' : '0', '</bUseTDR>',
    '<Flash2>BIN\\UL2CM3.DLL</Flash2><Flash3>keep external tool</Flash3></Utilities>',
    '</TargetOption></Target>'
].join('');
const optionTarget = (name, dll) => '<Target><TargetName>' + name + '</TargetName><TargetOption>' +
    '<DebugOpt><uSim>1</uSim><uTrg>0</uTrg><pMon>' + dll + '</pMon></DebugOpt>' +
    '<TargetDriverDllRegistry><SetRegEntry><Key>ST-LINKIII-KEIL_SWO</Key><Name>keep probe settings</Name>' +
    '</SetRegEntry></TargetDriverDllRegistry></TargetOption></Target>';

async function run(extensionRoot = path.resolve(__dirname, '..')) {
    const { parseKeilDebugDrivers, parseWindowsUsbDevices, getProbeConnection } =
        require(path.join(extensionRoot, 'dist', 'src', 'KeilDownloadTools'));
    const { readKeilDownloadConfiguration, setKeilDownloadDriver } =
        require(path.join(extensionRoot, 'dist', 'src', 'KeilProjectEditor'));
    const st = 'STLink\\ST-LINKIII-KEIL_SWO.dll';
    const jlink = 'Segger\\JL2CM3.dll';
    const dap = 'BIN\\CMSIS_AGDI.dll';
    const ini = [
        '[ARM]', 'CPUDLL0=SARMCM3.DLL(TDRV3,TDRV4,TDRV6)', 'CPUDLL1=SARMV8M.DLL(TDRV14)',
        'TDRV3=' + dap + '("CMSIS-DAP Debugger")', 'TDRV4=' + jlink + '("J-LINK / J-TRACE Cortex")',
        'TDRV6=' + st + ' ("ST-Link Debugger")', 'TDRV14=BIN\\CMSIS_AGDI_V8M.DLL("CMSIS-DAP ARMv8-M Debugger")',
        '[C51]', 'TDRV3=BIN\\NOT_ARM.dll("Non-ARM")'
    ].join('\r\n');
    assert.deepStrictEqual(parseKeilDebugDrivers(ini, 'SARMCM3.DLL').map(item => item.dll), [dap, jlink, st]);
    assert.deepStrictEqual(parseKeilDebugDrivers(ini, 'SARMV8M.DLL').map(item => item.dll), ['BIN\\CMSIS_AGDI_V8M.DLL']);
    assert.deepStrictEqual(parseKeilDebugDrivers(ini, 'unknown.dll'), []);
    const pnpBlock = (id, name, problem) => [
        '    DEVPKEY_Device_InstanceId [String]:', '        ' + id,
        '    DEVPKEY_Device_BusReportedDeviceDesc [String]:', '        ' + name,
        '    DEVPKEY_Device_ProblemCode [UINT32]:', '        ' + problem
    ].join('\r\n');
    const usb = parseWindowsUsbDevices([
        pnpBlock('USB\\VID_0483&PID_374B&MI_00\\a', 'STM32 STLink', '0x00000000 (0)'),
        pnpBlock('USB\\VID_1366&PID_0101\\b', 'SEGGER', '0x0000001C (28)'),
        pnpBlock('HID\\VID_1111&PID_2222\\c', 'CMSIS-DAP v2', '0x00000000 (0)')
    ].join('\r\n\r\n'));
    assert.strictEqual(getProbeConnection(st, usb).text, 'USB 已连接');
    assert.strictEqual(getProbeConnection(jlink, usb).text, 'USB 设备异常');
    assert.strictEqual(getProbeConnection(dap, usb).text, 'USB 已连接');
    assert.strictEqual(getProbeConnection(st, []).text, '未检测到 USB');
    assert.strictEqual(getProbeConnection(st, undefined).text, 'USB 状态未知');
    assert.strictEqual(getProbeConnection('BIN\\DbgFM.DLL', usb).text, '仿真');
    assert.strictEqual(parseWindowsUsbDevices('Command usage'), undefined);
    assert.strictEqual(getProbeConnection(st, [
        { id: 'USB\\VID_0483&PID_DF11\\dfu', name: 'STM32 Bootloader' }
    ]).text, '未检测到 USB');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keil-download-tools-test-'));
    try {
        const project = path.join(root, 'Board.uvprojx');
        const options = path.join(root, 'Board.uvoptx');
        const debug = projectTarget('Debug', true);
        const release = projectTarget('Release', false);
        const projectXml = '<Project><Targets>\r\n' + debug + '\r\n' + release + '\r\n</Targets></Project>';
        const releaseOpt = optionTarget('Release', 'BIN\\UL2CM3.DLL');
        const optionsXml = '\uFEFF<ProjectOpt>\r\n<!-- keep -->\r\n' + optionTarget('Debug', st) + '\r\n' + releaseOpt +
            '\r\n<Group><GroupName>Application</GroupName></Group>\r\n</ProjectOpt>';
        fs.writeFileSync(project, projectXml);
        fs.writeFileSync(options, optionsXml);
        assert.deepStrictEqual(await readKeilDownloadConfiguration(project, 'Debug'),
            { cpuDll: 'SARMCM3.DLL', mode: 'debug', driver: st });
        assert.strictEqual(await readKeilDownloadConfiguration(project, 'Release').then(info => info.mode), 'external');
        const unavailable = async () => { assert.fail('existing options must not call UV4'); };
        assert.strictEqual(await setKeilDownloadDriver(project, 'Debug', dap, unavailable), true);
        assert.strictEqual(fs.readFileSync(project, 'utf8'), projectXml);
        assert.strictEqual(fs.readFileSync(options, 'utf8'), optionsXml.replace('<pMon>' + st, '<pMon>' + dap));
        assert.strictEqual(await setKeilDownloadDriver(project, 'Debug', dap, unavailable), false);
        assert.strictEqual(await setKeilDownloadDriver(project, 'Release', jlink, unavailable), true);
        assert.deepStrictEqual(await readKeilDownloadConfiguration(project, 'Release'),
            { cpuDll: 'SARMCM3.DLL', mode: 'debug', driver: jlink });
        assert.strictEqual(fs.readFileSync(project, 'utf8'), projectXml.replace(release,
            release.replace('<UseTargetDll>0', '<UseTargetDll>1')
                .replace('<UseExternalTool>1', '<UseExternalTool>0').replace('<bUseTDR>0', '<bUseTDR>1')));

        fs.unlinkSync(options);
        const generate = async (device) => {
            assert.strictEqual(device, 'STM32F103ZE');
            return '<ProjectOpt>\r\n' + optionTarget(device, st) + '\r\n</ProjectOpt>';
        };
        assert.strictEqual(await setKeilDownloadDriver(project, 'Debug', dap, generate), true);
        assert.strictEqual(await readKeilDownloadConfiguration(project, 'Debug').then(info => info.driver), dap);
        assert.strictEqual(await setKeilDownloadDriver(project, 'Release', jlink, generate), true);
        assert.strictEqual(await readKeilDownloadConfiguration(project, 'Release').then(info => info.driver), jlink);
        const savedOptions = fs.readFileSync(options);
        await assert.rejects(setKeilDownloadDriver(project, 'Debug', st, unavailable, () => {
            fs.appendFileSync(project, '\r\n<!-- saved by Keil -->');
        }), /发生变化/);
        assert.deepStrictEqual(fs.readFileSync(options), savedOptions);
    } finally {
        const resolved = path.resolve(root);
        if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('keil-download-tools-test-')) {
            fs.rmSync(resolved, { recursive: true, force: true });
        }
    }
    console.log('Download tool tests passed: matched driver lists, USB states, Target-specific XML changes, default options, concurrent edits.');
}

if (require.main === module) {
    run().catch((error) => { console.error(error); process.exitCode = 1; });
}
