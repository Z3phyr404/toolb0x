#!/usr/bin/python3
"""Fixed-scope additional private VPN. Run explicitly with Python -I as root."""
from pathlib import Path
import os
import stat
import subprocess
import re
import ipaddress
import json
import importlib.util
import tempfile
import sys
import time
import pwd

EXPORT_HOME = Path('/home/michael')


def export_identity():
    account = pwd.getpwnam('michael')
    if account.pw_dir != str(EXPORT_HOME) or account.pw_uid == 0:
        raise RuntimeError('Unexpected export account')
    return account.pw_uid, account.pw_gid


def check_directory(parent, owners):
    info = parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid not in owners or info.st_mode & 0o022:
        raise RuntimeError('Unsafe directory')


def check_open_directory(fd, owners):
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid not in owners or info.st_mode & 0o022:
        raise RuntimeError('Unsafe directory handle')


def export_write(target, content, uid, gid):
    """Use openat and O_NOFOLLOW throughout user-controlled export ancestry."""
    parent_fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for name in target.parent.parts[1:]:
            try:
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
            except FileNotFoundError:
                os.mkdir(name, 0o700, dir_fd=parent_fd)
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
                os.fchown(child, uid, gid)
            try:
                check_open_directory(child, (0, uid))
            except BaseException:
                os.close(child)
                raise
            os.close(parent_fd)
            parent_fd = child
        info = os.fstat(parent_fd)
        if info.st_uid != uid or info.st_mode & 0o077:
            raise RuntimeError('Private user directory required')
        fd = os.open(target.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=parent_fd)
        created = os.fstat(fd)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
                os.fchown(stream.fileno(), uid, gid)
        except BaseException:
            actual = os.stat(target.name, dir_fd=parent_fd, follow_symlinks=False)
            if (actual.st_dev, actual.st_ino) != (created.st_dev, created.st_ino):
                raise RuntimeError('Foreign export replacement retained') from None
            os.unlink(target.name, dir_fd=parent_fd)
            raise
    finally:
        os.close(parent_fd)


def export_profile(device):
    if device not in DEVICES:
        raise ValueError('Only iphone/mac profiles permitted')
    uid, gid = export_identity()
    source = PKI / (device + '.ovpn')
    # Validate every source component before touching the user destination.
    for parent in source.parents:
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, os.geteuid()):
            raise RuntimeError('Unsafe source directory')
        check_directory(parent, (0, os.geteuid()))
    target = EXPORT_HOME / '.local/share/private-vpn' / (device + '.ovpn')
    info = source.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise RuntimeError('Unsafe source profile')
    export_write(target, source.read_bytes(), uid, gid)
    return target


def validate_manifest(data):
    if data.get('version') != 1 or data.get('directory', [None])[0] != str(PKI):
        raise RuntimeError('Invalid ownership manifest')
    allowed_names = {'ca.key', 'ca.crt', 'ca.cnf', 'index.txt', 'index.txt.attr', 'index.txt.old',
                     'index.txt.attr.old', 'serial', 'serial.old', 'crlnumber', 'crlnumber.old',
                     'crl.pem', 'tls-crypt.key', '1000.pem', '1001.pem', '1002.pem'}
    allowed_names.update(name + suffix for name in ('server', *DEVICES)
                         for suffix in ('.key', '.crt', '.csr', '.ovpn'))
    entries = data.get('files')
    if not isinstance(entries, list) or len(entries) > 64:
        raise RuntimeError('Invalid file inventory')
    paths = []
    for entry in entries:
        if not isinstance(entry, list) or len(entry) != 3:
            raise RuntimeError('Invalid file identity')
        path, device, inode = entry
        p = Path(path)
        if p not in (CONFIG, HOOK, UNIT_PATH) and not (p.parent == PKI and p.name in allowed_names):
            raise RuntimeError('Out-of-scope manifest path')
        if not isinstance(device, int) or not isinstance(inode, int) or p in paths:
            raise RuntimeError('Invalid file identity')
        paths.append(p)
    if not {CONFIG, HOOK, UNIT_PATH}.issubset(paths):
        raise RuntimeError('Missing deployment inventory')
    return [(Path(p), device, inode) for p, device, inode in entries]


def load_installation():
    manifest = PKI / 'install-state.json'
    safe_components(manifest)
    info = manifest.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_size > 65536:
        raise RuntimeError('Unsafe manifest')
    data = json.loads(manifest.read_text())
    state = DeploymentFiles()
    state.owned = validate_manifest(data)
    directory = data['directory']
    if len(directory) != 3 or not all(isinstance(n, int) for n in directory[1:]):
        raise RuntimeError('Invalid directory identity')
    state.directory = (PKI, *directory[1:])
    actual = PKI.lstat()
    if (actual.st_dev, actual.st_ino) != tuple(directory[1:]):
        raise RuntimeError('PKI directory replaced')
    for p, device, inode in state.owned:
        actual = p.lstat()
        if not stat.S_ISREG(actual.st_mode) or actual.st_uid != 0 or (actual.st_dev, actual.st_ino) != (device, inode):
            raise RuntimeError('Owned file replaced; refusing rollback')
    state.owned.append((manifest, info.st_dev, info.st_ino))
    return data, state


def rollback():
    data, state = load_installation()
    run(['/usr/bin/systemctl', 'disable', UNIT])
    run(['/usr/bin/systemctl', 'stop', UNIT])
    if service_state(UNIT)[0] not in ('inactive', 'failed') or service_state(UNIT)[1] == 'enabled':
        raise RuntimeError('Service teardown not verified; files retained')
    network_module().apply('down')
    cleanup_firewall()
    verify_unchanged(data['baseline'])
    links = json.loads(run(['/usr/sbin/ip', '-j', 'link', 'show']))
    if any(link['ifname'] == 'tunovpn' for link in links):
        raise RuntimeError('Residual tunnel; files retained')
    state.cleanup()
    run(['/usr/bin/systemctl', 'daemon-reload'])
    return data['backup']


def network_module():
    source = Path(__file__).with_name('private-openvpn-network.py')
    spec = importlib.util.spec_from_file_location('private_openvpn_network', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_snapshot(s):
    if s['conflicts'] or 'tunovpn' in s['interfaces']:
        raise RuntimeError('Existing owned resources; refusing takeover')
    if s['own_service'][2] != 'not-found' or s['own_service'][0] != 'inactive' or s['own_service'][1] not in ('', 'disabled'):
        raise RuntimeError('Existing service; refusing takeover')
    if s['wg'] != ['active', 'enabled'] or s['forwarding'] != ['1', '1', '2']:
        raise RuntimeError('Unexpected WireGuard/forwarding baseline')
    if not {'eth0', 'wg0'}.issubset(s['interfaces']):
        raise RuntimeError('Unexpected interfaces')
    if not {'46.225.140.44/32', '2a01:4f8:1c19:3ea5::1/64'}.issubset(s['addresses']):
        raise RuntimeError('Unexpected public addresses')
    expected_defaults = {'172.31.1.1', 'fe80::1'}
    defaults = [r for r in s['routes'] if r.get('dst') in ('default', '0.0.0.0/0', '::/0')]
    if any(r.get('dev') != 'eth0' for r in defaults) or not expected_defaults.issubset({r.get('gateway') for r in defaults}):
        raise RuntimeError('Unexpected default routes')
    subnets = [ipaddress.ip_network(n) for n in ('10.78.78.0/24', 'fd78:78:78::/64')]
    for route in s['routes']:
        destination = route.get('dst')
        if not destination or destination in ('default', '0.0.0.0/0', '::/0'):
            continue
        try:
            net = ipaddress.ip_network(destination, strict=False)
        except ValueError:
            raise RuntimeError('Unrecognized route') from None
        if any(net.version == own.version and net.overlaps(own) for own in subnets):
            raise RuntimeError('VPN subnet overlaps an existing policy-table route')
    if 'Status: active' not in s['ufw'] or 'deny (incoming), allow (outgoing), deny (routed)' not in s['ufw']:
        raise RuntimeError('Unexpected UFW baseline')
    if not re.search(r'^IPV6=yes$', s['ufw_config'], re.M) or not re.search(r'^DEFAULT_FORWARD_POLICY="DROP"$', s['ufw_config'], re.M):
        raise RuntimeError('Dual-stack routed DROP required')
    if re.search(r':1194(?:\s|$)', s['listeners']):
        raise RuntimeError('TCP1194 occupied')
    if any(value in s['numbered'] for value in (TAG, 'tunovpn', '10.78.78.', 'fd78:78:78:')):
        raise RuntimeError('Existing VPN firewall resources')


def service_state(unit):
    text = run(['/usr/bin/systemctl', 'show', unit, '--property=ActiveState,UnitFileState,LoadState'])
    values = dict(line.split('=', 1) for line in text.splitlines() if '=' in line)
    return [values.get(k, '') for k in ('ActiveState', 'UnitFileState', 'LoadState')]


def snapshot():
    addresses = json.loads(run(['/usr/sbin/ip', '-j', 'address', 'show', 'dev', 'eth0']))
    return dict(
        conflicts=[str(p) for p in (PKI, CONFIG, HOOK, UNIT_PATH,
                   UNIT_PATH.with_name(UNIT_PATH.name + '.d'),
                   Path('/run/systemd/system') / UNIT,
                   Path('/run/systemd/system') / (UNIT + '.d'),
                   Path('/etc/openvpn/private-toolbox.conf'),
                   Path('/etc/systemd/system/openvpn-server@private-toolbox.service.d')) if os.path.lexists(p)],
        interfaces=[r['ifname'] for r in json.loads(run(['/usr/sbin/ip', '-j', 'link', 'show']))],
        addresses=[f"{a['local']}/{a['prefixlen']}" for r in addresses for a in r['addr_info']],
        routes=sum((json.loads(run(['/usr/sbin/ip', family, '-j', 'route', 'show', 'table', 'all']))
                    for family in ('-4', '-6')), []),
        forwarding=[Path(p).read_text().strip() for p in ('/proc/sys/net/ipv4/ip_forward',
                    '/proc/sys/net/ipv6/conf/all/forwarding', '/proc/sys/net/ipv6/conf/eth0/accept_ra')],
        wg=service_state('wg-quick@wg0.service')[:2], own_service=service_state(UNIT),
        ufw=run(['/usr/sbin/ufw', 'status', 'verbose']),
        ufw_config=Path('/etc/default/ufw').read_text(),
        numbered=run(['/usr/sbin/ufw', 'status', 'numbered']),
        listeners=run(['/usr/bin/ss', '-H', '-lnt']),
        protected_services={unit: service_state(unit) for unit in
                            ('nginx.service', 'ssh.service', 'openvpn.service')})


def preflight():
    for executable in ('/usr/sbin/openvpn', '/usr/bin/openssl', '/usr/sbin/ufw',
                       '/usr/sbin/ip', '/usr/sbin/iptables', '/usr/sbin/ip6tables'):
        if not os.access(executable, os.X_OK):
            raise RuntimeError('Missing package/tool')
    if not re.search(r'OpenVPN 2\.(5|6)\.', run(['/usr/sbin/openvpn', '--version'])):
        raise RuntimeError('Unsupported OpenVPN version')
    for path in (PKI, CONFIG, HOOK, UNIT_PATH):
        safe_components(path)
    s = snapshot()
    validate_snapshot(s)
    if service_state('openvpn-server@private-toolbox.service')[2] != 'not-found':
        # The installed template reports loaded even when no instance exists;
        # only instance active/enabled state is an ownership conflict.
        state = service_state('openvpn-server@private-toolbox.service')
        if state[0] != 'inactive' or state[1] not in ('disabled', ''):
            raise RuntimeError('Existing template instance')
    network_module().check_absent()
    return s

TAG = 'toolbox-private-openvpn-v1'


def verify_firewall():
    rows = [row for row in run(['/usr/sbin/ufw', 'status', 'numbered']).splitlines()
            if row.rstrip().endswith('# ' + TAG)]
    expected = firewall_commands()
    if len(rows) != len(expected):
        raise RuntimeError('Owned UFW rule count mismatch')
    for args in expected:
        route = 'route' in args
        action = ('DENY' if 'deny' in args else 'ALLOW') + (' FWD' if route else ' IN')
        source = args[args.index('from') + 1]
        destination = args[args.index('to') + 1]
        destination = 'Anywhere' if destination == 'any' else destination.replace('/128', '')
        matches = []
        for row in rows:
            if action not in row:
                continue
            left, right = row.split(action, 1)
            if not {destination, destination + '/128'}.intersection(left.split()) or 'eth0' not in left.split():
                continue
            if route and (source not in right or 'tunovpn' not in right):
                continue
            if not route and ('1194/tcp' not in left or 'Anywhere' not in right):
                continue
            matches.append(row)
        if len(matches) != 1:
            raise RuntimeError('Owned UFW rule readback mismatch')


def cleanup_firewall():
    text = run(['/usr/sbin/ufw', 'status', 'numbered'])
    numbers = []
    for row in text.splitlines():
        if row.rstrip().endswith('# ' + TAG):
            match = re.match(r'^\[\s*(\d+)\]', row)
            if not match:
                raise RuntimeError('Cannot parse owned UFW rule')
            numbers.append(int(match.group(1)))
    errors = []
    for number in sorted(numbers, reverse=True):
        try:
            run(['/usr/sbin/ufw', '--force', 'delete', str(number)])
        except RuntimeError:
            errors.append('UFW deletion failed')
    if TAG in run(['/usr/sbin/ufw', 'status', 'numbered']):
        errors.append('Residual UFW rules')
    if errors:
        raise RuntimeError('; '.join(errors))


def firewall_commands():
    commands = []
    for source, destinations in (
        ('10.78.78.0/24', ('0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
                          '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4', '240.0.0.0/4')),
        ('fd78:78:78::/64', ('::/128', '::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8'))):
        for destination in destinations:
            commands.append(['/usr/sbin/ufw', 'route', 'insert', '1', 'deny', 'in', 'on', 'tunovpn',
                             'out', 'on', 'eth0', 'from', source, 'to', destination, 'comment', TAG])
        commands.append(['/usr/sbin/ufw', 'route', 'allow', 'in', 'on', 'tunovpn', 'out', 'on', 'eth0',
                         'from', source, 'to', 'any', 'comment', TAG])
    commands.append(['/usr/sbin/ufw', 'allow', 'in', 'on', 'eth0', 'proto', 'tcp', 'from', 'any',
                     'to', '46.225.140.44', 'port', '1194', 'comment', TAG])
    return commands

ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C', 'HOME': '/root'}


def run(args):
    try:
        result = subprocess.run(args, capture_output=True, text=True, env=ENV,
                                timeout=120, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError('Command failed: ' + Path(args[0]).name) from None
    if result.returncode:
        raise RuntimeError('Command failed: ' + Path(args[0]).name)
    return result.stdout


def safe_components(path, owner=0):
    for component in reversed(path.parents):
        info = component.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != owner or info.st_mode & 0o022:
            raise RuntimeError('Unsafe path component')


class OwnedFiles:
    def __init__(self):
        self.owned = []

    def write(self, path, content):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        info = os.fstat(fd)
        self.owned.append((path, info.st_dev, info.st_ino))
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
        except BaseException:
            self.remove(path, info.st_dev, info.st_ino)
            raise

    def remove(self, path, device, inode):
        try:
            info = path.lstat()
        except FileNotFoundError:
            return
        if (info.st_dev, info.st_ino) != (device, inode):
            raise RuntimeError('Foreign replacement retained')
        path.unlink()

    def cleanup(self):
        errors = []
        for entry in reversed(self.owned):
            try:
                self.remove(*entry)
            except (OSError, RuntimeError):
                errors.append('File cleanup failed or foreign replacement retained')
        if errors:
            raise RuntimeError('; '.join(errors))

class DeploymentFiles(OwnedFiles):
    def __init__(self):
        super().__init__()
        self.directory = None

    def mkdir(self):
        PKI.mkdir(mode=0o700)
        info = PKI.lstat()
        self.directory = (PKI, info.st_dev, info.st_ino)

    def capture_private_tree(self):
        # Only our trusted crypto commands have written into this exclusive 0700 dir.
        # Capture final inodes after OpenSSL's database atomic replacements.
        for path in PKI.iterdir():
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
                raise RuntimeError('Unexpected private PKI file')
            self.owned.append((path, info.st_dev, info.st_ino))

    def cleanup(self):
        if self.directory:
            path, device, inode = self.directory
            info = path.lstat()
            if not stat.S_ISDIR(info.st_mode) or (info.st_dev, info.st_ino) != (device, inode):
                raise RuntimeError('Foreign PKI directory retained')
        super().cleanup()
        if self.directory:
            self.directory[0].rmdir()


def unit_config():
    return f'''[Unit]
Description=Additional private toolbox OpenVPN TCP1194
After=network-online.target ufw.service
Wants=network-online.target
[Service]
Type=simple
UMask=0077
ExecStartPre=/usr/bin/python3 -I {HOOK} up
ExecStart=/usr/sbin/openvpn --config {CONFIG}
ExecStopPost=/usr/bin/python3 -I {HOOK} down
Restart=on-failure
RestartSec=5
TimeoutStartSec=90
TimeoutStopSec=90
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/run
[Install]
WantedBy=multi-user.target
'''


def prepare():
    state = DeploymentFiles()
    state.mkdir()
    try:
        try:
            generate_pki(PKI, OwnedFiles())
            # OpenVPN 2.5 supports --genkey secret <path>. All output is captured.
            tlsfiles = OwnedFiles()
            tlsfiles.write(PKI / 'tls-crypt.key', b'')
            run(['/usr/sbin/openvpn', '--genkey', 'secret', str(PKI / 'tls-crypt.key')])
            for device in DEVICES:
                profile = client_config(device, (PKI / 'ca.crt').read_text(),
                                        (PKI / (device + '.crt')).read_text(),
                                        (PKI / (device + '.key')).read_text(),
                                        (PKI / 'tls-crypt.key').read_text())
                OwnedFiles().write(PKI / (device + '.ovpn'), profile.encode())
        finally:
            state.capture_private_tree()
        state.write(CONFIG, server_config().encode())
        state.write(HOOK, Path(__file__).with_name('private-openvpn-network.py').read_bytes())
        state.write(UNIT_PATH, unit_config().encode())
        # Parser check only, no root networking performed by this check.
        run(['/usr/sbin/openvpn', '--config', str(CONFIG), '--show-ciphers'])
        return state
    except BaseException:
        state.cleanup()
        raise


BACKUP_SOURCES = tuple(Path(p) for p in (
    '/etc/default/ufw', '/etc/ufw/ufw.conf', '/etc/ufw/user.rules', '/etc/ufw/user6.rules',
    '/etc/ufw/before.rules', '/etc/ufw/before6.rules', '/etc/ufw/after.rules',
    '/etc/ufw/after6.rules', '/etc/ufw/sysctl.conf'))


def backup_baseline(baseline):
    directory = Path(tempfile.mkdtemp(prefix='private-toolbox-openvpn-backup-', dir='/root'))
    os.chmod(directory, 0o700)
    files = OwnedFiles()
    for index, source in enumerate(BACKUP_SOURCES):
        safe_components(source)
        info = source.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0:
            raise RuntimeError('Unsafe UFW backup source')
        files.write(directory / (str(index) + '-' + source.name), source.read_bytes())
    files.write(directory / 'baseline.json', json.dumps(baseline, sort_keys=True).encode())
    return directory


def verify_unchanged(baseline):
    now = snapshot()
    for key in ('forwarding', 'wg', 'ufw_config', 'ufw', 'protected_services'):
        # UFW verbose includes rules: compare its defaults separately below.
        if key == 'ufw':
            before = [r for r in baseline[key].splitlines() if r.startswith(('Status:', 'Default:'))]
            after = [r for r in now[key].splitlines() if r.startswith(('Status:', 'Default:'))]
            if before != after:
                raise RuntimeError('UFW defaults changed')
        elif now[key] != baseline[key]:
            raise RuntimeError('Protected baseline changed')
    def rules(text):
        return [re.sub(r'^\[\s*\d+\]\s*', '', row) for row in text.splitlines()
                if row.startswith('[') and TAG not in row]
    if rules(now['numbered']) != rules(baseline['numbered']):
        raise RuntimeError('Unrelated firewall rules changed')


def verify_active():
    for _ in range(40):
        if service_state(UNIT)[0] != 'active':
            raise RuntimeError('VPN service not active')
        if '46.225.140.44:1194' in run(['/usr/bin/ss', '-H', '-lnt']):
            links = json.loads(run(['/usr/sbin/ip', '-j', 'address', 'show', 'dev', 'tunovpn']))
            values = {a['local'] for row in links for a in row['addr_info']}
            if {'10.78.78.1', 'fd78:78:78::1'}.issubset(values):
                return
        time.sleep(0.25)
    raise RuntimeError('VPN listener/address verification failed')


def install():
    baseline = preflight()
    backup = backup_baseline(baseline)
    state = prepare()
    firewall_attempted = start_attempted = enable_attempted = reload_attempted = False
    try:
        for args in firewall_commands():
            firewall_attempted = True
            run(args)
        verify_firewall()
        reload_attempted = True
        run(['/usr/bin/systemctl', 'daemon-reload'])
        start_attempted = True
        run(['/usr/bin/systemctl', 'start', UNIT])
        verify_active()
        verify_unchanged(baseline)
        enable_attempted = True
        run(['/usr/bin/systemctl', 'enable', UNIT])
        if service_state(UNIT)[:2] != ['active', 'enabled']:
            raise RuntimeError('VPN enable verification failed')
        manifest = dict(files=[(str(p), device, inode) for p, device, inode in state.owned],
                        directory=[str(state.directory[0]), *state.directory[1:]], baseline=baseline,
                        backup=str(backup), version=1)
        state.write(PKI / 'install-state.json', json.dumps(manifest, sort_keys=True).encode())
        return backup
    except BaseException:
        errors = []
        def attempt(action):
            try:
                action()
                return True
            except BaseException:
                errors.append('cleanup failed')
                return False
        stopped = True
        if enable_attempted:
            attempt(lambda: run(['/usr/bin/systemctl', 'disable', UNIT]))
        if start_attempted:
            stopped = attempt(lambda: run(['/usr/bin/systemctl', 'stop', UNIT]))
            attempt(lambda: network_module().apply('down'))
        if firewall_attempted:
            attempt(cleanup_firewall)
        if stopped:
            attempt(state.cleanup)
        if reload_attempted:
            attempt(lambda: run(['/usr/bin/systemctl', 'daemon-reload']))
        attempt(lambda: verify_unchanged(baseline))
        if errors:
            raise RuntimeError('Rollback incomplete; retained private backup: ' + str(backup)) from None
        raise RuntimeError('Installation failed; own attempted changes rolled back. Backup: ' + str(backup)) from None


PKI = Path('/etc/openvpn/private-toolbox-pki')
CONFIG = Path('/etc/openvpn/server/private-toolbox.conf')
UNIT = 'private-toolbox-openvpn.service'
UNIT_PATH = Path('/etc/systemd/system') / UNIT
HOOK = Path('/etc/openvpn/private-toolbox-network.py')
DEVICES = ('iphone', 'mac')


def generate_pki(directory, files):
    """Private directory must already exist exclusively. No key is logged."""
    def write(name, text):
        files.write(directory / name, text.encode())
    def openssl(*args):
        return run(['/usr/bin/openssl', *args])
    old_mask = os.umask(0o077)
    try:
        write('ca.key', openssl('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256'))
        write('ca.crt', openssl('req', '-new', '-x509', '-sha256', '-days', '3650',
                               '-key', str(directory / 'ca.key'), '-subj', '/CN=toolbox-private-openvpn-ca',
                               '-addext', 'basicConstraints=critical,CA:TRUE',
                               '-addext', 'keyUsage=critical,keyCertSign,cRLSign'))
        write('index.txt', '')
        write('serial', '1000\n')
        write('crlnumber', '1000\n')
        write('ca.cnf', f'''[ca]
default_ca = local
[local]
database = {directory}/index.txt
new_certs_dir = {directory}
certificate = {directory}/ca.crt
private_key = {directory}/ca.key
serial = {directory}/serial
crlnumber = {directory}/crlnumber
default_md = sha256
default_days = 825
default_crl_days = 180
policy = names
unique_subject = no
[names]
commonName = supplied
[server]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
[client]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = clientAuth
''')
        for name in ('server', *DEVICES):
            cn = 'toolbox-openvpn-server' if name == 'server' else 'toolbox-openvpn-' + name
            write(name + '.key', openssl('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256'))
            write(name + '.csr', openssl('req', '-new', '-sha256', '-key', str(directory / (name + '.key')),
                                        '-subj', '/CN=' + cn))
            write(name + '.crt', openssl('ca', '-batch', '-notext', '-config', str(directory / 'ca.cnf'),
                                        '-extensions', 'server' if name == 'server' else 'client',
                                        '-in', str(directory / (name + '.csr'))))
        write('crl.pem', openssl('ca', '-config', str(directory / 'ca.cnf'), '-gencrl'))
    finally:
        os.umask(old_mask)


def server_config():
    return f'''local 46.225.140.44
port 1194
proto tcp-server
dev tunovpn
dev-type tun
topology subnet
server 10.78.78.0 255.255.255.0
server-ipv6 fd78:78:78::/64
push "redirect-gateway def1 ipv6"
push "dhcp-option DNS 1.1.1.1"
ca {PKI}/ca.crt
cert {PKI}/server.crt
key {PKI}/server.key
crl-verify {PKI}/crl.pem
tls-crypt {PKI}/tls-crypt.key
dh none
tls-version-min 1.2
data-ciphers AES-256-GCM:AES-128-GCM
remote-cert-tls client
verify-client-cert require
keepalive 10 120
persist-key
persist-tun
verb 3
'''


def client_config(device, ca, cert, key, tls):
    if device not in DEVICES:
        raise ValueError('Unknown device')
    text = '''client
dev tun
proto tcp-client
remote 46.225.140.44 1194
resolv-retry infinite
nobind
persist-key
persist-tun
remote-cert-tls server
verify-x509-name toolbox-openvpn-server name
tls-version-min 1.2
data-ciphers AES-256-GCM:AES-128-GCM
auth-nocache
verb 3
'''
    for tag, value in (('ca', ca), ('cert', cert), ('key', key), ('tls-crypt', tls)):
        text += f'<{tag}>\n{value.strip()}\n</{tag}>\n'
    return text


def main(args=None):
    if os.geteuid() != 0 or not sys.flags.isolated:
        raise RuntimeError('Requires root and explicit /usr/bin/python3 -I')
    args = sys.argv[1:] if args is None else args
    if args not in (['preflight'], ['install'], ['rollback'], ['export', 'iphone'], ['export', 'mac']):
        raise ValueError('Use preflight, install, rollback or export iphone/mac')
    import fcntl
    os.umask(0o077)
    lock_path = Path('/run/private-toolbox-openvpn-setup.lock')
    safe_components(lock_path)
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_nlink != 1:
            raise RuntimeError('Unsafe setup lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args == ['preflight']:
            preflight()
            print('Preflight passed; nothing activated.')
        elif args == ['install']:
            backup = install()
            print('Server activated; external client verification still required. Private backup: ' + str(backup))
        elif args == ['rollback']:
            backup = rollback()
            print('Own deployment removed; private backup retained: ' + str(backup))
        else:
            print('Private profile exported: ' + str(export_profile(args[1])))
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except (OSError, KeyError, TypeError):
        print('Setup failed; inspect locally. No secret output.', file=sys.stderr)
        sys.exit(1)
