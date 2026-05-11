let s;
try { if (typeof Intl.Segmenter === 'function') { s = new Intl.Segmenter('en', { granularity: 'grapheme' }); } } catch {}
export function getGraphemeSegmenter() { return s; }
