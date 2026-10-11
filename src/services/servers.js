// ============================================================
// SERVER-LOGIK — feste SSH-Befehle, gemeinsam für /api/servers und Zephyr
// ============================================================
// Seit 2026-10-12 aus routes/servers.js ausgelagert, damit die Integration
// dieselben, fest verdrahteten Befehle nutzt. Es gibt bewusst KEINE Funktion
// für frei wählbare Befehle — nur die Einträge in COMMANDS bzw. einen
// streng geprüften Dienstnamen.
// Zugangsdaten werden nur hier entschlüsselt und verlassen diese Datei nie.
// ============================================================

const prisma = require('../utils/prisma');
const { decrypt } = require('../utils/encryption');
const { execSSH, HOST_KEY_MISMATCH } = require('../utils/ssh');

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

// Hetzner Storage Box (serverType "storage"): eingeschränkte Shell,
// verlässlich verfügbar ist df — mehr braucht die Anzeige auch nicht.
const STORAGE_DF = 'df -h';

// Schutz gegen Command-Injection: nur alphanumerisch, Bindestrich, Unterstrich, Punkt
const SERVICE_NAME_RE = /^[a-zA-Z0-9._-]{1,50}$/;

class ServerError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** df-h-Ausgabe der Storage Box -> {total, used, free, percent}. */
function parseStorageDf(stdout) {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const line = lines[lines.length - 1] || '';
  const cols = line.split(/\s+/);
  return { total: cols[1] || '0', used: cols[2] || '0', free: cols[3] || '0', percent: cols[4] || '0%' };
}

function getSSHConfig(entry, key) {
  const host = entry.host ? decrypt(entry.host, key) : '';
  const port = entry.port ? decrypt(entry.port, key) : '22';
  const username = entry.username ? decrypt(entry.username, key) : '';
  const password = entry.password ? decrypt(entry.password, key) : '';
  const privateKey = entry.privateKey ? decrypt(entry.privateKey, key) : '';
  const passphrase = entry.passphrase ? decrypt(entry.passphrase, key) : '';

  const config = { host, port, username };
  if (entry.authType === 'key' && privateKey) {
    config.privateKey = privateKey;
    if (passphrase) config.passphrase = passphrase;
  } else {
    config.password = password;
  }
  return config;
}

function findServer(db, id, userId) {
  if (typeof id !== 'string') return null;
  return db.server.findFirst({ where: { id, userId } });
}

// SSH-Befehl mit Host-Key-Pinning ausführen.
// Erster erfolgreicher Connect speichert den Fingerprint (Trust-on-first-use),
// danach wird jede Verbindung dagegen verifiziert (Schutz vor MITM).
async function runServerSSH(server, encryptionKey, command, timeout) {
  const config = getSSHConfig(server, encryptionKey);
  config.hostKeyFingerprint = server.hostKeyFingerprint || '';

  const result = await execSSH(config, command, timeout);

  if (!server.hostKeyFingerprint && result.hostKeyFingerprint) {
    await prisma.server.update({
      where: { id: server.id },
      data: { hostKeyFingerprint: result.hostKeyFingerprint },
    });
  }
  return result;
}

async function testServer(server, key) {
  if (server.serverType === 'storage') {
    await runServerSSH(server, key, STORAGE_DF, 10000);
    return { success: true, hostname: 'Storage Box' };
  }
  const result = await runServerSSH(server, key, COMMANDS.test, 10000);
  const lines = result.stdout.split('\n');
  return { success: true, hostname: lines[1] || lines[0] };
}

/** Wirft nie: offline/Fehler → { online: false, error }. */
async function serverStatus(server, key) {
  try {
    if (server.serverType === 'storage') {
      await runServerSSH(server, key, STORAGE_DF, 30000);
      return { online: true, hostname: 'Storage Box', uptime: '', os: 'Hetzner Storage Box' };
    }
    const result = await runServerSSH(server, key, COMMANDS.status, 30000);
    const lines = result.stdout.split('\n');
    return { online: true, hostname: lines[0] || '', uptime: lines[1] || '', os: lines[2] || '' };
  } catch (error) {
    return { online: false, error: error.message };
  }
}

async function serverStats(server, key) {
  if (server.serverType === 'storage') {
    const d = parseStorageDf((await runServerSSH(server, key, STORAGE_DF, 30000)).stdout);
    return {
      // storage: die UI zeigt dann NUR die Disk (eingeschränkte Shell).
      storage: true,
      cpu: 0,
      ram: { total: 0, used: 0 },
      disk: { total: d.total, used: d.used, free: d.free, percent: d.percent },
      load: { l1: '0', l5: '0', l15: '0' },
      network: { rx: 0, tx: 0 },
      uptime: 0,
    };
  }
  const result = await runServerSSH(server, key, COMMANDS.stats, 30000);
  const parts = result.stdout.split('---SEP---');
  const ramParts = (parts[1] || '').trim().split(' ');
  const diskParts = (parts[2] || '').trim().split(' ');
  const loadParts = (parts[3] || '').trim().split(' ');
  const netParts = (parts[4] || '').trim().split(' ');
  return {
    cpu: parseFloat(parts[0]) || 0,
    ram: { total: parseInt(ramParts[0], 10) || 0, used: parseInt(ramParts[1], 10) || 0 },
    disk: { total: diskParts[0] || '0', used: diskParts[1] || '0', free: diskParts[2] || '0', percent: diskParts[3] || '0%' },
    load: { l1: loadParts[0] || '0', l5: loadParts[1] || '0', l15: loadParts[2] || '0' },
    network: { rx: parseInt(netParts[0], 10) || 0, tx: parseInt(netParts[1], 10) || 0 },
    uptime: parseFloat((parts[5] || '').trim()) || 0,
  };
}

async function serverServices(server, key) {
  if (server.serverType === 'storage') return { services: [] };
  const result = await runServerSSH(server, key, COMMANDS.services, 30000);
  return { services: result.stdout.split('\n').filter((s) => s.trim().length > 0) };
}

async function serverUpdate(server, key) {
  if (server.serverType === 'storage') throw new ServerError(400, 'Auf einer Storage Box gibt es keine System-Updates.');
  const result = await runServerSSH(server, key, COMMANDS.update, 300000);
  return { success: result.code === 0, output: result.stdout, stderr: result.stderr };
}

async function serverRestart(server, key) {
  if (server.serverType === 'storage') throw new ServerError(400, 'Eine Storage Box lässt sich nicht neu starten.');
  try {
    await runServerSSH(server, key, COMMANDS.restart, 10000);
  } catch (error) {
    // reboot trennt die SSH-Verbindung — das ist normal.
    // Host-Key-Fehler aber NICHT verschlucken (möglicher MITM).
    if (error.message === HOST_KEY_MISMATCH) throw new ServerError(400, error.message);
  }
  return { success: true, message: 'Server wird neu gestartet...' };
}

async function serviceRestart(server, key, serviceName) {
  if (!serviceName || typeof serviceName !== 'string') throw new ServerError(400, 'Bitte gib einen Service-Namen an.');
  if (!SERVICE_NAME_RE.test(serviceName)) throw new ServerError(400, 'Ungültiger Service-Name.');
  const result = await runServerSSH(server, key, 'sudo systemctl restart ' + serviceName, 60000);
  return { success: result.code === 0, message: serviceName + ' wurde neu gestartet.' };
}

module.exports = {
  ServerError,
  SERVICE_NAME_RE,
  COMMANDS,
  getSSHConfig,
  findServer,
  runServerSSH,
  testServer,
  serverStatus,
  serverStats,
  serverServices,
  serverUpdate,
  serverRestart,
  serviceRestart,
};
