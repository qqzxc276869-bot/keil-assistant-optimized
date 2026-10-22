"""Package the locally built Keil Assistant without a registry download."""

import json
from pathlib import Path
from xml.sax.saxutils import escape
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parent.parent
PACKAGE = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
OUTPUT = ROOT / f"keil-assistant-{PACKAGE['version']}-optimized.vsix"

FILES = [
    ROOT / name
    for name in ("package.json", "README.md", "README_EN.md", "CHANGELOG.md")
]
for directory in ("bin", "dist", "res", "syntaxes"):
    FILES.extend(path for path in (ROOT / directory).rglob("*") if path.is_file())
for dependency in ("xml2js", "sax", "xmlbuilder"):
    package_dir = ROOT / "node_modules" / dependency
    if not package_dir.is_dir():
        raise SystemExit(f"Missing runtime dependency: {package_dir}")
    FILES.extend(path for path in package_dir.rglob("*") if path.is_file())

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

content_types = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="txt" ContentType="text/plain" />
  <Default Extension="svg" ContentType="image/svg+xml" />
  <Default Extension="png" ContentType="image/png" />
  <Default Extension="exe" ContentType="application/octet-stream" />
  <Override PartName="/extension.vsixmanifest" ContentType="text/xml" />
</Types>'''

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

print(OUTPUT)
