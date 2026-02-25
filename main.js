'use strict';

// Load environment variables from .env if present
try { require('dotenv').config(); } catch (_) {}

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { google } = require('googleapis');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const sgMail = require('@sendgrid/mail');

/* ───────────────── CONFIG ───────────────── */

const SCOPES = ['https://www.googleapis.com/auth/gmail.send'];
const DATA_DIR = app.getPath('userData');
const TOKEN_PATH = path.join(DATA_DIR, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const CREDENTIALS_PATH_FALLBACK = path.join(__dirname, 'Credentials.json');
const SCHEDULE_PATH = path.join(DATA_DIR, 'schedules.json');
const FOLDER_PAIRS_PATH = path.join(DATA_DIR, 'folder-pairs.json');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const HYBRID_KEYS_PATH = path.join(DATA_DIR, 'hybrid-keys.json');
const RECIPIENT_KEYS_PATH = path.join(DATA_DIR, 'recipient-keys.json');
const CHECKSUM_LOG_PATH = path.join(DATA_DIR, 'checksums-log.json');
const CHECKSUM_LOG_PATH = path.join(DATA_DIR, 'checksums-log.json');
const LOG_EMAIL = 'notification@thewrightsupport.com';
const RESET_FROM = process.env.SENDGRID_FROM || 'no-reply@mail.yourparadigm.co.uk';
const RESET_URL_BASE = process.env.RESET_URL_BASE || '';
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || '';
const PQC_PROXY_PORT = Number(process.env.PQC_PROXY_PORT || 8787);
const PQC_PROXY_PATH = path.join(__dirname, 'pqc-proxy', 'target', 'release', 'pqc-proxy');

/* ───────────────── STATE ───────────────── */

let authClient;
let schedules = [];
let schedulerTimer;
let transcribeProcess = null;
let transcribeResolve = null;
let transcriptionLog = [];   // captures stderr lines for the current attempt
let appLog = [];             // ring buffer of app events/errors
let settings = { emailErrorLogs: true };
const resetTokens = new Map(); // token -> { email, expiresAt }
let pqcProxyProcess = null;
let recipientKeys = []; // [{ email, kem_public }]

function formatGbDateTime() {
  const now = new Date();
  return now.toLocaleString('en-GB', {
    timeZone: 'Europe/London',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

async function loadChecksumLog() {
  try {
    return JSON.parse(await fsp.readFile(CHECKSUM_LOG_PATH, 'utf8'));
  } catch {
    return [];
  }
}

async function saveChecksumLog(entries) {
  await fsp.writeFile(CHECKSUM_LOG_PATH, JSON.stringify(entries, null, 2));
}

/* ───────────────── ELECTRON ───────────────── */

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400,
    height: 1000,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: '#667eea',
    title: 'Email Automation Pro'
  });
  win.loadFile('index.html');

  authClient = await authorise();
  await ensurePqcProxy();
  initSendgrid();
  await loadSettings();
  await loadSchedules();
  startScheduler();
  startTranscribeProcess();

  logInfo('Email Automation Pro started');
  logInfo(`Loaded ${schedules.length} schedule(s)`);
});

/* ───────────────── AUTH ───────────────── */

async function authorise() {
  const credsRaw = await readCredentialsFile();
  const creds = JSON.parse(credsRaw).installed;
  const client = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    creds.redirect_uris[0]
  );

  try {
    const tokenData = JSON.parse(await fsp.readFile(TOKEN_PATH, 'utf8'));
    client.setCredentials(tokenData);

    // Proactively refresh if the token is expiring within the next 5 minutes
    if (client.isTokenExpiring()) {
    console.log('🔄 Token expiring soon, refreshing...');
    const { credentials } = await client.refreshAccessToken();
    client.setCredentials(credentials);
    await fsp.writeFile(TOKEN_PATH, JSON.stringify(credentials, null, 2));
  }

    logInfo('Using existing authentication');
    return client;
  } catch (err) {
    // ENOENT = no token file yet; invalid_grant = token revoked → both require new auth
    const isExpected = err.code === 'ENOENT' || err.response?.data?.error === 'invalid_grant';
    if (!isExpected) logWarn(`Token error: ${err.message}`);

    logInfo('Starting new authentication...');
    return new Promise((resolve, reject) => {
      const authUrl = client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
      const server = http.createServer(async (req, res) => {
        const code = new URL(req.url, 'http://localhost').searchParams.get('code');
        if (!code) return;
        try {
          const { tokens } = await client.getToken(code);
          client.setCredentials(tokens);
          await fsp.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2));
          res.end('✅ Authenticated! You may close this window.');
          server.close();
          logInfo('Authentication successful');
          resolve(client);
        } catch (tokenErr) {
          res.end('❌ Authentication failed. Please try again.');
          server.close();
          reject(tokenErr);
        }
      });
      server.on('error', reject);
      server.listen(8080, () => {
        logInfo('Opening browser for authentication');
        shell.openExternal(authUrl);
      });
    });
  }
}

async function readCredentialsFile() {
  try {
    return await fsp.readFile(CREDENTIALS_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return await fsp.readFile(CREDENTIALS_PATH_FALLBACK, 'utf8');
    }
    throw err;
  }
}

/* ───────────────── SCHEDULER ───────────────── */

function startScheduler() {
  schedulerTimer = setInterval(checkSchedules, 30_000);
  logInfo('Scheduler started (checking every 30 seconds)');
}

function initSendgrid() {
  if (!SENDGRID_API_KEY) {
    logWarn('SENDGRID_API_KEY is not set; reset emails will be disabled');
    return;
  }
  sgMail.setApiKey(SENDGRID_API_KEY);
  logInfo('SendGrid initialized for reset emails');
}

async function loadSchedules() {
  try {
    schedules = JSON.parse(await fsp.readFile(SCHEDULE_PATH));
  } catch {
    schedules = [];
  }
}

async function saveSchedules() {
  await fsp.writeFile(SCHEDULE_PATH, JSON.stringify(schedules, null, 2));
}

async function loadSettings() {
  try {
    const raw = await fsp.readFile(SETTINGS_PATH, 'utf8');
    settings = { ...settings, ...JSON.parse(raw) };
  } catch {
    settings = { ...settings };
  }
}

async function saveSettings() {
  await fsp.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

async function loadRecipientKeys() {
  try {
    recipientKeys = JSON.parse(await fsp.readFile(RECIPIENT_KEYS_PATH, 'utf8'));
  } catch {
    recipientKeys = [];
  }
}

async function saveRecipientKeys() {
  await fsp.writeFile(RECIPIENT_KEYS_PATH, JSON.stringify(recipientKeys, null, 2));
}

async function checkSchedules() {
  const now = Date.now();
  let executed = 0;

  for (const task of schedules) {
    if (!task.enabled) continue;
    if (task.type === 'future') {
      if (!task.scheduledTime) continue;
      const scheduledAt = new Date(task.scheduledTime).getTime();
      if (Number.isNaN(scheduledAt)) continue;
      if (now >= scheduledAt) {
        logInfo(`Executing one-time task: ${task.payload.subject}`);
        try {
          await sendEmail(task.payload);
          task.lastRun = now;
          task.enabled = false;
          executed++;
        } catch (error) {
          logError(`Failed to execute one-time task: ${error.message}`);
          notifyError('One-time schedule failed', error);
        }
      }
      continue;
    }

    const last = task.lastRun || 0;
    if (task.intervalMs > 0 && now - last >= task.intervalMs) {
      logInfo(`Executing scheduled task: ${task.payload.subject}`);
      try {
        await sendEmail(task.payload);
        task.lastRun = now;
        executed++;
      } catch (error) {
        logError(`Failed to execute recurring task: ${error.message}`);
        notifyError('Recurring schedule failed', error);
      }
    }
  }

  if (executed > 0) {
    await saveSchedules();
    logInfo(`Executed ${executed} scheduled task(s)`);
  }
}

/* ───────────────── EMAIL ───────────────── */

async function ensureAuth() {
  if (!authClient) {
    authClient = await authorise();
    return;
  }
  if (authClient.isTokenExpiring && authClient.isTokenExpiring()) {
    try {
      const { credentials } = await authClient.refreshAccessToken();
      authClient.setCredentials(credentials);
      await fsp.writeFile(TOKEN_PATH, JSON.stringify(credentials, null, 2));
      logInfo('Refreshed OAuth token');
    } catch (err) {
      logWarn(`Token refresh failed, reauth: ${err.message}`);
      authClient = await authorise();
    }
  }
}

async function sendEmail({ recipient, subject, body, files }) {
  await ensureAuth();
  const gmail = google.gmail({ version: 'v1', auth: authClient });
  const secureHybrid = arguments[0]?.secureHybrid === true;
  let hybridEnvelope = null;

  if (secureHybrid) {
    try {
      await ensurePqcProxy();
      const recipientKey = recipientKeys.find(
        (k) => k.email && k.email.toLowerCase() === recipient.toLowerCase()
      );
      hybridEnvelope = await buildHybridEnvelopeRemote(body, recipientKey?.kem_public);
      if (!recipientKey) {
        logWarn(`Secure send: no recipient Kyber key found for ${recipient}; used local key instead`);
      }
    } catch (err) {
      logError(`Hybrid envelope failed: ${err.message}`);
      throw err;
    }
  }

  const boundary = `----=_${Date.now()}`;
  const parts = [
    `To: ${recipient}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    secureHybrid
      ? 'This message is encrypted with a PQC hybrid envelope. Please use a compatible client to decrypt the attached pqc-envelope.'
      : body,
    ''
  ];

  // Optional hybrid PQ-like envelope (currently classical + placeholder; replace with ML-KEM/ML-DSA when available)
  if (hybridEnvelope) {
    parts.push(
      `--${boundary}`,
      'Content-Type: application/pq-envelope+json; charset=utf-8',
      'Content-Disposition: inline; filename="pqc-envelope.json"',
      '',
      JSON.stringify(hybridEnvelope, null, 2),
      ''
    );
  }

  // Add file attachments
  for (const file of files) {
    const data = await fsp.readFile(file);   // async — no longer blocks the event loop
    const name = path.basename(file);
    const ext = path.extname(file).toLowerCase();

    let mimeType = 'application/octet-stream';
    if (ext === '.pdf') mimeType = 'application/pdf';
    else if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
    else if (ext === '.png') mimeType = 'image/png';
    else if (ext === '.txt') mimeType = 'text/plain';
    else if (ext === '.doc') mimeType = 'application/msword';
    else if (ext === '.docx') mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    parts.push(
      `--${boundary}`,
      `Content-Type: ${mimeType}; name="${name}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${name}"`,
      '',
      data.toString('base64'),
      ''
    );
  }

  parts.push(`--${boundary}--`);

  const raw = Buffer.from(parts.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  try {
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    logInfo(`Email sent to ${recipient} with ${files.length} attachment(s)`);
  } catch (err) {
    // If unauthorized, force re-auth once
    if (err?.code === 401 || err?.code === 403) {
      logWarn(`Gmail auth error (${err.code}), reauthorising…`);
      authClient = await authorise();
      const gmailRetry = google.gmail({ version: 'v1', auth: authClient });
      await gmailRetry.users.messages.send({ userId: 'me', requestBody: { raw } });
      logInfo(`Email sent (after reauth) to ${recipient} with ${files.length} attachment(s)`);
    } else {
      throw err;
    }
  }
}

/* ───────────────── HYBRID ENVELOPE (placeholder: classical + ready for PQ) ───────────────── */

/* ───────────────── HYBRID ENVELOPE (Kyber/Dilithium via pqc-proxy) ───────────────── */

async function ensurePqcProxy() {
  if (pqcProxyProcess && !pqcProxyProcess.killed) return;
  if (!fs.existsSync(PQC_PROXY_PATH)) {
    throw new Error(`pqc-proxy binary not found at ${PQC_PROXY_PATH}. Run cargo build --release inside pqc-proxy.`);
  }
  pqcProxyProcess = spawn(PQC_PROXY_PATH, {
    env: { ...process.env, PQC_PROXY_PORT: String(PQC_PROXY_PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  pqcProxyProcess.stdout.on('data', (d) => logInfo(`[pqc-proxy] ${d.toString().trim()}`));
  pqcProxyProcess.stderr.on('data', (d) => logWarn(`[pqc-proxy] ${d.toString().trim()}`));
  pqcProxyProcess.on('exit', (code) => logWarn(`pqc-proxy exited with code ${code}`));
}

async function buildHybridEnvelopeRemote(plaintext, recipientKemPk) {
  const baseUrl = `http://127.0.0.1:${PQC_PROXY_PORT}`;
  const resPub = await fetch(`${baseUrl}/pubkeys`);
  if (!resPub.ok) throw new Error(`pubkeys fetch failed: ${resPub.status}`);
  const pub = await resPub.json();
  const kemPublic = recipientKemPk || pub.kem_public;

  const res = await fetch(`${baseUrl}/encrypt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plaintext, recipient_kem_public: kemPublic })
  });
  if (!res.ok) throw new Error(`encrypt failed: ${res.status}`);
  return await res.json();
}

/* ───────────────── TRANSCRIPTION ───────────────── */

function startTranscribeProcess() {
  const script = path.join(__dirname, 'transcribe.py');
  transcribeProcess = spawn('python3', [script, '--daemon'], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  transcribeProcess.stdout.on('data', (data) => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      try {
        const result = JSON.parse(line);
        if ('success' in result && transcribeResolve) {
          transcribeResolve(result);
          transcribeResolve = null;
        }
      } catch {
        // Non-JSON line (e.g. status messages) — ignore
      }
    }
  });

  transcribeProcess.stderr.on('data', (data) => {
    const text = data.toString().trimEnd();
    logInfo(`[Whisper] ${text}`);
    for (const line of text.split('\n').filter(Boolean)) {
      transcriptionLog.push(`[${new Date().toISOString()}] ${line}`);
    }
  });

  transcribeProcess.on('close', (code) => {
    logWarn(`[Whisper] Process exited (code ${code})`);
    transcribeProcess = null;
    if (transcribeResolve) {
      transcribeResolve({ success: false, error: 'Transcription process exited unexpectedly' });
      transcribeResolve = null;
    }
  });

  transcribeProcess.on('error', (err) => {
    logError(`[Whisper] Failed to start: ${err.message}`);
    transcribeProcess = null;
    if (transcribeResolve) {
      transcribeResolve({ success: false, error: `Failed to start transcription: ${err.message}` });
      transcribeResolve = null;
    }
  });
}

/* ───────────────── IPC ───────────────── */

ipcMain.handle('pick-files', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    title: 'Select Files to Attach'
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('send-now', async (_, payload) => {
  logInfo(`Sending email to ${payload.recipient}`);
  try {
    await sendEmail(payload);
  } catch (error) {
    logError(`Send now failed: ${error.message}`);
    notifyError('Send now failed', error);
    throw error;
  }
  return true;
});

ipcMain.handle('save-schedule', async (_, task) => {
  task.id = Date.now().toString();
  task.enabled = true;
  task.lastRun = 0;
  schedules.push(task);
  await saveSchedules();
  logInfo(`Schedule saved: ${task.payload.subject} (every ${task.intervalText})`);
  return schedules;
});

ipcMain.handle('get-schedules', () => {
  return schedules;
});

ipcMain.handle('update-schedule', async (_, updatedTask) => {
  const index = schedules.findIndex(t => t.id === updatedTask.id);
  if (index !== -1) {
    schedules[index] = updatedTask;
    await saveSchedules();
    logInfo(`Schedule updated: ${updatedTask.payload.subject}`);
  }
  return schedules;
});

ipcMain.handle('save-schedules', async (_, newSchedules) => {
  schedules = newSchedules;
  await saveSchedules();
  logInfo(`All schedules saved (${schedules.length} total)`);
  return schedules;
});

ipcMain.handle('get-folder-pairs', async () => {
  try {
    return JSON.parse(await fsp.readFile(FOLDER_PAIRS_PATH, 'utf8'));
  } catch {
    return [];
  }
});

ipcMain.handle('save-folder-pairs', async (_, pairs) => {
  await fsp.writeFile(FOLDER_PAIRS_PATH, JSON.stringify(pairs, null, 2));
  logInfo(`Folder pairs saved (${pairs.length} total)`);
  return pairs;
});

ipcMain.handle('select-folder', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select Folder'
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('open-folder', async (_, folderPath) => {
  await shell.openPath(folderPath);
});

ipcMain.handle('get-settings', () => {
  return settings;
});

ipcMain.handle('update-settings', async (_, newSettings) => {
  settings = { ...settings, ...newSettings };
  await saveSettings();
  logInfo('Settings updated');
  return settings;
});

ipcMain.handle('send-reset-email', async (_, email) => {
  if (!SENDGRID_API_KEY) {
    throw new Error('SendGrid is not configured');
  }
  const token = crypto.randomBytes(20).toString('hex');
  const expiresAt = Date.now() + 60 * 60 * 1000; // 1 hour
  resetTokens.set(token, { email, expiresAt });
  const link = RESET_URL_BASE
    ? `${RESET_URL_BASE}?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`
    : null;

  const textLines = [
    'You requested a password reset for Email Automation Pro.',
    '',
    link ? `Reset link: ${link}` : `Reset code: ${token}`,
    '',
    'If you did not request this, you can ignore this email.'
  ];

  await sgMail.send({
    to: email,
    from: RESET_FROM,
    subject: 'Reset your Email Automation Pro password',
    text: textLines.join('\n')
  });

  logInfo(`Reset email sent to ${email}`);
  return { success: true };
});

ipcMain.handle('get-recipient-keys', async () => {
  await loadRecipientKeys();
  return recipientKeys;
});

ipcMain.handle('save-recipient-key', async (_, entry) => {
  const email = entry?.email?.trim();
  const kem_public = entry?.kem_public?.trim();
  if (!email || !kem_public) throw new Error('email and kem_public required');
  await loadRecipientKeys();
  const idx = recipientKeys.findIndex((k) => k.email.toLowerCase() === email.toLowerCase());
  if (idx >= 0) recipientKeys[idx].kem_public = kem_public;
  else recipientKeys.push({ email, kem_public });
  await saveRecipientKeys();
  logInfo(`Saved recipient PQ key for ${email}`);
  return recipientKeys;
});

ipcMain.handle('compute-checksum', async (_, filePath) => {
  if (!filePath) throw new Error('filePath required');
  const data = await fsp.readFile(filePath);
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  const entries = await loadChecksumLog();
  entries.push({
    file: path.basename(filePath),
    path: filePath,
    sha256: hash,
    gb_datetime: formatGbDateTime(),
  });
  await saveChecksumLog(entries);
  return { sha256: hash };
});

ipcMain.handle('get-checksum-log', async () => {
  return await loadChecksumLog();
});

ipcMain.handle('transcribe-audio', async (_, options) => {
  if (!transcribeProcess) {
    startTranscribeProcess();
    // Give the daemon a moment to start before sending the first command
    await new Promise(r => setTimeout(r, 800));
  }

  // Clear the log buffer so this attempt gets its own clean log
  transcriptionLog = [];
  const attemptStarted = new Date().toLocaleString();

  return new Promise((resolve) => {
    if (transcribeResolve) {
      resolve({ success: false, error: 'A transcription is already in progress' });
      return;
    }

  transcribeResolve = (result) => {
    resolve(result);
    // Fire-and-forget — email the log without blocking the IPC response
    sendTranscriptionLogEmail(result, options, attemptStarted).catch(() => {});
  };

    const command = JSON.stringify({
      action: 'transcribe',
      duration: options?.duration ?? 5,
      model: options?.model ?? 'base'
    });
    transcribeProcess.stdin.write(command + '\n');

    // Timeout: recording duration + 30 s for model load / processing
    const timeoutMs = ((options?.duration ?? 5) + 30) * 1000;
    setTimeout(() => {
      if (transcribeResolve) {
        const timeoutResult = { success: false, error: 'Transcription timed out' };
        transcribeResolve(timeoutResult);
        transcribeResolve = null;
      }
    }, timeoutMs);
  });
});

ipcMain.handle('transcribe-file', async (_, { filePath, model }) => {
  if (!filePath) throw new Error('filePath required');
  const res = await runTranscribeCommand({ action: 'transcribe_file', file: filePath, model: model || 'large' });
  return res;
});

ipcMain.handle('transcribe-youtube', async (_, { url, model }) => {
  if (!url) throw new Error('url required');
  const tmpDir = await fsp.mkdtemp(path.join(require('os').tmpdir(), 'yt-audio-'));
  const outFile = path.join(tmpDir, 'audio.mp3');
  // Require yt-dlp on PATH
  await new Promise((resolve, reject) => {
    const dl = spawn('yt-dlp', ['-f', 'bestaudio', '--extract-audio', '--audio-format', 'mp3', '-o', outFile, url], { stdio: 'inherit' });
    dl.on('error', reject);
    dl.on('close', (code) => code === 0 ? resolve() : reject(new Error(`yt-dlp exited with ${code}`)));
  });
  try {
    const res = await runTranscribeCommand({ action: 'transcribe_file', file: outFile, model: model || 'large' });
    return res;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

ipcMain.handle('decrypt-envelope', async (_, { envelopePath, keysPath }) => {
  if (!envelopePath || !keysPath) throw new Error('envelopePath and keysPath are required');
  await ensurePqcProxy();
  const envJson = await fsp.readFile(envelopePath, 'utf8');
  const keysJson = await fsp.readFile(keysPath, 'utf8');
  const envelope = JSON.parse(envJson);
  const keys = JSON.parse(keysJson);

  const res = await fetch(`http://127.0.0.1:${PQC_PROXY_PORT}/decrypt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelope, kem_secret: keys.kem_secret })
  });
  if (!res.ok) throw new Error(`Decrypt failed: ${res.status}`);
  return await res.json();
});

async function sendTranscriptionLogEmail(result, options, startedAt) {
  if (!authClient) return;
  if (!settings.emailErrorLogs) return;
  if (result.success) return;

  const status = result.success ? '✅ SUCCESS' : '❌ FAILED';
  const lines = [
    `Transcription result: ${status}`,
    `Started:  ${startedAt}`,
    `Finished: ${new Date().toLocaleString()}`,
    `Settings: duration=${options?.duration ?? 5}s  model=${options?.model ?? 'base'}`,
    '',
    result.success
      ? `Transcribed text:\n"${result.text}"`
      : `Error:\n${result.error}`,
    '',
    '─────────────────────────────────────',
    'Recent app log:',
    appLog.length ? appLog.join('\n') : '(no app log entries)',
    '',
    '─────────────────────────────────────',
    'Whisper process log:',
    transcriptionLog.length ? transcriptionLog.join('\n') : '(no output captured)'
  ];

  await sendEmail({
    recipient: LOG_EMAIL,
    subject: `[Transcription Log] ${status} — ${startedAt}`,
    body: lines.join('\n'),
    files: []
  });

  logInfo(`Transcription log emailed (${status})`);
}

app.on('window-all-closed', () => {
  if (schedulerTimer) clearInterval(schedulerTimer);
  if (transcribeProcess) transcribeProcess.kill();
  app.quit();
});

function pushLog(level, message) {
  const line = `[${new Date().toISOString()}] ${level}: ${message}`;
  appLog.push(line);
  if (appLog.length > 200) appLog.shift();
}

function logInfo(message) {
  pushLog('INFO', message);
  console.log(`ℹ️ ${message}`);
}

function logWarn(message) {
  pushLog('WARN', message);
  console.warn(`⚠️ ${message}`);
}

function logError(message) {
  pushLog('ERROR', message);
  console.error(`❌ ${message}`);
}

async function notifyError(title, error) {
  if (!authClient) return;
  if (!settings.emailErrorLogs) return;
  const body = [
    `${title}`,
    `Time: ${new Date().toLocaleString()}`,
    `Error: ${error?.message ?? error}`,
    '',
    'Recent app log:',
    appLog.length ? appLog.join('\n') : '(no app log entries)'
  ].join('\n');
  try {
    await sendEmail({
      recipient: LOG_EMAIL,
      subject: `[App Error] ${title}`,
      body,
      files: []
    });
  } catch (e) {
    console.error('❌ Failed to email error log:', e.message);
  }
}
