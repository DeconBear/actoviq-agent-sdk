#!/usr/bin/env node
// Fake `crush` CLI — prints plain text to stdout (no JSON framing).
// Used by bridge provider tests for the PlainTextNormalizer path.
import process from 'node:process';

const prompt = process.argv[process.argv.length - 1] ?? '';
const text = prompt === 'who-am-i' ? `crush:agent:inherit` : `crush:${prompt}`;
process.stdout.write(text);
