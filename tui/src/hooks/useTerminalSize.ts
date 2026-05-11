import { useContext, useState, useEffect } from 'react';
import { TerminalSizeContext } from '../ink/components/TerminalSizeContext.js';

export function useTerminalSize() {
  const ctxSize = useContext(TerminalSizeContext);
  const [size, setSize] = useState({
    width: ctxSize?.columns ?? process.stdout.columns ?? 80,
    height: ctxSize?.rows ?? process.stdout.rows ?? 24,
  });

  useEffect(() => {
    function update() {
      setSize({
        width: process.stdout.columns ?? 80,
        height: process.stdout.rows ?? 24,
      });
    }
    process.stdout.on('resize', update);
    return () => { process.stdout.off('resize', update); };
  }, []);

  // Use context size when available (custom Ink sets it)
  if (ctxSize) {
    return { width: ctxSize.columns, height: ctxSize.rows };
  }
  return size;
}
