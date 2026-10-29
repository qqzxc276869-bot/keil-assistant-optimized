"""Package the locally built Keil Assistant without a registry download."""

import json
import shutil
import subprocess
from pathlib import Path
from xml.sax.saxutils import escape
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parent.parent
PACKAGE = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
OUTPUT = ROOT / f"keil-assistant-{PACKAGE['version']}-optimized.vsix"

# Never leave a same-version package that predates the current source tree.
if OUTPUT.is_file():
    OUTPUT.unlink()

npm = shutil.which("npm")
if npm is None:
    raise SystemExit("npm is required to check and build the extension before packaging")
for script in ("check", "build"):
    subprocess.run([npm, "run", script], cwd=ROOT, check=True)

FILES = [
    ROOT / name
    for name in ("package.json", "README.md", "README_EN.md", "CHANGELOG.md", "LICENSE")
]
for directory in ("bin", "dist", "res", "syntaxes"):
    FILES.extend(path for path in (ROOT / directory).rglob("*") if path.is_file())

lockfile = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))
installed_packages = lockfile.get("packages")
if not isinstance(installed_packages, dict):
    raise SystemExit("package-lock.json must contain a packages map")
for dependency in PACKAGE.get("dependencies", {}):
    if f"node_modules/{dependency}" not in installed_packages:
        raise SystemExit(f"Runtime dependency missing from package-lock.json: {dependency}")
for package_path, metadata in installed_packages.items():
    if not package_path.startswith("node_modules/") or metadata.get("dev"):
        continue
    package_dir = ROOT / package_path
    if (ROOT / "node_modules").resolve() not in package_dir.resolve().parents:
        raise SystemExit(f"Invalid runtime dependency path: {package_path}")
    if not package_dir.is_dir():
        if metadata.get("optional"):
            continue
        raise SystemExit(f"Missing runtime dependency: {package_dir}")
    FILES.extend(path for path in package_dir.rglob("*") if path.is_file())

FILES = sorted(set(FILES))

MAIN = ROOT / PACKAGE["main"]
if not MAIN.is_file():
    raise SystemExit(f"Build the extension first: {MAIN}")

identity = PACKAGE["name"]
version = PACKAGE["version"]
publisher = PACKAGE["publisher"]
manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="{escape(identity)}" Version="{escape(version)}" Publisher="{escape(publisher)}" />
    <DisplayName>{escape(PACKAGE['displayName'])}</DisplayName>
    <Description>{escape(PACKAGE['description'])}</Description>
    <Tags>{escape(','.join(PACKAGE['keywords']))}</Tags>
    <Categories>{escape(','.join(PACKAGE['categories']))}</Categories>
    <Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="{escape(PACKAGE['engines']['vscode'])}" /></Properties>
    <License>extension/LICENSE.txt</License>
    <Icon>extension/res/icons/icon.png</Icon>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/res/icons/icon.png" Addressable="true" />
  </Assets>
</PackageManifest>'''

known_content_types = {
    "exe": "application/octet-stream",
    "js": "application/javascript",
    "json": "application/json",
    "map": "application/json",
    "md": "text/markdown",
    "png": "image/png",
    "svg": "image/svg+xml",
    "ts": "text/plain",
    "txt": "text/plain",
}
extensions = sorted({file.suffix.lstrip(".").lower() for file in FILES if file.suffix})
extensionless = sorted(file for file in FILES if not file.suffix)
content_type_lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
]
for extension in extensions:
    content_type_lines.append(
        f'  <Default Extension="{escape(extension)}" '
        f'ContentType="{known_content_types.get(extension, "application/octet-stream")}" />'
    )
for file in extensionless:
    name = "extension/" + file.relative_to(ROOT).as_posix()
    content_type_lines.append(
        f'  <Override PartName="/{escape(name)}" ContentType="text/plain" />'
    )
content_type_lines.extend((
    '  <Override PartName="/extension/LICENSE.txt" ContentType="text/plain" />',
    '  <Override PartName="/extension.vsixmanifest" ContentType="text/xml" />',
    '</Types>',
))
content_types = "\n".join(content_type_lines)

with ZipFile(OUTPUT, "w", ZIP_DEFLATED) as archive:
    archive.writestr("[Content_Types].xml", content_types)
    archive.writestr("extension.vsixmanifest", manifest)
    archive.writestr("extension/LICENSE.txt", (ROOT / "LICENSE").read_bytes())
    for file in FILES:
        archive.write(file, "extension/" + file.relative_to(ROOT).as_posix())

with ZipFile(OUTPUT) as archive:
    if archive.testzip() is not None:
        raise SystemExit("VSIX archive validation failed")
    if "extension/" + PACKAGE["main"].lstrip("./") not in archive.namelist():
        raise SystemExit("VSIX is missing its main JavaScript file")
    if "extension/LICENSE" not in archive.namelist():
        raise SystemExit("VSIX is missing the README license link target")

print(OUTPUT)
