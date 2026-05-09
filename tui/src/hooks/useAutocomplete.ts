import { useState, useCallback, useMemo } from 'react';

export interface CompletionItem {
  text: string;
  type: 'slash-command' | 'file' | 'directory';
  description?: string;
}

export interface CommandDef {
  name: string;
  description: string;
}

export function useAutocomplete(commandDefs: CommandDef[]) {
  const [suggestions, setSuggestions] = useState<CompletionItem[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [active, setActive] = useState(false);

  const update = useCallback(
    (input: string) => {
      // Slash command completion — show on / and filter as user types
      if (input.startsWith('/')) {
        const partial = input.slice(1).toLowerCase();
        const matches = commandDefs
          .filter((c) => c.name.startsWith(partial))
          .map(
            (c): CompletionItem => ({
              text: c.name,
              type: 'slash-command',
              description: c.description,
            }),
          );
        if (matches.length > 0) {
          setSuggestions(matches);
          setSelectedIdx(0);
          setActive(true);
          return;
        }
        setSuggestions([]);
        setActive(false);
        return;
      }

      setSuggestions([]);
      setSelectedIdx(0);
      setActive(false);
    },
    [commandDefs],
  );

  const dismiss = useCallback(() => {
    setSuggestions([]);
    setSelectedIdx(0);
    setActive(false);
  }, []);

  const selectNext = useCallback(() => {
    setSelectedIdx((prev) => {
      if (suggestions.length === 0) return 0;
      return (prev + 1) % suggestions.length;
    });
  }, [suggestions.length]);

  const selectPrev = useCallback(() => {
    setSelectedIdx((prev) => {
      if (suggestions.length === 0) return 0;
      return (prev - 1 + suggestions.length) % suggestions.length;
    });
  }, [suggestions.length]);

  const selected = selectedIdx >= 0 && selectedIdx < suggestions.length
    ? suggestions[selectedIdx] ?? null
    : null;

  return {
    suggestions,
    selectedIdx,
    selected,
    active,
    update,
    dismiss,
    selectNext,
    selectPrev,
  } as const;
}
