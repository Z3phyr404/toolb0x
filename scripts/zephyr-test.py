"""Safe test entrypoint; never load production environment or app services."""
import argparse
import fcntl
import os
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = Path('/home/michael/development/runtime-toolb0x')
PG_BIN = Path('/usr/lib/postgresql/14/bin')


def test_environment():
    env = {k: os.environ[k] for k in ('HOME', 'PATH', 'TMPDIR', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS') if k in os.environ}
    socket = quote(str(RUNTIME / 'socket'), safe='')
    url = f'postgresql://michael@localhost:55433/toolb0x_test?host={socket}&schema=public'
    env.update(DATABASE_URL=url, TEST_DATABASE_URL=url, NODE_ENV='test', JWT_SECRET='synthetic-test-secret-not-for-production-0000', TZ='Europe/Berlin')
    return env


def test_command(mode):
    if mode not in ('unit', 'pg'):
        raise ValueError('Only unit and pg test modes are allowed')
    files = sorted(ROOT.glob('tests/**/*.test.js'))
    selected = [str(p.relative_to(ROOT)) for p in files if p.name.endswith('.pg.test.js') == (mode == 'pg')]
    if not selected:
        raise RuntimeError(f'No {mode} tests selected; refusing automatic discovery')
    return ['node', '--test', '--test-concurrency=1', *selected]


def verify_workspace():
    if ROOT.resolve() != Path('/home/michael/development/toolb0x'):
        raise RuntimeError('Refusing to run outside the dedicated development checkout')
    if (ROOT / '.env').exists():
        raise RuntimeError('Refusing to load an existing .env; tests use a synthetic environment')


def run_limited(command, label, env):
    log = RUNTIME / f'{label}.log'
    scoped = ['systemd-run', '--user', '--scope', '--quiet', '-p', 'MemoryMax=1G', '-p', 'CPUQuota=100%', 'timeout', '--signal=TERM', '--kill-after=10s', '300s', *command]
    with log.open('w') as out:
        result = subprocess.run(scoped, cwd=ROOT, env=env, stdout=out, stderr=subprocess.STDOUT, timeout=330)
    text = log.read_text()
    summaries = [line for line in text.splitlines() if line.startswith(('# tests ', '# pass ', '# fail ', '# skipped ', '# duration_ms ', 'ℹ tests ', 'ℹ pass ', 'ℹ fail ', 'ℹ skipped ', 'ℹ duration_ms '))]
    print(f'{label}: exit={result.returncode}; log={log}', flush=True)
    for line in summaries:
        print(line, flush=True)
    if result.returncode:
        # Only synthetic test output exists here, never production environment.
        print(text[-12000:], flush=True)
        raise RuntimeError(f'{label} failed')


@contextmanager
def start_test_postgres(env):
    if not (RUNTIME / 'db' / 'PG_VERSION').is_file():
        raise RuntimeError('Initialize the dedicated test cluster first; no production database is used')
    state = subprocess.run(['systemctl', '--user', 'is-active', '--quiet', 'toolb0x-dev-postgres.service'], env=env)
    if state.returncode == 0:
        raise RuntimeError('Test database already running: refusing to take over another test run')
    subprocess.run([
        'systemd-run', '--user', '--unit=toolb0x-dev-postgres', '--collect',
        '-p', 'MemoryMax=512M', '-p', 'CPUQuota=50%',
        str(PG_BIN / 'postgres'), '-D', str(RUNTIME / 'db'),
        '-k', str(RUNTIME / 'socket'), '-p', '55433',
        '-c', 'listen_addresses=', '-c', 'shared_buffers=32MB',
        '-c', 'max_connections=20',
    ], env=env, check=True, capture_output=True, text=True)
    # Creation succeeded: this invocation owns cleanup, including startup failures.
    try:
        for _ in range(50):
            ready = subprocess.run([str(PG_BIN / 'pg_isready'), '-h', str(RUNTIME / 'socket'), '-p', '55433'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if ready.returncode == 0:
                break
            time.sleep(0.1)
        else:
            raise RuntimeError('Dedicated PostgreSQL did not become ready')
        found = subprocess.check_output([
            str(PG_BIN / 'psql'), '-h', str(RUNTIME / 'socket'), '-p', '55433',
            '-d', 'postgres', '-tAc', "SELECT 1 FROM pg_database WHERE datname='toolb0x_test'",
        ], env=env, text=True).strip()
        if found != '1':
            subprocess.run([str(PG_BIN / 'createdb'), '-h', str(RUNTIME / 'socket'), '-p', '55433', 'toolb0x_test'], env=env, check=True)
        yield
    finally:
        subprocess.run(['systemctl', '--user', 'stop', 'toolb0x-dev-postgres.service'], env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    parser = argparse.ArgumentParser(description='Run isolated toolb0x tests, never the app or a deploy')
    parser.add_argument('mode', choices=['unit', 'pg', 'all'], nargs='?', default='all')
    args = parser.parse_args()
    verify_workspace()
    RUNTIME.mkdir(mode=0o700, parents=True, exist_ok=True)
    env = test_environment()
    env['NODE_OPTIONS'] = '--max-old-space-size=512'
    with (RUNTIME / 'tests.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        run_limited([str(ROOT / 'node_modules/.bin/prisma'), 'generate'], 'prisma-generate', env)
        if args.mode in ('unit', 'all'):
            # Real DB tests are excluded from this phase.
            unit_env = env.copy()
            unit_env.pop('TEST_DATABASE_URL')
            run_limited(test_command('unit'), 'unit-tests', unit_env)
        if args.mode in ('pg', 'all'):
            state = subprocess.run(['systemctl', '--user', 'is-active', '--quiet', 'toolb0x-dev-postgres.service'], env=env)
            if state.returncode == 0:
                raise RuntimeError('Test database already running: refusing to take over or stop it')
            with start_test_postgres(env):
                run_limited([str(ROOT / 'node_modules/.bin/prisma'), 'db', 'push', '--skip-generate'], 'test-schema', env)
                run_limited(test_command('pg'), 'pg-tests', env)
    print('All requested isolated checks passed; no production service touched.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, subprocess.SubprocessError, OSError) as exc:
        print(f'Isolated tests stopped: {exc}', file=sys.stderr)
        sys.exit(1)
