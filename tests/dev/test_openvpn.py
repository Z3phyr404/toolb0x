"""Synthetic boundaries only; never invoke privileged main."""
import importlib.util
import pathlib
import unittest
import os
import tempfile
from unittest.mock import patch

SCRATCH = '/home/michael/.hermes/cache/scratch'

ROOT = pathlib.Path(__file__).resolve().parents[2]

def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def synthetic_handles(module):
    original = module.check_open_directory
    cache = pathlib.Path('/home/michael/.hermes/cache').stat()
    def check(fd, owners):
        info = os.fstat(fd)
        if (info.st_dev, info.st_ino) == (cache.st_dev, cache.st_ino):
            return
        original(fd, owners)
    return patch.object(module, 'check_open_directory', side_effect=check)

class ConfigTests(unittest.TestCase):
    def test_dual_stack_mutual_auth_and_fixed_listener(self):
        self.assertTrue((ROOT / 'scripts/private-openvpn-setup.py').exists(), 'setup helper missing')
        m = load('private-openvpn-setup')
        text = m.server_config()
        for line in ('local 46.225.140.44', 'port 1194', 'proto tcp-server', 'dev tunovpn',
                     'server 10.78.78.0 255.255.255.0', 'server-ipv6 fd78:78:78::/64',
                     'push "redirect-gateway def1 ipv6"', 'push "dhcp-option DNS 1.1.1.1"',
                     'remote-cert-tls client', 'tls-version-min 1.2', 'dh none',
                     'data-ciphers AES-256-GCM:AES-128-GCM', 'verify-client-cert require'):
            self.assertIn(line + '\n', text)
        self.assertNotIn('443', text)
        self.assertNotIn('compress', text)
        self.assertIn('crl-verify ', text)
        for device in ('iphone', 'mac'):
            profile = m.client_config(device, 'CA', 'CERT', 'PRIVATE', 'TLS')
            self.assertIn('remote-cert-tls server\n', profile)
            self.assertIn('verify-x509-name toolbox-openvpn-server name\n', profile)
            self.assertIn('proto tcp-client\n', profile)
            self.assertIn('<key>\nPRIVATE\n</key>', profile)
        with self.assertRaises(ValueError):
            m.client_config('../escape', '', '', '', '')

class FileTests(unittest.TestCase):
    def test_exclusive_private_write_failure_cleanup_and_inode_guard(self):
        m = load('private-openvpn-setup')
        self.assertTrue(hasattr(m, 'OwnedFiles'), 'exception-safe file transaction missing')
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            p = pathlib.Path(temp) / 'profile.ovpn'
            files = m.OwnedFiles()
            files.write(p, b'SYNTHETIC SECRET')
            self.assertEqual(p.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                files.write(p, b'OTHER')
            replacement = pathlib.Path(temp) / 'replacement'
            replacement.write_bytes(b'FOREIGN')
            os.replace(replacement, p)
            with self.assertRaises(RuntimeError):
                files.cleanup()
            self.assertEqual(p.read_bytes(), b'FOREIGN')
            p.unlink()
            with patch.object(m.os, 'fsync', side_effect=OSError('disk')):
                with self.assertRaises(OSError):
                    m.OwnedFiles().write(p, b'PRIVATE')
            self.assertFalse(p.exists())
            p.symlink_to(pathlib.Path(temp) / 'absent')
            with self.assertRaises(FileExistsError):
                m.OwnedFiles().write(p, b'PRIVATE')

    def test_replaced_private_directory_is_checked_before_file_cleanup(self):
        m = load('private-openvpn-setup')
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            p = pathlib.Path(temp)
            with patch.object(m, 'PKI', p / 'pki'):
                state = m.DeploymentFiles(); state.mkdir()
                state.write(m.PKI / 'owned', b'SYNTHETIC')
                old = p / 'old'; m.PKI.rename(old); m.PKI.symlink_to(old)
                with self.assertRaises(RuntimeError):
                    state.cleanup()
                self.assertTrue((old / 'owned').exists(), 'replacement ancestry must not be traversed')

    def test_scrubbed_bounded_command_does_not_reveal_errors(self):
        m = load('private-openvpn-setup')
        self.assertTrue(hasattr(m, 'run'), 'bounded runner missing')
        with patch.object(m.subprocess, 'run') as mock:
            mock.return_value.returncode = 0
            mock.return_value.stdout = 'ok'
            self.assertEqual(m.run(['/usr/bin/openssl', 'version']), 'ok')
            kwargs = mock.call_args.kwargs
            self.assertNotIn('DATABASE_URL', kwargs['env'])
            self.assertLessEqual(kwargs['timeout'], 120)
            self.assertFalse(kwargs.get('shell', False))
            mock.return_value.returncode = 1
            mock.return_value.stderr = 'PRIVATEKEY'
            with self.assertRaises(RuntimeError) as caught:
                m.run(['/usr/bin/openssl', 'version'])
            self.assertNotIn('PRIVATEKEY', str(caught.exception))

class CryptoTests(unittest.TestCase):
    def test_real_chain_roles_crl_and_wrong_ca_rejection(self):
        m = load('private-openvpn-setup')
        self.assertTrue(hasattr(m, 'generate_pki'), 'PKI generator missing')
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            p = pathlib.Path(temp)
            m.generate_pki(p, m.OwnedFiles())
            for name, purpose in (('server', 'sslserver'), ('iphone', 'sslclient'), ('mac', 'sslclient')):
                m.run(['/usr/bin/openssl', 'verify', '-purpose', purpose, '-crl_check',
                       '-CRLfile', str(p / 'crl.pem'), '-CAfile', str(p / 'ca.crt'), str(p / (name + '.crt'))])
                self.assertEqual((p / (name + '.key')).stat().st_mode & 0o777, 0o600)
            with self.assertRaises(RuntimeError):
                m.run(['/usr/bin/openssl', 'verify', '-purpose', 'sslserver', '-CAfile', str(p / 'ca.crt'), str(p / 'iphone.crt')])
            other = p / 'other'
            other.mkdir(mode=0o700)
            m.generate_pki(other, m.OwnedFiles())
            with self.assertRaises(RuntimeError):
                m.run(['/usr/bin/openssl', 'verify', '-CAfile', str(other / 'ca.crt'), str(p / 'server.crt')])
            m.run(['/usr/bin/openssl', 'ca', '-batch', '-config', str(p / 'ca.cnf'), '-revoke', str(p / 'iphone.crt')])
            (p / 'crl.pem').write_text(m.run(['/usr/bin/openssl', 'ca', '-config', str(p / 'ca.cnf'), '-gencrl']))
            with self.assertRaises(RuntimeError):
                m.run(['/usr/bin/openssl', 'verify', '-crl_check', '-CRLfile', str(p / 'crl.pem'), '-CAfile', str(p / 'ca.crt'), str(p / 'iphone.crt')])
            m.run(['/usr/bin/openssl', 'verify', '-crl_check', '-CRLfile', str(p / 'crl.pem'), '-CAfile', str(p / 'ca.crt'), str(p / 'mac.crt')])

class NetworkTests(unittest.TestCase):
    def test_idempotent_dual_nat_partial_failure_cleanup(self):
        self.assertTrue((ROOT / 'scripts/private-openvpn-network.py').exists(), 'NAT lifecycle helper missing')
        m = load('private-openvpn-network')
        state = {'/usr/sbin/iptables': [], '/usr/sbin/ip6tables': []}
        fail = [False]
        def command(args):
            executable = args[0]
            if '-S' in args:
                return '\n'.join(' '.join(rule) for rule in state[executable])
            if '-A' in args:
                rule = args[args.index('-A'):]
                state[executable].append(rule)
                if fail[0] and executable.endswith('ip6tables'):
                    raise RuntimeError('partial failure')
            if '-D' in args:
                rule = ['-A', *args[args.index('-D') + 1:]]
                state[executable].remove(rule)
            return ''
        with patch.object(m, 'run', side_effect=command):
            m.apply('up')
            m.apply('up')
            self.assertEqual([len(x) for x in state.values()], [1, 1])
            for rules in state.values():
                self.assertIn('eth0', rules[0])
                self.assertIn('MASQUERADE', rules[0])
                self.assertNotIn('FORWARD', rules[0])
            m.apply('down')
            self.assertEqual([len(x) for x in state.values()], [0, 0])
            fail[0] = True
            with self.assertRaises(RuntimeError):
                m.apply('up')
            self.assertEqual([len(x) for x in state.values()], [0, 0])

    def test_firewall_readback_refuses_missing_owned_rules(self):
        m = load('private-openvpn-setup')
        self.assertTrue(hasattr(m, 'verify_firewall'), 'owned firewall readback missing')
        fixture = []
        for source, destinations in (
            ('10.78.78.0/24', ('0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
                              '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4', '240.0.0.0/4')),
            ('fd78:78:78::/64', ('::', '::1', 'fc00::/7', 'fe80::/10', 'ff00::/8'))):
            fixture.extend(f'[ 1] {destination} on eth0 DENY FWD {source} on tunovpn # {m.TAG}'
                           for destination in destinations)
            fixture.append(f'[ 1] Anywhere on eth0 ALLOW FWD {source} on tunovpn # {m.TAG}')
        fixture.append(f'[ 1] 46.225.140.44 1194/tcp on eth0 ALLOW IN Anywhere # {m.TAG}')
        with patch.object(m, 'run', return_value='\n'.join(fixture)):
            m.verify_firewall()
        with patch.object(m, 'run', return_value='\n'.join(fixture[:-1])):
            with self.assertRaises(RuntimeError):
                m.verify_firewall()
        with patch.object(m, 'run', return_value='Status: active\n'):
            with self.assertRaises(RuntimeError):
                m.verify_firewall()

    def test_firewall_rollback_descending_both_families_and_residual_fail(self):
        m = load('private-openvpn-setup')
        self.assertTrue(hasattr(m, 'cleanup_firewall'), 'UFW transaction missing')
        state = {2: 'own', 7: 'own', 5: 'foreign'}
        deleted = []
        def command(args):
            if 'status' in args:
                return '\n'.join(f'[{n:2}] route rule # {m.TAG if kind == "own" else "wireguard"}' for n, kind in state.items())
            if 'delete' in args:
                n = int(args[-1]); deleted.append(n); state.pop(n)
            return ''
        with patch.object(m, 'run', side_effect=command):
            m.cleanup_firewall()
        self.assertEqual(deleted, [7, 2])
        self.assertEqual(state, {5: 'foreign'})
        with patch.object(m, 'run', return_value=f'[ 1] leftover # {m.TAG}'):
            with self.assertRaises(RuntimeError):
                m.cleanup_firewall()

class PreflightTests(unittest.TestCase):
    def snapshot(self):
        return dict(conflicts=[], interfaces=['eth0', 'wg0'],
                    addresses=['46.225.140.44/32', '2a01:4f8:1c19:3ea5::1/64'],
                    routes=[{'dst': 'default', 'dev': 'eth0', 'gateway': '172.31.1.1'},
                            {'dst': 'default', 'dev': 'eth0', 'gateway': 'fe80::1'},
                            {'dst': '10.77.77.0/24', 'dev': 'wg0'}, {'dst': 'fd77:77:77::/64', 'dev': 'wg0'}],
                    forwarding=['1', '1', '2'], wg=['active', 'enabled'],
                    own_service=['inactive', 'disabled', 'not-found'],
                    ufw='Status: active\nDefault: deny (incoming), allow (outgoing), deny (routed)',
                    ufw_config='IPV6=yes\nDEFAULT_FORWARD_POLICY="DROP"\n',
                    numbered='[ 1] 22/tcp ALLOW IN Anywhere', listeners='')

    def test_guard_refuses_preexisting_and_overlap_all_tables(self):
        m = load('private-openvpn-setup')
        self.assertTrue(hasattr(m, 'validate_snapshot'), 'preflight missing')
        m.validate_snapshot(self.snapshot())
        cases = [('conflicts', ['existing pki']), ('interfaces', ['eth0', 'wg0', 'tunovpn']),
                 ('own_service', ['failed', 'enabled', 'loaded']), ('wg', ['inactive', 'enabled']),
                 ('forwarding', ['1', '0', '2']), ('listeners', 'LISTEN 0 128 0.0.0.0:1194 0.0.0.0:*'),
                 ('ufw_config', 'IPV6=no'), ('numbered', '[ 1] rule # ' + m.TAG)]
        for key, value in cases:
            with self.subTest(key=key):
                s = self.snapshot(); s[key] = value
                with self.assertRaises(RuntimeError):
                    m.validate_snapshot(s)
        for network in ('10.78.0.0/16', 'fd78:78:78::abcd/128'):
            s = self.snapshot(); s['routes'].append({'dst': network, 'table': 123})
            with self.assertRaises(RuntimeError):
                m.validate_snapshot(s)

    def test_existing_unit_dropin_is_an_ownership_conflict(self):
        m = load('private-openvpn-setup')
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            p = pathlib.Path(temp); unit = p / 'own.service'; dropin = p / 'own.service.d'
            dropin.mkdir()
            with patch.object(m, 'UNIT_PATH', unit), patch.object(m, 'run', return_value='[]'), \
                 patch.object(m, 'service_state', return_value=['inactive', 'disabled', 'loaded']), \
                 patch.object(pathlib.Path, 'read_text', return_value='1'):
                state = m.snapshot()
                self.assertIn(str(dropin), state['conflicts'])

    def test_rules_cannot_change_defaults_or_touch_wireguard_web(self):
        m = load('private-openvpn-setup')
        self.assertTrue(hasattr(m, 'firewall_commands'))
        rules = m.firewall_commands()
        for rule in rules:
            self.assertNotIn('disable', rule)
            self.assertNotIn('default', rule)
            self.assertNotIn('wg0', rule)
            self.assertNotIn('443', rule)
            self.assertEqual(rule[-1], m.TAG)
            if 'route' in rule:
                self.assertIn('tunovpn', rule)
                self.assertIn('eth0', rule)
                self.assertIn('from', rule)
        self.assertEqual(sum('allow' in r for r in rules), 3)

class TransactionTests(unittest.TestCase):
    def test_partial_ufw_failure_rolls_back_without_stopping_unattempted_service(self):
        m = load('private-openvpn-setup')
        self.assertTrue(hasattr(m, 'install'), 'deployment transaction missing')
        calls = []
        with patch.object(m, 'preflight', return_value={'baseline': 'synthetic'}), \
             patch.object(m, 'backup_baseline', return_value=pathlib.Path('/synthetic/backup')), \
             patch.object(m, 'prepare') as prepare, patch.object(m, 'verify_firewall'), \
             patch.object(m, 'cleanup_firewall') as firewall, \
             patch.object(m, 'verify_unchanged') as verify, \
             patch.object(m, 'run', side_effect=lambda args: calls.append(args) or (_ for _ in ()).throw(RuntimeError('partial'))):
            fake = prepare.return_value
            with self.assertRaises(RuntimeError):
                m.install()
            firewall.assert_called_once()
            fake.cleanup.assert_called_once()
            verify.assert_called_once()
        self.assertFalse(any('stop' in c for c in calls))

    def test_attempted_start_failure_stops_own_service_and_cleans_nat(self):
        m = load('private-openvpn-setup')
        self.assertTrue(hasattr(m, 'install'), 'deployment transaction missing')
        calls = []
        def command(args):
            calls.append(args)
            if 'start' in args:
                raise RuntimeError('failed startup')
            return ''
        with patch.object(m, 'preflight', return_value={}), \
             patch.object(m, 'backup_baseline', return_value=pathlib.Path('/synthetic/backup')), \
             patch.object(m, 'prepare') as prepare, patch.object(m, 'verify_firewall'), \
             patch.object(m, 'cleanup_firewall') as firewall, \
             patch.object(m, 'verify_unchanged'), \
             patch.object(m, 'network_module') as network, \
             patch.object(m, 'run', side_effect=command):
            with self.assertRaises(RuntimeError):
                m.install()
            self.assertIn(['/usr/bin/systemctl', 'stop', m.UNIT], calls)
            network.return_value.apply.assert_called_with('down')
            firewall.assert_called_once()
            prepare.return_value.cleanup.assert_called_once()
        self.assertTrue(all('wg' not in ' '.join(c) and 'nginx' not in c for c in calls))

    def test_rollback_residual_reported_and_all_cleanup_attempted(self):
        m = load('private-openvpn-setup')
        self.assertTrue(hasattr(m, 'install'), 'deployment transaction missing')
        with patch.object(m, 'preflight', return_value={}), \
             patch.object(m, 'backup_baseline', return_value=pathlib.Path('/synthetic/backup')), \
             patch.object(m, 'prepare') as prepare, patch.object(m, 'verify_firewall'), \
             patch.object(m, 'cleanup_firewall', side_effect=RuntimeError('residual')), \
             patch.object(m, 'verify_unchanged'), \
             patch.object(m, 'run', side_effect=RuntimeError('mutation failed')):
            with self.assertRaisesRegex(RuntimeError, 'Rollback incomplete'):
                m.install()
            prepare.return_value.cleanup.assert_called_once()

    def test_successful_synthetic_install_manifest_and_explicit_rollback(self):
        m = load('private-openvpn-setup')
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            p = pathlib.Path(temp)
            with patch.object(m, 'PKI', p / 'pki'), patch.object(m, 'CONFIG', p / 'config'), \
                 patch.object(m, 'HOOK', p / 'hook'), patch.object(m, 'UNIT_PATH', p / 'unit'):
                state = m.prepare()
                with patch.object(m, 'preflight', return_value={'synthetic': True}), \
                     patch.object(m, 'backup_baseline', return_value=p / 'backup'), \
                     patch.object(m, 'prepare', return_value=state), patch.object(m, 'verify_active'), patch.object(m, 'verify_firewall'), \
                     patch.object(m, 'verify_unchanged'), patch.object(m, 'run', return_value=''), \
                     patch.object(m, 'service_state', return_value=['active', 'enabled', 'loaded']):
                    self.assertEqual(m.install(), p / 'backup')
                import json
                data = json.loads((m.PKI / 'install-state.json').read_text())
                inventory = m.validate_manifest(data)
                self.assertIn(m.CONFIG, [entry[0] for entry in inventory])
                with patch.object(m, 'load_installation', return_value=(data, state)), \
                     patch.object(m, 'verify_unchanged'), patch.object(m, 'cleanup_firewall') as firewall, \
                     patch.object(m, 'network_module') as network, \
                     patch.object(m, 'service_state', return_value=['inactive', 'disabled', 'loaded']), \
                     patch.object(m, 'run', return_value='[]') as command:
                    self.assertEqual(m.rollback(), str(p / 'backup'))
                    firewall.assert_called_once()
                    network.return_value.apply.assert_called_with('down')
                    self.assertIn(unittest.mock.call(['/usr/bin/systemctl', 'stop', m.UNIT]), command.call_args_list)
                self.assertEqual(list(p.iterdir()), [])

    def test_failed_stop_preserves_live_configuration_and_reports_incomplete(self):
        m = load('private-openvpn-setup')
        calls = []
        def command(args):
            calls.append(args)
            if 'start' in args or 'stop' in args:
                raise RuntimeError('service error')
            return ''
        with patch.object(m, 'preflight', return_value={}), \
             patch.object(m, 'backup_baseline', return_value=pathlib.Path('/synthetic/backup')), \
             patch.object(m, 'prepare') as prepare, patch.object(m, 'verify_firewall'), \
             patch.object(m, 'cleanup_firewall'), patch.object(m, 'verify_unchanged'), \
             patch.object(m, 'network_module'), patch.object(m, 'run', side_effect=command), \
             patch.object(m, 'service_state', return_value=['active', 'disabled', 'loaded']):
            with self.assertRaisesRegex(RuntimeError, 'Rollback incomplete'):
                m.install()
            prepare.return_value.cleanup.assert_not_called()

    def test_prepare_write_failure_removes_owned_files_without_external_mutation(self):
        m = load('private-openvpn-setup')
        self.assertTrue(hasattr(m, 'prepare'), 'preparation missing')
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            p = pathlib.Path(temp)
            with patch.object(m, 'PKI', p / 'pki'), patch.object(m, 'CONFIG', p / 'config'), \
                 patch.object(m, 'HOOK', p / 'hook'), patch.object(m, 'UNIT_PATH', p / 'unit'), \
                 patch.object(m, 'generate_pki', side_effect=OSError('write')), \
                 patch.object(m, 'run') as command:
                with self.assertRaises(OSError):
                    m.prepare()
                command.assert_not_called()
                self.assertFalse((p / 'pki').exists())

class LifecycleTests(unittest.TestCase):
    def test_real_openvpn_parser_and_tls_key_synthetic_prepare(self):
        m = load('private-openvpn-setup')
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            p = pathlib.Path(temp)
            with patch.object(m, 'PKI', p / 'pki'), patch.object(m, 'CONFIG', p / 'config'), \
                 patch.object(m, 'HOOK', p / 'hook.py'), patch.object(m, 'UNIT_PATH', p / 'unit'):
                state = m.prepare()
                for device in m.DEVICES:
                    profile = (m.PKI / (device + '.ovpn')).read_text()
                    self.assertIn('BEGIN OpenVPN Static key V1', profile)
                    self.assertEqual((m.PKI / (device + '.ovpn')).stat().st_mode & 0o777, 0o600)
                    m.run(['/usr/sbin/openvpn', '--config', str(m.PKI / (device + '.ovpn')), '--show-ciphers'])
                self.assertIn('ExecStopPost=/usr/bin/python3 -I', m.UNIT_PATH.read_text())
                state.cleanup()
                self.assertEqual(list(p.iterdir()), [])

    def test_export_fixed_destination_private_no_overwrite_no_symlink(self):
        m = load('private-openvpn-setup')
        self.assertTrue(hasattr(m, 'export_profile'), 'safe profile export missing')
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            p = pathlib.Path(temp)
            source = p / 'pki'; source.mkdir(mode=0o700)
            (source / 'iphone.ovpn').write_text('SYNTHETIC SECRET')
            (source / 'iphone.ovpn').chmod(0o600)
            original_check = m.check_directory
            def synthetic_check(path, owners):
                # Scratch's existing cache ancestor is group-writable; do not change it.
                if path == pathlib.Path('/home/michael/.hermes/cache'):
                    return
                return original_check(path, owners)
            with patch.object(m, 'PKI', source), patch.object(m, 'EXPORT_HOME', p), \
                 patch.object(m, 'check_directory', side_effect=synthetic_check), synthetic_handles(m), \
                 patch.object(m, 'export_identity', return_value=(os.getuid(), os.getgid())):
                output = m.export_profile('iphone')
                self.assertEqual(output.read_text(), 'SYNTHETIC SECRET')
                self.assertEqual(output.stat().st_mode & 0o777, 0o600)
                self.assertEqual(output.parent.stat().st_mode & 0o777, 0o700)
                with self.assertRaises(FileExistsError):
                    m.export_profile('iphone')
                with self.assertRaises(ValueError):
                    m.export_profile('../other')
                output.unlink(); output.symlink_to(p / 'foreign')
                with self.assertRaises(FileExistsError):
                    m.export_profile('iphone')

    def test_export_uses_anchored_nofollow_directory_handles(self):
        m = load('private-openvpn-setup')
        self.assertTrue(hasattr(m, 'export_write'), 'anchored export writer missing')
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            p = pathlib.Path(temp); final = p / 'private-vpn'; final.mkdir(mode=0o700)
            link = p / 'link'; link.symlink_to(final)
            with synthetic_handles(m), self.assertRaises(OSError):
                m.export_write(link / 'iphone.ovpn', b'PRIVATE', os.getuid(), os.getgid())
            self.assertFalse((final / 'iphone.ovpn').exists())

    def test_manifest_rejects_arbitrary_paths_before_privileged_commands(self):
        m = load('private-openvpn-setup')
        self.assertTrue(hasattr(m, 'validate_manifest'), 'ownership manifest validation missing')
        with patch.object(m, 'run') as command:
            with self.assertRaises(RuntimeError):
                m.validate_manifest({'version': 1, 'files': [['/etc/shadow', 1, 2]],
                                     'directory': [str(m.PKI), 1, 2]})
            command.assert_not_called()

class GuardTests(unittest.TestCase):
    def test_cli_refuses_privilege_or_unisolated_start_before_commands(self):
        m = load('private-openvpn-setup')
        self.assertTrue(hasattr(m, 'main'), 'root entrypoint missing')
        with patch.object(m.os, 'geteuid', return_value=1000), patch.object(m, 'run') as command:
            with self.assertRaises(RuntimeError):
                m.main(['install'])
            command.assert_not_called()
        with patch.object(m.os, 'geteuid', return_value=0), patch.object(m, 'run') as command:
            with self.assertRaises(RuntimeError):
                m.main(['install'])
            command.assert_not_called()

    def test_export_source_symlink_parent_is_refused(self):
        m = load('private-openvpn-setup')
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            p = pathlib.Path(temp); source = p / 'original'; source.mkdir(mode=0o700)
            (source / 'iphone.ovpn').write_text('SYNTHETIC'); (source / 'iphone.ovpn').chmod(0o600)
            link = p / 'pki'; link.symlink_to(source)
            with patch.object(m, 'PKI', link), patch.object(m, 'EXPORT_HOME', p), \
                 patch.object(m, 'export_identity', return_value=(os.getuid(), os.getgid())), \
                 patch.object(m, 'check_directory') as check:
                # Source validation must happen before any export-directory access.
                with self.assertRaises(RuntimeError):
                    m.export_profile('iphone')
                check.assert_not_called()

    def test_unchanged_protected_service_states_checked(self):
        m = load('private-openvpn-setup')
        s = PreflightTests().snapshot(); s['protected_services'] = {'nginx.service': ['active', 'enabled', 'loaded']}
        changed = dict(s); changed['protected_services'] = {'nginx.service': ['inactive', 'enabled', 'loaded']}
        with patch.object(m, 'snapshot', return_value=changed):
            with self.assertRaises(RuntimeError):
                m.verify_unchanged(s)

if __name__ == '__main__':
    unittest.main()
