import { useState, useEffect } from 'react';
import { useStdout } from 'ink';

export function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ width: 80, height: 24 });

  useEffect(() => {
    function update() {
      setSize({
        width: stdout?.columns ?? process.stdout.columns ?? 80,
        height: stdout?.rows ?? process.stdout.rows ?? 24,
      });
    }
    update();
    stdout?.on('resize', update);
    process.stdout.on('resize', update);
    return () => {
      stdout?.off('resize', update);
      process.stdout.off('resize', update);
    };
  }, [stdout]);

  return size;
}
