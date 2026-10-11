# Zephyr: development on the VPS

## Boundaries

- Development checkout: `/home/michael/development/toolb0x`.
- Production checkout: `/var/www/toolbox/finanz-app`; do not edit, pull, install dependencies, migrate or restart here without a separate deployment authorization.
- Shared repository: `Z3phyr404/toolb0x`. Feature branches, tests and review before merge. GitHub shares committed/pushed work, not uncommitted files or local Obsidian notes.
- Read `CLAUDE.md` and these rules before working. A deployment example in project documentation is not permission to deploy.
- No messages in Michael's name, purchases or payments. Personal toolb0x data only through the authorized local API. Never load production `.env`, database records, header credentials or private photo files during development.
- No new paid cloud/AI services. Local test execution uses the existing VPS; conversational model calls use the configured ChatGPT/Codex provider.

## Test setup

Own dependencies installed from the committed lockfile with `npm ci --ignore-scripts --no-audit --no-fund`. No production node_modules symlink, no production configuration copied. Prisma generation is explicitly run by the test launcher.

Run:

```bash
cd /home/michael/development/toolb0x
python -m unittest discover -s tests/dev -v
python scripts/zephyr-test.py all
# Or: python scripts/zephyr-test.py unit
# Or: python scripts/zephyr-test.py pg
```

The launcher:
- drops inherited credentials and DB URLs; supplies only synthetic test environment;
- rejects other checkouts and an existing `.env`;
- limits each Node/Prisma step to 1 GiB RAM and one CPU equivalent;
- limits the V8 heap to 512 MiB and test concurrency to one;
- sets a 300-second per-step timeout;
- separates mock tests and real PostgreSQL tests;
- takes a nonblocking lock to prevent concurrent test suites;
- starts/stops only `toolb0x-dev-postgres.service`, never production services.

Test DB is an independent PostgreSQL 14 cluster under `/home/michael/development/runtime-toolb0x/db`, database `toolb0x_test`, owned by user `michael`. It listens ONLY on a private Unix socket in `/home/michael/development/runtime-toolb0x/socket` (directory mode 700); there is no TCP listener. Its service is capped at 512 MiB RAM and 50% of one CPU, with shared_buffers 32 MiB and max_connections 20. Authentication is local trust, only inside the private socket directory; no production passwords are used.

Runtime logs and synthetic database files are outside Git, under `/home/michael/development/runtime-toolb0x`. The test service is stopped after a run and not enabled at boot. Prisma `db push` is used ONLY to populate this isolated synthetic schema, never for production. The existing migration history is not treated as proven deployable by these tests.

Already initialized. To recreate a missing cluster, after verifying this dedicated path is absent:

```bash
mkdir -p /home/michael/development/runtime-toolb0x/socket
chmod 700 /home/michael/development/runtime-toolb0x /home/michael/development/runtime-toolb0x/socket
/usr/lib/postgresql/14/bin/initdb -D /home/michael/development/runtime-toolb0x/db -A trust --no-locale -E UTF8
```

No automatic development web server is exposed. Do not run `npm start`: it includes migrations and does not provide the isolation of the test launcher. Any preview needs separately assigned loopback-only ports and synthetic configuration, never production data.

This is operational separation, NOT an OS security sandbox: development and Hermes still run as `michael`, which has access elsewhere. For stronger isolation, a separate Linux user/container requires another explicit setup.

## GitHub access

Development origin: `git@github.com:Z3phyr404/toolb0x.git`.
A dedicated repository deploy key was generated; the private key stays on the server with SSH permissions. `core.sshCommand` forces only this identity, and strict host-key verification is enabled. Development does not copy the token-bearing production remote. Production Git settings remain untouched.

Michael must register the PUBLIC file `/home/michael/.ssh/toolb0x-zephyr_ed25519.pub` in this repository's Settings → Deploy keys. Enable write access only if Zephyr is to push feature branches. This grants repository Git access, not GitHub admin/API/PR privileges. Do not send private keys or tokens through chat.

The key has no passphrase for unattended use; its exposure is limited by file permissions and a single-repository deploy-key grant. Same-user processes can still read it. Do not interpret repository restriction as main-branch protection: configure branch protection separately if required.

GitHub's Ed25519 host key was obtained from the official HTTPS endpoint `https://api.github.com/meta` and stored in `/home/michael/development/runtime-toolb0x/github-host-key`. The SSH command pins this file and the Ed25519 host-key algorithm with strict verification. Fingerprint: `SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU`. The connection reached GitHub but returned `Permission denied (publickey)` as expected because Michael has not registered this new deploy key. Never disable host-key checks or blindly trust ssh-keyscan.

Hooks are disabled in this dedicated checkout until reviewed so fetching/committing cannot invoke unreviewed deployment hooks. Never force-push or push directly to main. Push, PR publication, merge and deployment require Michael's authorization unless he establishes a more specific workflow.

## Verification result

Completed runs at setup: 359 mock/unit tests passed, 18 real-PostgreSQL tests passed, 10 development-runner safety tests passed. No skipped project tests in their respective phases.
Production continued responding: app root HTTP 302 (login redirect), integration status HTTP 200. This is a reachability check, not a full production QA run.
The pre-existing production package-lock.json change (48 deletions) was left untouched; development started from committed HEAD, not the modified production working tree.

## Obsidian

The existing Obsidian workflow lives on Michael's computer and has not been connected here. This document can be handed to Claude Code; it does not invent a second vault or claim notes are synchronized.
