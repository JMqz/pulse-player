const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./platform');

const LOG_DIR = path.join(DATA_DIR, 'logs');
const LOG_PATH = path.join(LOG_DIR, 'riff.log');
const MAX_BYTES = 1024 * 1024;

function rotate() {
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > MAX_BYTES) fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
  } catch (e) {}
}

function log(level, message, stack) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    rotate();
    let line = `${new Date().toISOString()} [${level}] ${String(message).slice(0, 800)}\n`;
    if (stack) line += String(stack).split('\n').slice(0, 8).map((l) => '    ' + l.trim()).join('\n').slice(0, 1600) + '\n';
    fs.appendFileSync(LOG_PATH, line);
  } catch (e) {}
}

// error(message, err?): ERROR line with the error's message plus the top of its stack.
function error(message, err) {
  let text = String(message);
  let stack = null;
  if (err) {
    const detail = err.message ? err.message : String(err);
    if (detail && !text.includes(detail)) text += ': ' + detail;
    if (err.stack) stack = String(err.stack).split('\n').slice(1).join('\n');
  }
  log('ERROR', text, stack);
}

function tail(lines) {
  try { return fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean).slice(-lines); } catch (e) { return []; }
}

module.exports = { log, error, tail, LOG_DIR };
