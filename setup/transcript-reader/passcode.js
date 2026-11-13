#!/usr/bin/env node
'use strict';

// Sets the passcode for opening the reader from another device on the tailnet (tailnet.js):
// asks for it twice on the terminal without echoing it, and stores only a salted scrypt hash
// in the given file, owner-only. The passcode is never an argument, never printed and never
// logged, and there is no default one. Run through `serve.sh passcode`.
//
//   node setup/transcript-reader/passcode.js <passcode file>

const { writePasscodeFile, passcodeProblem } = require('./tailnet');

// Reads one line from the terminal, showing nothing. Resolves to null on Ctrl-C or Ctrl-D.
function readHidden(prompt) {
  return new Promise((resolve) => {
    const { stdin, stderr } = process;
    let typed = '';
    let escape = false;
    stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const finish = (value) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write('\n');
      resolve(value);
    };
    function onData(chunk) {
      for (const char of Array.from(chunk)) {
        if (escape) { if (/[A-Za-z~]/.test(char)) escape = false; continue; }  // an arrow or another key sequence
        if (char === '\u001b') { escape = true; continue; }
        if (char === '\r' || char === '\n') { finish(typed); return; }
        if (char === '\u0003' || char === '\u0004') { finish(null); return; }
        if (char === '\u007f' || char === '\b') { typed = Array.from(typed).slice(0, -1).join(''); continue; }
        if (char >= ' ') typed += char;
      }
    }
    stdin.on('data', onData);
  });
}

async function main(argv) {
  const file = argv[0];
  if (!file) { process.stderr.write('Usage: passcode.js <passcode file>\n'); return 2; }
  if (!process.stdin.isTTY) { process.stderr.write('Run this in a terminal: the passcode is typed there, never passed as an argument or piped in.\n'); return 2; }
  const first = await readHidden('New passcode (not shown as you type): ');
  if (first === null) { process.stderr.write('Cancelled. Nothing was changed.\n'); return 1; }
  const problem = passcodeProblem(first);
  if (problem) { process.stderr.write(`${problem} Nothing was changed.\n`); return 1; }
  const second = await readHidden('Again: ');
  if (second === null || second !== first) { process.stderr.write('The two entries differ or were cancelled. Nothing was changed.\n'); return 1; }
  await writePasscodeFile(file, first);
  process.stdout.write(`Passcode saved (only its salted hash) in ${file}\n`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => { process.stderr.write(`Could not save the passcode: ${error.message}\n`); process.exit(1); });
}

module.exports = { readHidden };
