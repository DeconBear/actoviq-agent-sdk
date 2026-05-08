import { useState, useCallback, useEffect, useRef } from 'react';
import { TaskScheduler, type ScheduledTaskRecord } from 'actoviq-agent-sdk';

export function useScheduler() {
  const schedulerRef = useRef<TaskScheduler | null>(null);
  const [tasks, setTasks] = useState<ScheduledTaskRecord[]>([]);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const scheduler = new TaskScheduler();
    schedulerRef.current = scheduler;
    return () => {
      scheduler.dispose().catch(() => {});
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!schedulerRef.current) return;
    setTasks(await schedulerRef.current.list());
  }, []);

  const toggle = useCallback(() => {
    if (!schedulerRef.current) return;
    if (running) {
      schedulerRef.current.stop();
    } else {
      schedulerRef.current.start();
    }
    setRunning(!running);
  }, [running]);

  return { scheduler: schedulerRef.current, tasks, running, refresh, toggle } as const;
}
