const { Client } = require('ssh2');

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

function execSSH(config, command, timeout) {
  if (timeout === undefined) timeout = 30000;

  return new Promise(function (resolve, reject) {
    var conn = new Client();
    var stdout = '';
    var stderr = '';
    var timedOut = false;

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
            resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code });
          }
        });

        stream.on('data', function (data) { stdout += data; });
        stream.stderr.on('data', function (data) { stderr += data; });
      });
    });

    conn.on('error', function (err) {
      clearTimeout(timer);
      if (!timedOut) {
        reject(new Error(mapSSHError(err)));
      }
    });

    var sshConfig = {
      host: config.host,
      port: parseInt(config.port) || 22,
      username: config.username,
      readyTimeout: 10000,
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

module.exports = { execSSH, mapSSHError };
