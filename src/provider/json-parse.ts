// JSON escapes valid in JSON strings: \" \\ \/ \b \f \n \r \t \uXXXX
// Any other backslash-char sequence is invalid JSON, commonly seen with
// Windows paths (e.g. C:\Users, D:\project\.actoviq) where models fail
// to double-escape backslashes.
const INVALID_JSON_ESCAPE = /\\(?!["\\/bfnrtu])/g;

/**
 * Parse JSON that may contain invalid escape sequences (common with
 * Windows paths in model-generated tool arguments).
 * Returns the parsed object on success, or { raw } as last resort.
 */
export function robustJsonParse(
  raw: string,
  toolName?: string,
): Record<string, unknown> {
  // Attempt 1: direct parse
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { raw };
  } catch {
    // Attempt 2: fix invalid backslash escapes (Windows paths)
    try {
      const fixed = raw.replace(INVALID_JSON_ESCAPE, '\\\\');
      const parsed = JSON.parse(fixed);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through
    }
    // Attempt 3: double-decode (some providers double-encode JSON)
    try {
      const once = JSON.parse(raw);
      if (typeof once === 'string') {
        const twice = JSON.parse(once);
        if (typeof twice === 'object' && twice !== null && !Array.isArray(twice)) {
          return twice as Record<string, unknown>;
        }
      }
    } catch {
      // Fall through
    }
  }
  // Last resort: wrap raw string so the model can see what went wrong
  return { raw };
}
