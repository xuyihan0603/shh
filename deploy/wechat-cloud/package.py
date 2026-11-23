"""Create the private source archive accepted by the WeChat Cloud Hosting console."""

import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / '.runtime' / 'wechat-test'
LIBRARIES = ('customer-segments', 'domain', 'invitation', 'pilot', 'reception', 'workbook')


def initial_admin():
    OUTPUT.mkdir(mode=0o700, parents=True, exist_ok=True)
    if os.name == 'nt':
        principal = subprocess.check_output(['whoami'], text=True).strip()
        subprocess.run(['icacls', str(OUTPUT), '/inheritance:r', '/grant:r',
                        principal + ':(OI)(CI)F'], check=True, stdout=subprocess.DEVNULL)
    else:
        OUTPUT.chmod(0o700)
    path = OUTPUT / 'first-login.txt'
    if not path.exists():
        with path.open('x', encoding='utf-8') as f:
            f.write('manager\n' + secrets.token_urlsafe(24) + '\n')
        path.chmod(0o600)
    account, password = path.read_text(encoding='utf-8').splitlines()
    if account != 'manager' or not 10 <= len(password) <= 128:
        raise ValueError('Invalid local first-login.txt')
    salt = secrets.token_hex(16)
    digest = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=64)
    verifier = OUTPUT / 'admin-verifier.txt'
    verifier.write_text(salt + ':' + digest.hex() + '\n', encoding='utf-8')
    verifier.chmod(0o600)
    return json.dumps({'salt': salt, 'hash': digest.hex()})


def main():
    server = ROOT / 'server'
    files = [server / name for name in ('package.json', 'package-lock.json')]
    files += sorted(server.glob('*.js'))
    files += sorted((server / 'public').glob('*.*'))
    files += [ROOT / 'miniprogram' / 'lib' / (name + '.js') for name in LIBRARIES]
    for path in files:
        if not path.is_file():
            raise FileNotFoundError(path)
    record = initial_admin()
    archive = OUTPUT / 'shh-booking.zip'
    temporary = archive.with_suffix('.tmp')
    with ZipFile(temporary, 'w', compression=ZIP_DEFLATED) as bundle:
        bundle.write(ROOT / 'Dockerfile', 'Dockerfile')
        for path in files:
            bundle.write(path, path.relative_to(ROOT).as_posix())
        bundle.writestr('server/private/initial-admin.json', record)
    temporary.replace(archive)
    print(archive)


if __name__ == '__main__':
    main()
