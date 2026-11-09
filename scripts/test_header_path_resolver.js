const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { findHeaderCandidates, headerSearchRoots, missingHeadersFromBuildLog } =
    require('../dist/src/HeaderPathResolver');

async function run() {
    const messages = [
        '..\\USER\\main.h(14): error: #5: cannot open source input file "lcd.h": No such file or directory',
        '..\\BSP\\TPAD.c(3): error: #5: cannot open source input file "lcd.h": No such file or directory',
        'main.c:4:10: fatal error: drivers/touch.h: No such file or directory',
        '*** ERROR C318 IN LINE 5 OF main.c: CAN\'T OPEN FILE \'BOARD.H\'',
        'warning: cannot open source input file "unused.h"',
        '..\\USER\\main.h(15): error: #5: cannot open source input file "../missing.h"'
    ].join('\n');
    assert.deepStrictEqual(missingHeadersFromBuildLog(messages), ['lcd.h', 'drivers/touch.h', 'BOARD.H']);

    const root = fs.mkdtempSync(path.join(__dirname, '..', '.keil-header-path-test-'));
    try {
        const projectDir = path.join(root, 'USER');
        const lcdDir = path.join(root, 'SYSTEM', 'lcd');
        const touchDir = path.join(root, 'SYSTEM', 'drivers');
        fs.mkdirSync(projectDir, { recursive: true });
        fs.mkdirSync(lcdDir, { recursive: true });
        fs.mkdirSync(touchDir, { recursive: true });
        fs.writeFileSync(path.join(lcdDir, 'lcd.h'), '#pragma once\n');
        fs.writeFileSync(path.join(touchDir, 'touch.h'), '#pragma once\n');
        const project = path.join(projectDir, 'Template.uvprojx');
        const roots = headerSearchRoots(project, [path.join(lcdDir, 'lcd.c')], root);
        assert.deepStrictEqual(roots, [root], 'listed hardware sources should identify the project tree');
        const lcd = await findHeaderCandidates(roots[0], 'lcd.h');
        assert.strictEqual(lcd.complete, true);
        assert.deepStrictEqual(lcd.candidates.map((item) => item.includeDirectory), [lcdDir]);
        const touch = await findHeaderCandidates(roots[0], 'drivers/touch.h');
        assert.deepStrictEqual(touch.candidates.map((item) => item.includeDirectory),
            [path.join(root, 'SYSTEM')], 'an include with a subdirectory needs the directory above that suffix');

        const duplicateDir = path.join(root, 'Other', 'lcd');
        fs.mkdirSync(duplicateDir, { recursive: true });
        fs.writeFileSync(path.join(duplicateDir, 'lcd.h'), '#pragma once\n');
        assert.strictEqual((await findHeaderCandidates(root, 'lcd.h')).candidates.length, 2,
            'same-named headers must be presented as multiple choices');
        assert.strictEqual((await findHeaderCandidates(root, 'lcd.h', 1)).complete, false,
            'an incomplete scan must never authorize an automatic choice');
    } finally {
        const parent = path.resolve(__dirname, '..');
        if (path.dirname(root) === parent && path.basename(root).startsWith('.keil-header-path-test-')) {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
    console.log('Header path resolver tests passed: ARMCC/GCC/C51 diagnostics, project roots, suffix paths, duplicates, scan limits.');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
