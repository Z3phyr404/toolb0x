const { Client } = require('ssh2');
const crypto = require('crypto');

const HOST_KEY_MISMATCH =
  'SSH-Host-Key hat sich geändert! Mögliche Man-in-the-Middle-Attacke. ' +
  'Falls der Server neu installiert wurde, bearbeite und speichere den Server-Eintrag, ' +
  'um den gespeicherten Host-Key zurückzusetzen.';

function mapSSHError(err) {
  const msg = err.message || '';
  if (msg.includes('Authentication failed') || msg.includes('All configured authentication methods failed')) {
    return 'Authentifizierung fehlgeschlagen. Benutzername oder Passwort/Key falsch.';
  }
  if (msg.includes('ECONNREFUSED')) {
    return 'Verbindung abgelehnt. Server nicht erreichbar oder Port falsch.';
  }
  if (msg.includes('EHOSTUNREACH') || msg.includes('ENETUNREACH')) {
    return 'Host nicht erreichbar. Bitte Hostname/IP prüfen.';
  }
  if (msg.includes('ENOTFOUND') || msg.includes('getaddrinfo')) {
    return 'Hostname konnte nicht aufgelöst werden. Bitte prüfen.';
  }
  if (msg.includes('Timed out') || msg.includes('Zeitlimit')) {
    return 'Zeitlimit überschritten. Server antwortet nicht.';
  }
  return 'SSH-Fehler: ' + msg;
}

// config.hostKeyFingerprint: erwarteter SHA-256-Fingerprint (hex) des Host-Keys.
// Leer = Trust-on-first-use: Key wird akzeptiert und der Fingerprint im
// Ergebnis (result.hostKeyFingerprint) zurückgegeben, damit der Aufrufer ihn speichert.
function execSSH(config, command, timeout) {
  if (timeout === undefined) timeout = 30000;

  return new Promise(function (resolve, reject) {
    var conn = new Client();
    var stdout = '';
    var stderr = '';
    var timedOut = false;
    var seenFingerprint = '';
    var keyMismatch = false;

    var timer = setTimeout(function () {
      timedOut = true;
      conn.end();
      reject(new Error('Zeitlimit überschritten. Server antwortet nicht.'));
    }, timeout);

    conn.on('ready', function () {
      conn.exec(command, function (err, stream) {
        if (err) {
          clearTimeout(timer);
          conn.end();
          return reject(err);
        }

        stream.on('close', function (code) {
          clearTimeout(timer);
          conn.end();
          if (!timedOut) {
            resolve({
              stdout: stdout.trim(),
              stderr: stderr.trim(),
              code: code,
              hostKeyFingerprint: seenFingerprint,
            });
          }
        });

        stream.on('data', function (data) { stdout += data; });
        stream.stderr.on('data', function (data) { stderr += data; });
      });
    });

    conn.on('error', function (err) {
      clearTimeout(timer);
      if (!timedOut) {
        if (keyMismatch) {
          reject(new Error(HOST_KEY_MISMATCH));
        } else {
          reject(new Error(mapSSHError(err)));
        }
      }
    });

    var sshConfig = {
      host: config.host,
      port: parseInt(config.port) || 22,
      username: config.username,
      readyTimeout: 10000,
      hostVerifier: function (key) {
        seenFingerprint = crypto.createHash('sha256').update(key).digest('hex');
        if (config.hostKeyFingerprint && config.hostKeyFingerprint !== seenFingerprint) {
          keyMismatch = true;
          return false;
        }
        return true;
      },
    };

    if (config.privateKey) {
      sshConfig.privateKey = config.privateKey;
      if (config.passphrase) sshConfig.passphrase = config.passphrase;
    } else {
      sshConfig.password = config.password;
    }

    conn.connect(sshConfig);
  });
}

module.exports = { execSSH, mapSSHError, HOST_KEY_MISMATCH };
