const assert = require('assert');
const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');

function asArray(value) {
    return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function parseXml(xml) {
    return new Promise((resolve, reject) => {
        xml2js.parseString(xml, { explicitArray: false }, (error, result) => {
            error ? reject(error) : resolve(result);
        });
    });
}

function getTarget(project, name) {
    return asArray(project.Project.Targets.Target).find((target) => target.TargetName === name);
}

function getGroup(target, name) {
    return asArray(target.Groups.Group).find((group) => group.GroupName === name);
}

function getFiles(group) {
    return group && group.Files ? asArray(group.Files.File) : [];
}

async function run(extensionRoot = path.resolve(__dirname, '..')) {
    const { addFileToKeilProject, createGroupInKeilProject, removeFileFromKeilProject } =
        require(path.join(extensionRoot, 'dist', 'src', 'KeilProjectEditor'));
    const scratchParent = path.resolve(__dirname, '..');
    const testRoot = fs.mkdtempSync(path.join(scratchParent, '.keil-assistant-project-edit-'));
    try {
        const projectDir = path.join(testRoot, 'Outer', 'Projects', 'Board', 'MDK-ARM');
        const sourceDir = path.join(testRoot, 'Outer', 'Core');
        const projectPath = path.join(projectDir, 'Project.uvprojx');
        const cPath = path.join(sourceDir, 'Src', 'clock.c');
        const extraPath = path.join(sourceDir, 'Src', 'extra.c');
        const hPath = path.join(sourceDir, 'Inc', 'config&bus.h');
        fs.mkdirSync(projectDir, { recursive: true });
        fs.mkdirSync(path.dirname(cPath), { recursive: true });
        fs.mkdirSync(path.dirname(hPath), { recursive: true });
        fs.writeFileSync(cPath, 'void clock_init(void) {}\n');
        fs.writeFileSync(extraPath, 'void extra_init(void) {}\n');
        fs.writeFileSync(hPath, '#pragma once\n');

        const initialXml = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<Project>',
            '  <SchemaVersion>2.1</SchemaVersion>',
            '  <Targets>',
            '    <Target>',
            '      <TargetName>Debug</TargetName>',
            '      <TargetOption><TargetCommonOption><OutputDirectory>Objects</OutputDirectory></TargetCommonOption></TargetOption>',
            '      <Groups>',
            '        <Group>',
            '          <GroupName>Application</GroupName>',
            '          <Files><File><FileName>main.c</FileName><FileType>1</FileType><FilePath>..\\..\\..\\Core\\Src\\main.c</FilePath></File></Files>',
            '        </Group>',
            '        <Group><GroupName>Headers</GroupName></Group>',
            '      </Groups>',
            '    </Target>',
            '    <Target>',
            '      <TargetName>Release</TargetName>',
            '      <TargetOption><TargetCommonOption><OutputDirectory>Release</OutputDirectory></TargetCommonOption></TargetOption>',
            '      <Groups><Group><GroupName>Application</GroupName><Files><File><FileName>release.c</FileName><FileType>1</FileType><FilePath>release.c</FilePath></File></Files></Group></Groups>',
            '    </Target>',
            '  </Targets>',
            '</Project>',
            ''
        ].join('\r\n');
        fs.writeFileSync(projectPath, initialXml, 'utf8');

        const addedC = await addFileToKeilProject(projectPath, 'Debug', 'Application', cPath);
        assert.deepStrictEqual(addedC, { status: 'added', groupName: 'Application' });
        let actualXml = fs.readFileSync(projectPath, 'utf8');
        assert.ok(!/(^|[^\r])\n/.test(actualXml), 'CRLF line endings should be preserved');
        const releaseSection = /<Target>\s*<TargetName>Release<\/TargetName>[\s\S]*?<\/Target>/.exec(initialXml)[0];
        assert.ok(actualXml.includes(releaseSection), 'other target text should remain unchanged');
        let parsed = await parseXml(actualXml);
        let debugFiles = getFiles(getGroup(getTarget(parsed, 'Debug'), 'Application'));
        assert.strictEqual(debugFiles.filter((file) => file.FileName === 'clock.c').length, 1);
        assert.strictEqual(debugFiles.find((file) => file.FileName === 'clock.c').FileType, '1');
        assert.strictEqual(path.resolve(projectDir, debugFiles.find((file) => file.FileName === 'clock.c').FilePath), cPath);
        assert.strictEqual(getFiles(getGroup(getTarget(parsed, 'Release'), 'Application')).length, 1);

        const addedH = await addFileToKeilProject(projectPath, 'Debug', 'Headers', hPath);
        assert.deepStrictEqual(addedH, { status: 'added', groupName: 'Headers' });
        actualXml = fs.readFileSync(projectPath, 'utf8');
        assert.ok(actualXml.includes('config&amp;bus.h'), 'XML special characters must be escaped');
        parsed = await parseXml(actualXml);
        const headerFiles = getFiles(getGroup(getTarget(parsed, 'Debug'), 'Headers'));
        assert.strictEqual(headerFiles.length, 1, 'a group without <Files> should accept a file');
        assert.strictEqual(headerFiles[0].FileName, 'config&bus.h');
        assert.strictEqual(headerFiles[0].FileType, '5');
        assert.strictEqual(path.resolve(projectDir, headerFiles[0].FilePath), hPath);

        const beforeDuplicate = actualXml;
        const duplicate = await addFileToKeilProject(projectPath, 'Debug', 'Headers', cPath.replace(/\\/g, '/'));
        assert.deepStrictEqual(duplicate, { status: 'already-present', groupName: 'Application' });
        assert.strictEqual(fs.readFileSync(projectPath, 'utf8'), beforeDuplicate, 'duplicate should not edit the project');

        await assert.rejects(() => addFileToKeilProject(projectPath, 'Missing', 'Application', cPath));
        await assert.rejects(() => addFileToKeilProject(projectPath, 'Debug', 'Missing', cPath));
        assert.strictEqual(fs.readFileSync(projectPath, 'utf8'), beforeDuplicate, 'invalid selection should not edit the project');

        const createdGroup = await createGroupInKeilProject(projectPath, 'Debug', 'Board & IO');
        assert.deepStrictEqual(createdGroup, { status: 'created' });
        actualXml = fs.readFileSync(projectPath, 'utf8');
        assert.ok(!/(^|[^\r])\n/.test(actualXml), 'group creation should preserve CRLF line endings');
        assert.ok(actualXml.includes('Board &amp; IO'), 'group names must be XML escaped');
        assert.ok(actualXml.includes(releaseSection), 'group creation should not change the other target');
        parsed = await parseXml(actualXml);
        assert.ok(getGroup(getTarget(parsed, 'Debug'), 'Board & IO'), 'new group should appear in the selected target');
        assert.deepStrictEqual(getFiles(getGroup(getTarget(parsed, 'Debug'), 'Board & IO')), [], 'new group should be empty');
        assert.strictEqual(getGroup(getTarget(parsed, 'Release'), 'Board & IO'), undefined, 'new group should not leak to another target');

        const beforeDuplicateGroup = actualXml;
        assert.deepStrictEqual(await createGroupInKeilProject(projectPath, 'Debug', 'Board & IO'),
            { status: 'already-present' });
        assert.strictEqual(fs.readFileSync(projectPath, 'utf8'), beforeDuplicateGroup,
            'creating an existing group should be a byte-for-byte no-op');
        await assert.rejects(() => createGroupInKeilProject(projectPath, 'Missing', 'Unreachable'));
        assert.strictEqual(fs.readFileSync(projectPath, 'utf8'), beforeDuplicateGroup,
            'invalid target should not change the project');

        assert.deepStrictEqual(await addFileToKeilProject(projectPath, 'Debug', 'Board & IO', extraPath),
            { status: 'added', groupName: 'Board & IO' });
        parsed = await parseXml(fs.readFileSync(projectPath, 'utf8'));
        assert.strictEqual(getFiles(getGroup(getTarget(parsed, 'Debug'), 'Board & IO'))[0].FileName, 'extra.c',
            'adding a file to the newly created group should work');

        assert.deepStrictEqual(await removeFileFromKeilProject(projectPath, 'Debug', 'Board & IO', extraPath),
            { status: 'removed' });
        actualXml = fs.readFileSync(projectPath, 'utf8');
        assert.ok(!/(^|[^\r])\n/.test(actualXml), 'file removal should preserve CRLF line endings');
        assert.ok(actualXml.includes(releaseSection), 'file removal should not change the other target');
        parsed = await parseXml(actualXml);
        assert.deepStrictEqual(getFiles(getGroup(getTarget(parsed, 'Debug'), 'Board & IO')), [],
            'removing the only file should leave a valid empty group');
        assert.ok(fs.existsSync(extraPath), 'removing a project reference must not delete the source file from disk');

        const beforeDuplicateRemoval = actualXml;
        assert.deepStrictEqual(await removeFileFromKeilProject(projectPath, 'Debug', 'Board & IO', extraPath),
            { status: 'not-present' });
        assert.strictEqual(fs.readFileSync(projectPath, 'utf8'), beforeDuplicateRemoval,
            'removing a missing reference should be a byte-for-byte no-op');
        assert.deepStrictEqual(await removeFileFromKeilProject(projectPath, 'Release', 'Application', cPath),
            { status: 'not-present' });
        assert.strictEqual(fs.readFileSync(projectPath, 'utf8'), beforeDuplicateRemoval,
            'removing from the wrong target should not affect another target');

        const staleReference = path.join(projectDir, 'release.c');
        assert.ok(!fs.existsSync(staleReference), 'fixture should contain a stale project reference');
        assert.deepStrictEqual(await removeFileFromKeilProject(projectPath, 'Release', 'Application', staleReference),
            { status: 'removed' }, 'a stale reference should be removable even when its disk file is missing');
        parsed = await parseXml(fs.readFileSync(projectPath, 'utf8'));
        assert.deepStrictEqual(getFiles(getGroup(getTarget(parsed, 'Release'), 'Application')), [],
            'stale reference should be removed from the selected target');
        assert.strictEqual(getFiles(getGroup(getTarget(parsed, 'Debug'), 'Application'))
            .filter((file) => file.FileName === 'clock.c').length, 1,
            'removing a Release reference should preserve Debug files');

        const legacyPath = path.join(projectDir, 'Legacy.uvproj');
        fs.writeFileSync(legacyPath, initialXml, 'utf8');
        const legacyAdded = await addFileToKeilProject(legacyPath, 'Debug', 'Application', cPath);
        assert.strictEqual(legacyAdded.status, 'added', '.uvproj projects should also accept C files');
        console.log('Project edit test passed: add/remove file, create group, no-op, stale references, target isolation, CRLF, XML, .uvproj.');
    } finally {
        const resolvedTestRoot = path.resolve(testRoot);
        if (path.dirname(resolvedTestRoot) === scratchParent &&
            path.basename(resolvedTestRoot).startsWith('.keil-assistant-project-edit-')) {
            fs.rmSync(testRoot, { recursive: true, force: true });
        }
    }
}

module.exports = { run };

if (require.main === module) {
    run().catch((error) => { console.error(error); process.exitCode = 1; });
}
