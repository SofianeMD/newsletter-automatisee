#!/usr/bin/env node
'use strict';

/**
 * Publication Discord de la newsletter (webhook).
 *
 * Lit un PDF et un TXT à un chemin précis, puis envoie le texte (découpé si > 2000
 * caractères) et le PDF en pièce jointe sur le canal lié au webhook.
 *
 * Usage :
 *   node publish_discord.js                      # édition du jour (heure de Paris)
 *   node publish_discord.js --date 2026-10-13    # édition d'une date précise
 *   node publish_discord.js --dry-run            # vérifie tout sans rien envoyer
 *   node publish_discord.js --force              # republie même si déjà envoyé
 *
 * Code de sortie : 0 = publié (ou déjà publié), 1 = erreur.
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');

try {
  require('dotenv').config();
} catch {
  // dotenv absent : on utilise les variables d'environnement du système
}

// ---------------------------------------------------------------- Configuration

const MAX_CONTENT = 2000; // limite Discord par message
const MAX_ATTEMPTS = 4;
const WEBHOOK_REGEX = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+\/?$/;

function getConfig() {
  return {
    webhookUrl: (process.env.DISCORD_WEBHOOK_URL || '').trim(),
    // Chemins avec le marqueur {date} remplacé par AAAA-MM-JJ
    pdfTemplate: process.env.PDF_PATH || 'output/{date}/newsletter.pdf',
    txtTemplate: process.env.TXT_PATH || 'output/{date}/newsletter.txt',
    maxFileMb: Number(process.env.MAX_FILE_MB || 10),
    suppressEmbeds: (process.env.SUPPRESS_EMBEDS || 'true').toLowerCase() !== 'false',
    logFile: process.env.LOG_FILE || path.join('logs', 'discord.log'),
  };
}

// ---------------------------------------------------------------------- Logs

function makeLogger(logFile) {
  return (level, message) => {
    const line = `${new Date().toISOString()} [${level}] [discord] ${message}`;
    (level === 'ERROR' ? console.error : console.log)(line);
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, line + '\n');
    } catch {
      // un problème de log ne doit jamais bloquer la publication
    }
  };
}

// ------------------------------------------------------------------ Utilitaires

function todayInParis() {
  // Format AAAA-MM-JJ (locale en-CA), fuseau Europe/Paris
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Découpe un texte en morceaux de max `max` caractères, en coupant de préférence sur un paragraphe. */
function splitMessage(text, max = MAX_CONTENT) {
  const chunks = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// ------------------------------------------------------- État anti-doublon

function stateFilePath(pdfPath) {
  return path.join(path.dirname(pdfPath), '.discord_state.json');
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { sent: 0, done: false };
  }
}

function writeState(file, state) {
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

// ------------------------------------------------------------ Envoi au webhook

/**
 * Envoie un message (avec ou sans PDF). Retente en cas de rate limit (429),
 * d'erreur serveur (5xx) ou d'erreur réseau. Lève une erreur sinon.
 */
async function postToWebhook(config, log, { content, file }) {
  const url = new URL(config.webhookUrl);
  url.searchParams.set('wait', 'true'); // Discord renvoie le message créé (confirmation)

  const payload = {
    content,
    allowed_mentions: { parse: [] }, // aucun @everyone / @here / mention accidentelle
    ...(config.suppressEmbeds ? { flags: 4 } : {}),
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response;
    try {
      if (file) {
        const form = new FormData();
        form.append('payload_json', JSON.stringify(payload));
        form.append('files[0]', new Blob([file.buffer], { type: 'application/pdf' }), file.name);
        response = await fetch(url, { method: 'POST', body: form });
      } else {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      }
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw new Error(`Erreur réseau : ${err.message}`);
      const wait = 2000 * 2 ** (attempt - 1);
      log('WARN', `Erreur réseau (${err.message}), nouvelle tentative dans ${wait / 1000}s (${attempt}/${MAX_ATTEMPTS})`);
      await sleep(wait);
      continue;
    }

    if (response.ok) {
      const message = await response.json().catch(() => ({}));
      return message; // contient l'id du message publié
    }

    if (response.status === 429) {
      const body = await response.json().catch(() => ({}));
      const retryAfter = Number(body.retry_after ?? response.headers.get('retry-after') ?? 5);
      if (attempt === MAX_ATTEMPTS) throw new Error('Rate limit Discord : trop de tentatives');
      log('WARN', `Rate limit (429), attente de ${retryAfter}s (${attempt}/${MAX_ATTEMPTS})`);
      await sleep(Math.ceil(retryAfter * 1000) + 250);
      continue;
    }

    if (response.status >= 500 && attempt < MAX_ATTEMPTS) {
      const wait = 2000 * 2 ** (attempt - 1);
      log('WARN', `Erreur Discord ${response.status}, nouvelle tentative dans ${wait / 1000}s (${attempt}/${MAX_ATTEMPTS})`);
      await sleep(wait);
      continue;
    }

    // Erreur non récupérable (400, 401, 403, 404, 413...)
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new Error(`Discord a répondu HTTP ${response.status} : ${detail}`);
  }
}

// ------------------------------------------------------------ Fonction principale

async function publishToDiscord({ date, dryRun = false, force = false } = {}) {
  const config = getConfig();
  const log = makeLogger(config.logFile);
  const editionDate = date || todayInParis();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(editionDate)) {
    log('ERROR', `Date invalide : "${editionDate}" (format attendu AAAA-MM-JJ)`);
    return 1;
  }

  const pdfPath = path.resolve(config.pdfTemplate.replaceAll('{date}', editionDate));
  const txtPath = path.resolve(config.txtTemplate.replaceAll('{date}', editionDate));
  log('INFO', `Édition ${editionDate} | PDF : ${pdfPath} | TXT : ${txtPath}${dryRun ? ' | DRY-RUN' : ''}`);

  // 1. Configuration du webhook
  if (!config.webhookUrl) {
    log('ERROR', 'DISCORD_WEBHOOK_URL est absent (fichier .env ou variable d\'environnement)');
    return 1;
  }
  if (!WEBHOOK_REGEX.test(config.webhookUrl)) {
    log('ERROR', 'DISCORD_WEBHOOK_URL n\'a pas le format d\'une URL de webhook Discord');
    return 1;
  }

  // 2. Fichiers présents et valides : sinon on ne publie rien
  const missing = [pdfPath, txtPath].filter((p) => !fs.existsSync(p));
  if (missing.length > 0) {
    log('ERROR', `Fichier(s) introuvable(s) : ${missing.join(', ')} — rien n'a été publié`);
    return 1;
  }

  const pdfSize = fs.statSync(pdfPath).size;
  if (pdfSize === 0) {
    log('ERROR', 'Le PDF est vide — rien n\'a été publié');
    return 1;
  }
  if (pdfSize > config.maxFileMb * 1024 * 1024) {
    log('ERROR', `Le PDF fait ${(pdfSize / 1048576).toFixed(1)} Mo (max ${config.maxFileMb} Mo) — rien n'a été publié`);
    return 1;
  }

  const text = fs.readFileSync(txtPath, 'utf8').replace(/^\uFEFF/, '');
  const chunks = splitMessage(text);
  const totalMessages = Math.max(chunks.length, 1); // le 1er message porte le PDF, même si le texte est vide

  // 3. Anti-doublon
  const stateFile = stateFilePath(pdfPath);
  let state = force ? { sent: 0, done: false } : readState(stateFile);
  if (state.done) {
    log('INFO', `Édition ${editionDate} déjà publiée — rien à faire (utiliser --force pour republier)`);
    return 0;
  }
  if (state.sent > 0) {
    log('WARN', `Reprise après une publication partielle : ${state.sent}/${totalMessages} message(s) déjà envoyé(s)`);
  }

  if (dryRun) {
    log('INFO', `DRY-RUN : ${totalMessages} message(s) à envoyer, PDF ${(pdfSize / 1024).toFixed(0)} Ko — rien envoyé`);
    return 0;
  }

  // 4. Envoi : le 1er message porte le PDF, les suivants complètent le texte
  const pdfFile = { name: path.basename(pdfPath), buffer: fs.readFileSync(pdfPath) };
  try {
    for (let i = state.sent; i < totalMessages; i++) {
      const message = await postToWebhook(config, log, {
        content: chunks[i] || '',
        file: i === 0 ? pdfFile : undefined,
      });
      state = { sent: i + 1, done: i + 1 === totalMessages };
      writeState(stateFile, state);
      log('INFO', `Message ${i + 1}/${totalMessages} publié (id ${message.id ?? 'inconnu'})${i === 0 ? ' avec le PDF' : ''}`);
      if (i + 1 < totalMessages) await sleep(1000); // marge face au rate limit
    }
  } catch (err) {
    log('ERROR', `Échec de la publication (${state.sent}/${totalMessages} envoyé(s)) : ${err.message}`);
    return 1;
  }

  log('INFO', `Publication Discord terminée pour l'édition ${editionDate}`);
  return 0;
}

module.exports = { publishToDiscord, splitMessage, todayInParis };

// ------------------------------------------------------------------------- CLI

if (require.main === module) {
  const { values } = parseArgs({
    options: {
      date: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
    },
  });
  publishToDiscord({ date: values.date, dryRun: values['dry-run'], force: values.force })
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`${new Date().toISOString()} [ERROR] [discord] Erreur inattendue : ${err.stack || err}`);
      process.exit(1);
    });
}
