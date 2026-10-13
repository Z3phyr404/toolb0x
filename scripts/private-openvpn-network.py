#!/usr/bin/python3
"""Fixed NAT lifecycle, called by this VPN's own systemd unit only."""
import os
from pathlib import Path
import shlex
import stat
import subprocess
import sys

TAG = 'toolbox-private-openvpn-v1'
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C', 'HOME': '/root'}
RULES = tuple((binary, ['POSTROUTING', '-s', subnet, '-o', 'eth0', '-m', 'comment',
                        '--comment', TAG, '-j', 'MASQUERADE'])
              for binary, subnet in (('/usr/sbin/iptables', '10.78.78.0/24'),
                                     ('/usr/sbin/ip6tables', 'fd78:78:78::/64')))


def run(args):
    try:
        result = subprocess.run(args, env=ENV, capture_output=True, text=True,
                                timeout=30, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError('NAT command failed') from None
    if result.returncode:
        raise RuntimeError('NAT command failed')
    return result.stdout


def rows(binary):
    return [shlex.split(row) for row in run([binary, '-w', '5', '-t', 'nat', '-S', 'POSTROUTING']).splitlines()]


def check_absent():
    for binary, rule in RULES:
        for row in rows(binary):
            if TAG in row or any(subnet in row for subnet in ('10.78.78.0/24', 'fd78:78:78::/64')):
                raise RuntimeError('Existing VPN NAT state; refusing takeover')


def down():
    errors = []
    for binary, rule in RULES:
        try:
            existing = rows(binary)
            for row in existing:
                if row == ['-A', *rule]:
                    try:
                        run([binary, '-w', '5', '-t', 'nat', '-D', *rule])
                    except RuntimeError:
                        errors.append('NAT deletion failed')
            if any(TAG in row for row in rows(binary)):
                errors.append('Residual NAT rules')
        except RuntimeError:
            errors.append('Unreadable NAT state')
    if errors:
        raise RuntimeError('; '.join(errors))


def apply(action):
    if action == 'down':
        down()
        return
    if action != 'up':
        raise ValueError('Only up/down permitted')
    try:
        for binary, rule in RULES:
            existing = rows(binary)
            if any(TAG in row and row != ['-A', *rule] for row in existing):
                raise RuntimeError('Foreign marked NAT rule')
            if ['-A', *rule] not in existing:
                run([binary, '-w', '5', '-t', 'nat', '-A', *rule])
            if rows(binary).count(['-A', *rule]) != 1:
                raise RuntimeError('NAT verification failed')
    except BaseException:
        down()
        raise


def main():
    if os.geteuid() != 0 or not sys.flags.isolated or sys.argv[1:] not in (['up'], ['down']):
        raise RuntimeError('Requires root, Python -I and up/down')
    source = Path(__file__).absolute()
    for p in (source, *source.parents):
        info = p.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('Unsafe hook ownership')
    os.umask(0o077)
    apply(sys.argv[1])


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, ValueError):
        print('OpenVPN NAT lifecycle failed; inspect owned state locally.', file=sys.stderr)
        sys.exit(1)
