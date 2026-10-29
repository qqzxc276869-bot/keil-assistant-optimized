const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parse } = require('jsonc-parser');

function run(extensionRoot = path.resolve(__dirname, '..')) {
    const { updateCppConfigurationsText, updateCppConfigurationsFile } =
        require(path.join(extensionRoot, 'dist', 'src', 'CppConfigWriter'));
    const managed = {
        name: 'Board.uvprojx: Debug',
        includePath: ['C:\\Project\\Inc', '${default}'],
        defines: ['USE_HAL_DRIVER'],
        intelliSenseMode: '${default}'
    };
    const second = { ...managed, name: 'Board.uvprojx: Release', defines: ['NDEBUG'] };
    const original = [
        '{',
        '    // Keep this note and the user configuration.',
        '    "configurations": [',
        '        { "name": "User", "defines": ["USER"], },',
        '        { "name": "Board.uvprojx: Debug", "defines": ["OLD"], "custom": true, },',
        '    ],',
        '    "version": 4,',
        '}',
        ''
    ].join('\r\n');

    const updated = updateCppConfigurationsText(original, [managed, second]);
    assert.ok(updated.includes('// Keep this note'), 'JSONC comment should survive');
    assert.ok(updated.includes('"custom": true'), 'unmanaged fields should survive');
    assert.ok(updated.includes('"name": "User"'), 'user configuration should survive');
    assert.ok(!/(^|[^\r])\n/.test(updated), 'CRLF should survive');
    const parsed = parse(updated, [], { allowTrailingComma: true });
    assert.deepStrictEqual(parsed.configurations.find((item) => item.name === managed.name).includePath, managed.includePath);
    assert.deepStrictEqual(parsed.configurations.find((item) => item.name === second.name).defines, second.defines);
    assert.strictEqual(parsed.configurations.length, 3);
    assert.strictEqual(updateCppConfigurationsText(updated, [managed, second]), updated,
        'unchanged configurations should not be rewritten');
    const bomUpdated = updateCppConfigurationsText('\uFEFF' + original, [managed]);
    assert.strictEqual(bomUpdated.charCodeAt(0), 0xFEFF, 'UTF-8 BOM should be preserved');
    assert.deepStrictEqual(parse(bomUpdated.slice(1), [], { allowTrailingComma: true })
        .configurations.find((item) => item.name === managed.name).includePath, managed.includePath);
    assert.throws(() => updateCppConfigurationsText(
        '{"configurations":[{"name":"Board.uvprojx: Debug","includePath":["old1"],"includePath":["old2"]}]}',
        [managed]), /duplicate JSONC key: includePath/);
    assert.throws(() => updateCppConfigurationsText(
        '{"configurations":[],"configurations":[],"version":4}', [managed]),
        /duplicate JSONC key: configurations/);
    assert.throws(() => updateCppConfigurationsText(JSON.stringify({
        configurations: [{ name: managed.name }, { name: managed.name }], version: 4
    }), [managed]), /duplicate configurations named/);

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'keil-cpp-config-'));
    try {
        const file = path.join(scratch, '.vscode', 'c_cpp_properties.json');
        assert.strictEqual(updateCppConfigurationsFile(file, [managed]), true);
        assert.strictEqual(updateCppConfigurationsFile(file, [managed]), false);
        const valid = fs.readFileSync(file, 'utf8');
        assert.strictEqual(parse(valid).version, 4);
        fs.writeFileSync(file, '{ invalid json');
        assert.throws(() => updateCppConfigurationsFile(file, [second]), /invalid JSONC/);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ invalid json', 'invalid content must be preserved');
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
    console.log('C/C++ JSONC configuration tests passed');
}

if (require.main === module) {
    run(process.env.KEIL_ASSISTANT_EXTENSION_ROOT || path.resolve(__dirname, '..'));
}

module.exports = { run };
