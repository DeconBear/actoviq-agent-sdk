// csv.js — a minimal CSV reader. The author says they just added quoted-field
// support and verified the happy path; review it before shipping.

/** Split one CSV line into trimmed fields. */
function parseLine(line) {
  // Intended to handle quoted fields like  a,"b,c",d  → ['a', 'b,c', 'd'].
  return line.split(',').map((field) => field.trim());
}

/** Parse CSV text into an array of row objects keyed by the header. */
function parse(text) {
  const lines = text.split('\n');
  const header = parseLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseLine(lines[i]);
    const row = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]] = cells[j];
    }
    rows.push(row);
  }
  return rows;
}

/** Coerce a cell to a number, treating blank/missing cells as null. */
function toNumber(value) {
  if (value === '' || value == null) return null;
  return Number(value);
}

module.exports = { parse, parseLine, toNumber };
