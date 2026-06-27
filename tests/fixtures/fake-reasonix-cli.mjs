#!/usr/bin/env node
// Fake `reasonix` CLI — prints plain text to stdout (no JSON framing).
// Used by bridge provider tests for the PlainTextNormalizer path.
import process from 'node:process';

const prompt = process.argv[process.argv.length - 1] ?? '';
const text = prompt === 'who-am-i' ? `reasonix:agent:inherit` : `reasonix:${prompt}`;
process.stdout.write(text);
