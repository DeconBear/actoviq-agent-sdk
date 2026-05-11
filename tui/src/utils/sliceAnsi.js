export default function sliceAnsi(str, start, end) {
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, '');
  return end !== undefined ? stripped.slice(start, end) : stripped.slice(start);
}
