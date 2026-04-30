// ============================================================
// SERVER-ROUTEN — Remote-Server per SSH verwalten (Admin-only)
// ============================================================

const express = require('express');
const rateLimit = require('express-rate-limit');
const prisma = require('../utils/prisma');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { validateServer, sanitize } = require('../utils/validation');
const { encrypt, decrypt } = require('../utils/encryption');
const { execSSH } = require('../utils/ssh');

const router = express.Router();

router.use(requireAuth);
router.use(requireAdmin);

const ENCRYPTED_FIELDS = ['host', 'port', 'username', 'password', 'privateKey', 'passphrase', 'notes'];

// Hardcoded SSH-Befehle — kein User-Input in Commands
const COMMANDS = {
  status: "hostname && uptime -p && (cat /etc/os-release | grep PRETTY_NAME | cut -d= -f2 | tr -d '\"')",
  stats: [
    "top -bn1 | grep 'Cpu(s)' | awk '{print $2}'",
    "free -m | awk '/Mem:/ {printf \"%d %d %d\", $2, $3, $7}'",
    "df -h / | awk 'NR==2 {printf \"%s %s %s %s\", $2, $3, $4, $5}'",
    "cat /proc/loadavg | awk '{print $1, $2, $3}'",
    "cat /proc/net/dev | awk '/eth0:|ens[0-9]/ {printf \"%s %s\", $2, $10}' | head -1",
    "cat /proc/uptime | awk '{print $1}'",
  ].join(' && echo "---SEP---" && '),
  update: 'sudo DEBIAN_FRONTEND=noninteractive apt-get update -y && sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y 2>&1',
  restart: 'sudo reboot',
  test: 'echo "OK" && hostname',
  services: "systemctl list-units --type=service --state=running --no-pager --no-legend | awk '{print $1}' | sed 's/\\.service$//'",
};

const sshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { error: 'Zu viele Server-Aktionen. Bitte warte einen Moment.' },
});

function decryptServerSafe(entry, key) {
  return {
    id: entry.id,
    label: entry.label,
    host: entry.host ? decrypt(entry.host, key) : '',
    port: entry.port ? decrypt(entry.port, key) : '22',
    username: entry.username ? decrypt(entry.username, key) : '',
    authType: entry.authType,
    notes: entry.notes ? decrypt(entry.notes, key) : '',
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function getSSHConfig(entry, key) {
  var host = entry.host ? decrypt(entry.host, key) : '';
  var port = entry.port ? decrypt(entry.port, key) : '22';
  var username = entry.username ? decrypt(entry.username, key) : '';
  var password = entry.password ? decrypt(entry.password, key) : '';
  var privateKey = entry.privateKey ? decrypt(entry.privateKey, key) : '';
  var passphrase = entry.passphrase ? decrypt(entry.passphrase, key) : '';

  var config = { host: host, port: port, username: username };
  if (entry.authType === 'key' && privateKey) {
    config.privateKey = privateKey;
    if (passphrase) config.passphrase = passphrase;
  } else {
    config.password = password;
  }
  return config;
}

async function findServer(id, userId) {
  return prisma.server.findFirst({ where: { id: id, userId: userId } });
}

// ============================================================
// CRUD
// ============================================================

// GET /api/servers
router.get('/', async (req, res) => {
  try {
    var raw = await prisma.server.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' },
    });
    var servers = raw.map(function (s) { return decryptServerSafe(s, req.encryptionKey); });
    res.json({ servers: servers });
  } catch (error) {
    console.error('Server laden fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Server konnten nicht geladen werden.' });
  }
});

// POST /api/servers
router.post('/', async (req, res) => {
  try {
    var errors = validateServer(req.body);
    if (errors.length > 0) return res.status(400).json({ errors: errors });

    var label = sanitize(req.body.label);
    var key = req.encryptionKey;

    var entry = await prisma.server.create({
      data: {
        label: label,
        host: encrypt(req.body.host.trim(), key),
        port: encrypt(String(req.body.port || '22'), key),
        username: encrypt(req.body.username.trim(), key),
        authType: req.body.authType || 'password',
        password: encrypt(req.body.password || '', key),
        privateKey: encrypt(req.body.privateKey || '', key),
        passphrase: encrypt(req.body.passphrase || '', key),
        notes: encrypt(req.body.notes || '', key),
        userId: req.userId,
      },
    });

    res.status(201).json({ server: decryptServerSafe(entry, key) });
  } catch (error) {
    console.error('Server erstellen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Server konnte nicht gespeichert werden.' });
  }
});

// PUT /api/servers/:id
router.put('/:id', async (req, res) => {
  try {
    var existing = await findServer(req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: 'Server nicht gefunden.' });

    var errors = validateServer(req.body);
    if (errors.length > 0) return res.status(400).json({ errors: errors });

    var label = sanitize(req.body.label);
    var key = req.encryptionKey;

    var entry = await prisma.server.update({
      where: { id: req.params.id },
      data: {
        label: label,
        host: encrypt(req.body.host.trim(), key),
        port: encrypt(String(req.body.port || '22'), key),
        username: encrypt(req.body.username.trim(), key),
        authType: req.body.authType || 'password',
        password: encrypt(req.body.password || '', key),
        privateKey: encrypt(req.body.privateKey || '', key),
        passphrase: encrypt(req.body.passphrase || '', key),
        notes: encrypt(req.body.notes || '', key),
      },
    });

    res.json({ server: decryptServerSafe(entry, key) });
  } catch (error) {
    console.error('Server bearbeiten fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Server konnte nicht geändert werden.' });
  }
});

// DELETE /api/servers/:id
router.delete('/:id', async (req, res) => {
  try {
    var existing = await findServer(req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: 'Server nicht gefunden.' });

    await prisma.server.delete({ where: { id: req.params.id } });
    res.json({ message: 'Server gelöscht.' });
  } catch (error) {
    console.error('Server löschen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Server konnte nicht gelöscht werden.' });
  }
});

// ============================================================
// SSH-AKTIONEN
// ============================================================

// POST /api/servers/:id/test
router.post('/:id/test', sshLimiter, async (req, res) => {
  try {
    var server = await findServer(req.params.id, req.userId);
    if (!server) return res.status(404).json({ error: 'Server nicht gefunden.' });

    var config = getSSHConfig(server, req.encryptionKey);
    var result = await execSSH(config, COMMANDS.test, 10000);
    var lines = result.stdout.split('\n');
    res.json({ success: true, hostname: lines[1] || lines[0] });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/servers/:id/status
router.post('/:id/status', sshLimiter, async (req, res) => {
  try {
    var server = await findServer(req.params.id, req.userId);
    if (!server) return res.status(404).json({ error: 'Server nicht gefunden.' });

    var config = getSSHConfig(server, req.encryptionKey);
    var result = await execSSH(config, COMMANDS.status, 30000);
    var lines = result.stdout.split('\n');
    res.json({
      online: true,
      hostname: lines[0] || '',
      uptime: lines[1] || '',
      os: lines[2] || '',
    });
  } catch (error) {
    res.json({ online: false, error: error.message });
  }
});

// POST /api/servers/:id/stats
router.post('/:id/stats', sshLimiter, async (req, res) => {
  try {
    var server = await findServer(req.params.id, req.userId);
    if (!server) return res.status(404).json({ error: 'Server nicht gefunden.' });

    var config = getSSHConfig(server, req.encryptionKey);
    var result = await execSSH(config, COMMANDS.stats, 30000);
    var parts = result.stdout.split('---SEP---');

    var cpu = parseFloat(parts[0]) || 0;

    var ramParts = (parts[1] || '').trim().split(' ');
    var ramTotal = parseInt(ramParts[0]) || 0;
    var ramUsed = parseInt(ramParts[1]) || 0;

    var diskParts = (parts[2] || '').trim().split(' ');
    var diskTotal = diskParts[0] || '0';
    var diskUsed = diskParts[1] || '0';
    var diskFree = diskParts[2] || '0';
    var diskPercent = diskParts[3] || '0%';

    var loadParts = (parts[3] || '').trim().split(' ');
    var load1 = loadParts[0] || '0';
    var load5 = loadParts[1] || '0';
    var load15 = loadParts[2] || '0';

    var netParts = (parts[4] || '').trim().split(' ');
    var netRx = parseInt(netParts[0]) || 0;
    var netTx = parseInt(netParts[1]) || 0;

    var uptimeSeconds = parseFloat((parts[5] || '').trim()) || 0;

    res.json({
      cpu: cpu,
      ram: { total: ramTotal, used: ramUsed },
      disk: { total: diskTotal, used: diskUsed, free: diskFree, percent: diskPercent },
      load: { l1: load1, l5: load5, l15: load15 },
      network: { rx: netRx, tx: netTx },
      uptime: uptimeSeconds,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/servers/:id/update
router.post('/:id/update', sshLimiter, async (req, res) => {
  try {
    var server = await findServer(req.params.id, req.userId);
    if (!server) return res.status(404).json({ error: 'Server nicht gefunden.' });

    var config = getSSHConfig(server, req.encryptionKey);
    var result = await execSSH(config, COMMANDS.update, 300000);
    res.json({ success: result.code === 0, output: result.stdout, stderr: result.stderr });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/servers/:id/restart
router.post('/:id/restart', sshLimiter, async (req, res) => {
  try {
    var server = await findServer(req.params.id, req.userId);
    if (!server) return res.status(404).json({ error: 'Server nicht gefunden.' });

    var config = getSSHConfig(server, req.encryptionKey);
    try {
      await execSSH(config, COMMANDS.restart, 10000);
    } catch (_) {
      // reboot trennt die SSH-Verbindung — das ist normal
    }
    res.json({ success: true, message: 'Server wird neu gestartet...' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/servers/:id/services
router.post('/:id/services', sshLimiter, async (req, res) => {
  try {
    var server = await findServer(req.params.id, req.userId);
    if (!server) return res.status(404).json({ error: 'Server nicht gefunden.' });

    var config = getSSHConfig(server, req.encryptionKey);
    var result = await execSSH(config, COMMANDS.services, 30000);
    var services = result.stdout.split('\n').filter(function (s) { return s.trim().length > 0; });
    res.json({ services: services });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/servers/:id/service-restart
router.post('/:id/service-restart', sshLimiter, async (req, res) => {
  try {
    var server = await findServer(req.params.id, req.userId);
    if (!server) return res.status(404).json({ error: 'Server nicht gefunden.' });

    var serviceName = req.body.service;
    if (!serviceName || typeof serviceName !== 'string') {
      return res.status(400).json({ error: 'Bitte gib einen Service-Namen an.' });
    }

    // Schutz gegen Command-Injection: nur alphanumerisch, Bindestrich, Unterstrich, Punkt
    if (!/^[a-zA-Z0-9._-]{1,50}$/.test(serviceName)) {
      return res.status(400).json({ error: 'Ungültiger Service-Name.' });
    }

    var config = getSSHConfig(server, req.encryptionKey);
    var command = 'sudo systemctl restart ' + serviceName;
    var result = await execSSH(config, command, 60000);
    res.json({ success: result.code === 0, message: serviceName + ' wurde neu gestartet.' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
