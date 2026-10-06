"""Archive a completed portable build and verify CRC, privacy and extracted hashes."""
from pathlib import Path
import hashlib
import json
import sys
import zipfile

root = Path(__file__).resolve().parent.parent
package, archive, verify, report_path = (Path(value).resolve() for value in sys.argv[1:])
assert package.parent == root.parent and package.name.startswith('VSCode-win32-x64-')
assert (package / 'ShunCode.exe').is_file()
assert archive.parent == root / '.build/releases' and archive.suffix == '.zip'
assert verify.is_relative_to(root / '.build') and report_path.is_relative_to(root / '.build')
assert not archive.exists() and not verify.exists() and not report_path.exists()
files = sorted(item for item in package.rglob('*') if item.is_file())
for item in files:
    assert not item.is_symlink()
    parts = {part.lower() for part in item.relative_to(package).parts}
    assert not parts.intersection({'cookies', 'login data', 'state.vscdb', 'browser-profile', 'user-data', 'shared-data', '.env'}), item
with zipfile.ZipFile(archive, 'x', zipfile.ZIP_DEFLATED, compresslevel=6) as writer:
    for item in files:
        writer.write(item, item.relative_to(package).as_posix())
verify.mkdir()
with zipfile.ZipFile(archive) as reader:
    assert reader.testzip() is None
    for entry in reader.infolist():
        assert (verify / entry.filename).resolve().is_relative_to(verify)
    reader.extractall(verify)
hashes = {}
for relative in ['ShunCode.exe', 'Start-Nimora.cmd', 'README-Nimora.txt',
                 'resources/app/extensions/shuncode/dist/extension.js',
                 'resources/app/out/vs/workbench/workbench.desktop.main.js',
                 'resources/app/extensions/shuncode-webmcp/gateway/server.mjs',
                 'resources/app/extensions/shuncode-webmcp/extension.js']:
    before = hashlib.sha256((package / relative).read_bytes()).hexdigest()
    assert before == hashlib.sha256((verify / relative).read_bytes()).hexdigest(), relative
    hashes[relative] = before
assert hashes['resources/app/extensions/shuncode/dist/extension.js'] == hashlib.sha256((root / 'extensions/shuncode/dist/extension.js').read_bytes()).hexdigest()
assert (package / 'README-Nimora.txt').read_bytes() == (root / 'resources/nimora/README-Nimora.txt').read_bytes()
assert (package / 'resources/app/extensions/shuncode/src/nimora-product-shell.ts').read_bytes() == (root / 'extensions/shuncode/src/nimora-product-shell.ts').read_bytes()
with archive.open('rb') as stream:
    archive_hash = hashlib.file_digest(stream, 'sha256').hexdigest()
report = {'result': 'PASS', 'package': str(package), 'archive': str(archive), 'bytes': archive.stat().st_size,
          'sha256': archive_hash, 'entries': len(files), 'crc': 'PASS', 'privateProfileEntries': 0,
          'verifyDirectory': str(verify), 'hashes': hashes, 'sourcePackageUiIdentical': True,
          'sourcePackageExtensionIdentical': True, 'freshProviderAcceptance': 'NOT_TESTED',
          'stableSandboxCertification': 'NOT_CERTIFIED'}
with report_path.open('x', encoding='utf-8') as writer:
    json.dump(report, writer, ensure_ascii=False, indent=2)
print(json.dumps(report, ensure_ascii=False, indent=2))
