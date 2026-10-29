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
    const { addFileToKeilProject, addFilesToKeilProject, getKeilFileType,
        createGroupInKeilProject, removeFileFromKeilProject, addIncludeDirectoryToKeilProject } =
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
        const asmPath = path.join(projectDir, 'startup_stm32f103xe.s');
        const uppercaseAsmPath = path.join(projectDir, 'startup_extra.S');
        const cppPath = path.join(sourceDir, 'Src', 'device.cpp');
        const libPath = path.join(sourceDir, 'Lib', 'driver.lib');
        fs.mkdirSync(projectDir, { recursive: true });
        fs.mkdirSync(path.dirname(cPath), { recursive: true });
        fs.mkdirSync(path.dirname(hPath), { recursive: true });
        fs.mkdirSync(path.dirname(libPath), { recursive: true });
        fs.writeFileSync(cPath, 'void clock_init(void) {}\n');
        fs.writeFileSync(extraPath, 'void extra_init(void) {}\n');
        fs.writeFileSync(hPath, '#pragma once\n');
        fs.writeFileSync(asmPath, '    THUMB\n');
        fs.writeFileSync(uppercaseAsmPath, '    THUMB\n');
        fs.writeFileSync(cppPath, 'int device = 0;\n');
        fs.writeFileSync(libPath, 'test library\n');

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

        assert.strictEqual(getKeilFileType(asmPath), '2', 'the supplied STM32 startup file is Keil assembler');
        assert.strictEqual(getKeilFileType(uppercaseAsmPath), '2', 'uppercase .S must be recognized');
        assert.strictEqual(getKeilFileType(cppPath), '8', 'C++ sources require Keil FileType 8');
        assert.strictEqual(getKeilFileType(libPath), '4', 'Keil libraries require FileType 4');
        assert.strictEqual(getKeilFileType(path.join(sourceDir, 'notes.txt')), undefined,
            'unknown types must not be assigned an arbitrary compiler type');
        const originalRename = fs.renameSync;
        let batchWrites = 0;
        fs.renameSync = (from, to) => {
            if (to === projectPath) { batchWrites++; }
            return originalRename(from, to);
        };
        let batchResults;
        try {
            batchResults = await addFilesToKeilProject(projectPath, 'Debug', 'Application',
                [asmPath, uppercaseAsmPath, cppPath, libPath, cPath, asmPath]);
        } finally {
            fs.renameSync = originalRename;
        }
        assert.deepStrictEqual(batchResults, [
            { status: 'added', groupName: 'Application' },
            { status: 'added', groupName: 'Application' },
            { status: 'added', groupName: 'Application' },
            { status: 'added', groupName: 'Application' },
            { status: 'already-present', groupName: 'Application' },
            { status: 'already-present', groupName: 'Application' }
        ]);
        assert.strictEqual(batchWrites, 1, 'a multi-file selection should write the project once');
        actualXml = fs.readFileSync(projectPath, 'utf8');
        assert.ok(!/(^|[^\r])\n/.test(actualXml), 'batch insert should preserve CRLF');
        assert.ok(actualXml.includes(releaseSection), 'batch insert must leave other targets unchanged');
        parsed = await parseXml(actualXml);
        debugFiles = getFiles(getGroup(getTarget(parsed, 'Debug'), 'Application'));
        assert.strictEqual(debugFiles.find((file) => file.FileName === path.basename(asmPath)).FileType, '2');
        assert.strictEqual(debugFiles.find((file) => file.FileName === path.basename(uppercaseAsmPath)).FileType, '2');
        assert.strictEqual(debugFiles.find((file) => file.FileName === path.basename(cppPath)).FileType, '8');
        assert.strictEqual(debugFiles.find((file) => file.FileName === path.basename(libPath)).FileType, '4');
        assert.strictEqual(debugFiles.filter((file) => file.FileName === path.basename(asmPath)).length, 1,
            'duplicate selection must not create a second startup file');
        const allExisting = await addFilesToKeilProject(projectPath, 'Debug', 'Headers', [asmPath, cPath]);
        assert.deepStrictEqual(allExisting, [
            { status: 'already-present', groupName: 'Application' },
            { status: 'already-present', groupName: 'Application' }
        ], 'existing startup files should report their actual Keil group');
        assert.strictEqual(fs.readFileSync(projectPath, 'utf8'), actualXml,
            'an entirely duplicate batch should not write the project');
        const beforeRejectedBatch = actualXml;
        await assert.rejects(() => addFilesToKeilProject(projectPath, 'Debug', 'Application',
            [extraPath, path.join(sourceDir, 'notes.txt')]), /Unsupported Keil file type/);
        await assert.rejects(() => addFilesToKeilProject(projectPath, 'Debug', 'Application',
            [extraPath, path.join(sourceDir, 'missing.c')]), /does not exist/);
        assert.strictEqual(fs.readFileSync(projectPath, 'utf8'), beforeRejectedBatch,
            'invalid batches must leave the project unchanged');

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

        const attributedFilesPath = path.join(projectDir, 'AttributedFiles.uvprojx');
        fs.writeFileSync(attributedFilesPath, initialXml.replace(
            '<Group><GroupName>Headers</GroupName></Group>',
            '<Group><GroupName>Headers</GroupName><Files marker="keep &amp; stay"/></Group>'
        ), 'utf8');
        assert.strictEqual((await addFileToKeilProject(attributedFilesPath, 'Debug', 'Headers', hPath)).status, 'added');
        const attributedFilesXml = fs.readFileSync(attributedFilesPath, 'utf8');
        assert.ok(attributedFilesXml.includes('<Files marker="keep &amp; stay">'),
            'expanding a self-closing Files element must preserve its attributes');
        const attributedFiles = getGroup(getTarget(await parseXml(attributedFilesXml), 'Debug'), 'Headers').Files;
        assert.strictEqual(attributedFiles.$.marker, 'keep & stay');
        assert.strictEqual(asArray(attributedFiles.File)[0].FileName, path.basename(hPath));

        const attributedGroupsPath = path.join(projectDir, 'AttributedGroups.uvprojx');
        fs.writeFileSync(attributedGroupsPath, [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<Project><Targets><Target><TargetName>Debug</TargetName>',
            '<Groups marker="keep &amp; stay"/>',
            '</Target></Targets></Project>'
        ].join('\r\n'), 'utf8');
        assert.strictEqual((await createGroupInKeilProject(attributedGroupsPath, 'Debug', 'New Group')).status,
            'created');
        const attributedGroupsXml = fs.readFileSync(attributedGroupsPath, 'utf8');
        assert.ok(attributedGroupsXml.includes('<Groups marker="keep &amp; stay">'),
            'expanding a self-closing Groups element must preserve its attributes');
        const attributedTarget = getTarget(await parseXml(attributedGroupsXml), 'Debug');
        assert.strictEqual(attributedTarget.Groups.$.marker, 'keep & stay');
        assert.ok(getGroup(attributedTarget, 'New Group'));

        const includeDir = path.dirname(hPath);
        const newIncludeDir = path.join(sourceDir, 'Inc & More');
        fs.mkdirSync(newIncludeDir);
        const existingInclude = path.relative(projectDir, includeDir).replace(/\\/g, '/');
        const storedNewInclude = path.relative(projectDir, newIncludeDir).replace(/\//g, '\\');
        const includeProjectPath = path.join(projectDir, 'IncludePaths.uvprojx');
        const includeXml = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<Project>',
            '  <Targets>',
            '    <Target>',
            '      <TargetName>Debug</TargetName>',
            '      <TargetOption><TargetArmAds><Cads><VariousControls>',
            `        <IncludePath>${existingInclude}</IncludePath>`,
            '      </VariousControls></Cads></TargetArmAds></TargetOption>',
            '    </Target>',
            '    <Target>',
            '      <TargetName>Release</TargetName>',
            '      <TargetOption><TargetArmAds><Cads><VariousControls><IncludePath>Release\\Inc</IncludePath></VariousControls></Cads></TargetArmAds></TargetOption>',
            '    </Target>',
            '  </Targets>',
            '</Project>',
            ''
        ].join('\r\n');
        fs.writeFileSync(includeProjectPath, includeXml, 'utf8');
        assert.deepStrictEqual(await addIncludeDirectoryToKeilProject(includeProjectPath, 'Debug', includeDir),
            { status: 'already-present' }, 'mixed path separators should be deduplicated');
        assert.strictEqual(fs.readFileSync(includeProjectPath, 'utf8'), includeXml,
            'an existing include directory should leave the project byte-for-byte unchanged');
        assert.deepStrictEqual(await addIncludeDirectoryToKeilProject(includeProjectPath, 'Debug', newIncludeDir),
            { status: 'created' });
        const updatedIncludeXml = fs.readFileSync(includeProjectPath, 'utf8');
        assert.ok(!/(^|[^\r])\n/.test(updatedIncludeXml), 'include path changes should preserve CRLF');
        assert.ok(updatedIncludeXml.includes('Inc &amp; More'), 'include paths must be XML escaped');
        const releaseIncludeSection = /<Target>\s*<TargetName>Release<\/TargetName>[\s\S]*?<\/Target>/.exec(includeXml)[0];
        assert.ok(updatedIncludeXml.includes(releaseIncludeSection), 'other target XML should remain unchanged');
        const includeParsed = await parseXml(updatedIncludeXml);
        const debugInclude = getTarget(includeParsed, 'Debug').TargetOption.TargetArmAds.Cads.VariousControls.IncludePath;
        assert.deepStrictEqual(debugInclude.split(';'), [existingInclude, storedNewInclude]);
        assert.strictEqual(getTarget(includeParsed, 'Release').TargetOption.TargetArmAds.Cads.VariousControls.IncludePath,
            'Release\\Inc', 'other target include paths should remain unchanged');

        const missingIncludePath = path.join(projectDir, 'MissingInclude.uvprojx');
        fs.writeFileSync(missingIncludePath, includeXml.replace(
            `<IncludePath>${existingInclude}</IncludePath>`, '<Define>BOARD</Define>'), 'utf8');
        assert.strictEqual((await addIncludeDirectoryToKeilProject(missingIncludePath, 'Debug', newIncludeDir)).status,
            'created', 'missing IncludePath should be created');
        const missingIncludeParsed = await parseXml(fs.readFileSync(missingIncludePath, 'utf8'));
        assert.strictEqual(getTarget(missingIncludeParsed, 'Debug').TargetOption.TargetArmAds.Cads.VariousControls.IncludePath,
            storedNewInclude);
        assert.strictEqual(getTarget(missingIncludeParsed, 'Debug').TargetOption.TargetArmAds.Cads.VariousControls.Define,
            'BOARD', 'neighboring compiler options should remain intact');

        const missingControlsPath = path.join(projectDir, 'MissingControls.uvprojx');
        fs.writeFileSync(missingControlsPath, includeXml.replace(
            `<VariousControls>\r\n        <IncludePath>${existingInclude}</IncludePath>\r\n      </VariousControls>`,
            '<Optimization>2</Optimization>'), 'utf8');
        assert.strictEqual((await addIncludeDirectoryToKeilProject(missingControlsPath, 'Debug', newIncludeDir)).status,
            'created', 'missing VariousControls should be created');
        const missingControlsParsed = await parseXml(fs.readFileSync(missingControlsPath, 'utf8'));
        const missingControlsCads = getTarget(missingControlsParsed, 'Debug').TargetOption.TargetArmAds.Cads;
        assert.strictEqual(missingControlsCads.VariousControls.IncludePath, storedNewInclude);
        assert.strictEqual(missingControlsCads.Optimization, '2');

        const selfClosingPath = path.join(projectDir, 'SelfClosingIncludes.uvprojx');
        fs.writeFileSync(selfClosingPath, includeXml.replace(
            `<IncludePath>${existingInclude}</IncludePath>`, '<IncludePath marker="keep &amp; stay"/>'), 'utf8');
        assert.strictEqual((await addIncludeDirectoryToKeilProject(selfClosingPath, 'Debug', newIncludeDir)).status,
            'created');
        const selfClosingXml = fs.readFileSync(selfClosingPath, 'utf8');
        assert.ok(selfClosingXml.includes(`<IncludePath marker="keep &amp; stay">${storedNewInclude.replace(/&/g, '&amp;')}</IncludePath>`),
            'expanding a self-closing IncludePath should preserve attributes');
        const selfClosingParsed = await parseXml(selfClosingXml);
        assert.strictEqual(getTarget(selfClosingParsed, 'Debug').TargetOption.TargetArmAds.Cads.VariousControls.IncludePath.$.marker,
            'keep & stay');

        const selfClosingControlsPath = path.join(projectDir, 'SelfClosingControls.uvprojx');
        fs.writeFileSync(selfClosingControlsPath, includeXml.replace(
            `<VariousControls>\r\n        <IncludePath>${existingInclude}</IncludePath>\r\n      </VariousControls>`,
            '<VariousControls marker="keep &amp; stay"/>'), 'utf8');
        assert.strictEqual((await addIncludeDirectoryToKeilProject(selfClosingControlsPath, 'Debug', newIncludeDir)).status,
            'created');
        const selfClosingControls = getTarget(await parseXml(fs.readFileSync(selfClosingControlsPath, 'utf8')),
            'Debug').TargetOption.TargetArmAds.Cads.VariousControls;
        assert.strictEqual(selfClosingControls.$.marker, 'keep & stay');
        assert.strictEqual(selfClosingControls.IncludePath, storedNewInclude);

        const c51ProjectPath = path.join(projectDir, 'C51.uvproj');
        const c51Xml = includeXml.replace(/TargetArmAds/g, 'Target51').replace(/Cads/g, 'C51');
        fs.writeFileSync(c51ProjectPath, c51Xml, 'utf8');
        assert.strictEqual((await addIncludeDirectoryToKeilProject(c51ProjectPath, 'Debug', newIncludeDir)).status,
            'created', 'C51 projects should use Target51/C51/VariousControls');
        const c51Parsed = await parseXml(fs.readFileSync(c51ProjectPath, 'utf8'));
        assert.deepStrictEqual(getTarget(c51Parsed, 'Debug').TargetOption.Target51.C51.VariousControls.IncludePath.split(';'),
            [existingInclude, storedNewInclude]);

        const projectDirIncludePath = path.join(projectDir, 'ProjectDirInclude.uvprojx');
        fs.writeFileSync(projectDirIncludePath, includeXml.replace(
            `<IncludePath>${existingInclude}</IncludePath>`, '<IncludePath/>'), 'utf8');
        assert.strictEqual((await addIncludeDirectoryToKeilProject(projectDirIncludePath, 'Debug', projectDir)).status,
            'created', 'the project directory should be represented as a dot');
        assert.strictEqual(getTarget(await parseXml(fs.readFileSync(projectDirIncludePath, 'utf8')),
            'Debug').TargetOption.TargetArmAds.Cads.VariousControls.IncludePath, '.');

        const bomProjectPath = path.join(projectDir, 'BomIncludes.uvprojx');
        fs.writeFileSync(bomProjectPath, '\uFEFF' + includeXml, 'utf8');
        assert.strictEqual((await addIncludeDirectoryToKeilProject(bomProjectPath, 'Debug', newIncludeDir)).status,
            'created');
        assert.ok(fs.readFileSync(bomProjectPath, 'utf8').startsWith('\uFEFF'),
            'the original UTF-8 BOM should be preserved');

        const beforeInvalidInclude = fs.readFileSync(includeProjectPath, 'utf8');
        await assert.rejects(() => addIncludeDirectoryToKeilProject(includeProjectPath, 'Debug',
            path.join(testRoot, 'missing-directory')));
        assert.strictEqual(fs.readFileSync(includeProjectPath, 'utf8'), beforeInvalidInclude,
            'invalid include directories should not edit the project');
        await assert.rejects(() => addIncludeDirectoryToKeilProject(projectPath, 'Debug', newIncludeDir),
            /compiler options/, 'a target without Keil C compiler options should be rejected');

        console.log('Project edit test passed: add/remove file, create group/include paths, no-op, stale references, target isolation, CRLF, XML, .uvproj.');
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
