#!/usr/bin/env node
/**
 * Launcher for `npm start`.
 *
 * Editors and agent tooling (VS Code's extension host among them) export
 * ELECTRON_RUN_AS_NODE=1. Inherited into our own launch it makes electron.exe
 * behave like plain Node: no app object, no window, just a confusing
 * "Cannot read properties of undefined" crash. Strip it before spawning.
 */
'use strict';

const path = require('path');
const { spawn } = require('child_process');

const electron = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [path.join(__dirname, '..'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});

child.on('close', (code) => process.exit(code == null ? 0 : code));
