import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import unittest
import tempfile
from contextlib import ExitStack
from unittest.mock import patch


def load_runner():
    spec = importlib.util.spec_from_file_location('zephyr_test_runner', RUNNER)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def mock_pg_main(mod, stack):
    runtime = Path(stack.enter_context(tempfile.TemporaryDirectory()))
    (runtime / 'db').mkdir()
    (runtime / 'db' / 'PG_VERSION').write_text('14')
    stack.enter_context(patch.object(mod, 'RUNTIME', runtime))
    stack.enter_context(patch.object(sys, 'argv', [str(RUNNER), 'pg']))
    stack.enter_context(patch.object(mod, 'run_limited'))

RUNNER = Path(__file__).resolve().parents[2] / 'scripts' / 'zephyr-test.py'


class RunnerSafetyTest(unittest.TestCase):
    def test_environment_never_inherits_production_credentials(self):
        self.assertTrue(RUNNER.is_file(), 'isolated test runner is missing')
        spec = importlib.util.spec_from_file_location('zephyr_test_runner', RUNNER)
        assert spec is not None and spec.loader is not None
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        with patch.dict(os.environ, {'DATABASE_URL': 'production-sentinel', 'TEST_DATABASE_URL': 'production-sentinel', 'HERMES_API_KEY': 'secret-sentinel'}):
            env = mod.test_environment()
        self.assertNotIn('HERMES_API_KEY', env)
        self.assertNotIn('production-sentinel', str(env))
        self.assertEqual(env['DATABASE_URL'], env['TEST_DATABASE_URL'])
        self.assertIn('/toolb0x_test?', env['DATABASE_URL'])
        self.assertIn('host=%2Fhome%2Fmichael%2Fdevelopment%2Fruntime-toolb0x%2Fsocket', env['DATABASE_URL'])
        self.assertEqual(env['NODE_ENV'], 'test')


    def test_runner_separates_pg_tests_and_limits_concurrency(self):
        spec = importlib.util.spec_from_file_location('zephyr_test_runner', RUNNER)
        assert spec is not None and spec.loader is not None
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        self.assertTrue(hasattr(mod, 'test_command'), 'safe test command selection is missing')
        unit = mod.test_command('unit')
        pg = mod.test_command('pg')
        self.assertIn('--test-concurrency=1', unit)
        self.assertIn('--test-concurrency=1', pg)
        self.assertFalse(any(p.endswith('.pg.test.js') for p in unit))
        self.assertEqual(sum(p.endswith('.pg.test.js') for p in pg), 3)
        with self.assertRaises(ValueError):
            mod.test_command('start')


    def test_live_checkout_is_rejected(self):
        spec = importlib.util.spec_from_file_location('zephyr_test_runner', RUNNER)
        assert spec is not None and spec.loader is not None
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        self.assertTrue(hasattr(mod, 'verify_workspace'), 'workspace guard is missing')
        with patch.object(mod, 'ROOT', Path('/var/www/toolbox/finanz-app')):
            with self.assertRaises(RuntimeError):
                mod.verify_workspace()


    def test_cli_rejects_arbitrary_commands(self):
        result = subprocess.run([sys.executable, str(RUNNER), 'start'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0, 'CLI must reject non-test actions')


    def test_existing_database_service_is_not_stopped(self):
        spec = importlib.util.spec_from_file_location('zephyr_test_runner', RUNNER)
        assert spec is not None and spec.loader is not None
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        with patch.object(sys, 'argv', [str(RUNNER), 'pg']), patch.object(mod, 'run_limited'), patch.object(mod.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as run:
            with self.assertRaises(RuntimeError):
                mod.main()
        self.assertFalse(any('stop' in call.args[0] for call in run.call_args_list), 'must not stop a service started by another run')


    def test_service_becoming_active_during_start_is_not_stopped(self):
        mod = load_runner()
        with ExitStack() as stack:
            mock_pg_main(mod, stack)
            run = stack.enter_context(patch.object(mod.subprocess, 'run', side_effect=[
                subprocess.CompletedProcess([], 3),
                subprocess.CompletedProcess([], 0),
                subprocess.CompletedProcess([], 0),
            ]))
            with self.assertRaisesRegex(RuntimeError, 'already running'):
                mod.main()
            self.assertFalse(any('stop' in call.args[0] for call in run.call_args_list),
                             'must not stop a service acquired by another process during startup')


    def test_cleanup_failure_prevents_success(self):
        mod = load_runner()

        def command_result(command, **kwargs):
            code = 3 if 'is-active' in command else 1 if 'stop' in command else 0
            if code and kwargs.get('check'):
                raise subprocess.CalledProcessError(code, command)
            return subprocess.CompletedProcess(command, code)

        with ExitStack() as stack:
            mock_pg_main(mod, stack)
            stack.enter_context(patch.object(mod.subprocess, 'run', side_effect=command_result))
            stack.enter_context(patch.object(mod.subprocess, 'check_output', return_value='1'))
            output = stack.enter_context(patch('builtins.print'))
            with self.assertRaises(subprocess.CalledProcessError):
                mod.main()
            self.assertFalse(any('All requested isolated checks passed' in str(call)
                                 for call in output.call_args_list))


    def test_empty_selected_tests_are_rejected(self):
        mod = load_runner()
        cases = [('unit', []), ('pg', []),
                 ('unit', [mod.ROOT / 'tests/only.pg.test.js']),
                 ('pg', [mod.ROOT / 'tests/only.test.js'])]
        for mode, files in cases:
            with self.subTest(mode=mode, files=files), patch.object(Path, 'glob', return_value=files):
                with self.assertRaisesRegex(RuntimeError, 'No .* tests selected'):
                    mod.test_command(mode)


    def test_failed_service_creation_does_not_stop_foreign_service(self):
        mod = load_runner()

        def command_result(command, **kwargs):
            if command[0] == 'systemd-run':
                raise subprocess.CalledProcessError(1, command)
            return subprocess.CompletedProcess(command, 3 if 'is-active' in command else 0)

        with ExitStack() as stack:
            mock_pg_main(mod, stack)
            run = stack.enter_context(patch.object(mod.subprocess, 'run', side_effect=command_result))
            with self.assertRaises(subprocess.CalledProcessError):
                mod.main()
            self.assertFalse(any('stop' in call.args[0] for call in run.call_args_list))

    def test_owned_service_is_stopped_on_startup_failure(self):
        for failure in ('readiness', 'database-query', 'database-creation'):
            with self.subTest(failure=failure), ExitStack() as stack:
                mod = load_runner()
                mock_pg_main(mod, stack)

                def command_result(command, **kwargs):
                    if Path(command[0]).name == 'createdb':
                        raise subprocess.CalledProcessError(1, command)
                    code = 3 if 'is-active' in command else 0
                    if Path(command[0]).name == 'pg_isready' and failure == 'readiness':
                        code = 1
                    return subprocess.CompletedProcess(command, code)

                run = stack.enter_context(patch.object(mod.subprocess, 'run', side_effect=command_result))
                query = stack.enter_context(patch.object(mod.subprocess, 'check_output', return_value=''))
                if failure == 'database-query':
                    query.side_effect = subprocess.CalledProcessError(1, ['psql'])
                stack.enter_context(patch.object(mod.time, 'sleep'))
                with self.assertRaises((RuntimeError, subprocess.CalledProcessError)):
                    mod.main()
                stops = [call for call in run.call_args_list if 'stop' in call.args[0]]
                self.assertEqual(len(stops), 1)
                self.assertTrue(stops[0].kwargs['check'])


if __name__ == '__main__':
    unittest.main()
