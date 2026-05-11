import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { type ActoviqAgentClient, type ActoviqPermissionMode, TaskScheduler } from 'actoviq-agent-sdk';
import type { UIMessage, PermissionState } from './context.js';
import { useAgentStream } from './hooks/useAgentStream.js';
import { useSessionList } from './hooks/useSessionList.js';
import { useKeyboard } from './hooks/useKeyboard.js';
import { useAutocomplete, type CommandDef } from './hooks/useAutocomplete.js';
import { MainLayout } from './components/MainLayout.js';
import { SlashCommandOverlay } from './components/SlashCommandOverlay.js';
import { createCommandRegistry, registerBuiltinCommands, type CommandContext } from './commands.js';

interface AppProps {
  client: ActoviqAgentClient;
  initialModel?: string;
  initialSession?: string;
}

export function App({ client, initialModel, initialSession }: AppProps) {
  const DEFAULT_MODELS = [
    'deepseek-v4-pro',
    'deepseek-v4-flash',
    'claude-medium-4-6',
    'claude-max-4-7',
    'claude-min-4-5-20251001',
  ];

  // ── Model state ───────────────────────────────────────────────
  const [model, setModel] = useState<string>(
    initialModel ?? client.config.model ?? DEFAULT_MODELS[0]!
  );

  // ── Session management ────────────────────────────────────────
  const {
    sessions,
    activeSession,
    switchSession,
    createSession: createNewSession,
    deleteSession,
    renameSession,
  } = useSessionList(client, initialSession);

  // ── Stream state ──────────────────────────────────────────────
  const {
    messages,
    streamingText,
    streamingBlocks,
    streaming,
    phase,
    error,
    send,
    abort,
    clearMessages,
  } = useAgentStream();

  // ── UI state ──────────────────────────────────────────────────
  const [permissionMode, setPermissionMode] = useState<ActoviqPermissionMode>('default');
  const [permissionDialog, setPermissionDialog] = useState<PermissionState | null>(null);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [systemMessages, setSystemMessages] = useState<UIMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef('');
  const [scrollOffset, setScrollOffset] = useState(0);
  const prevStreamingRef = useRef(false);

  // Auto-scroll to bottom only when streaming starts, not on every message
  useEffect(() => {
    if (streaming && !prevStreamingRef.current) {
      setScrollOffset(0);
    }
    prevStreamingRef.current = streaming;
  }, [streaming]);

  // ── Scheduler ref ─────────────────────────────────────────────
  const schedulerRef = useRef<TaskScheduler | null>(null);
  useEffect(() => {
    schedulerRef.current = new TaskScheduler();
    return () => { schedulerRef.current?.dispose().catch(() => {}); };
  }, []);

  // ── Started-at for status bar ─────────────────────────────────
  const [startedAt, setStartedAt] = useState<string | undefined>(undefined);

  // Keep a ref to the latest activeSession to avoid stale closures in async handlers
  const activeSessionRef = useRef(activeSession);
  useEffect(() => {
    activeSessionRef.current = activeSession;
  }, [activeSession]);

  // Permission resolve ref to avoid dialog-state race
  const permissionResolveRef = useRef<((allowed: boolean) => void) | null>(null);

  // ── Slash command definitions ─────────────────────────────────
  const commandDefs: CommandDef[] = useMemo(() => [
    { name: 'help', description: 'Show available commands' },
    { name: 'clear', description: 'Clear the screen' },
    { name: 'memory', description: 'Show memory/compact state' },
    { name: 'compact', description: 'Compact the current session' },
    { name: 'dream', description: 'Trigger memory consolidation' },
    { name: 'tools', description: 'List available tools' },
    { name: 'skills', description: 'List available skills' },
    { name: 'agents', description: 'List registered agents' },
    { name: 'session', description: 'Session management (new/switch/delete/list)' },
    { name: 'scheduler', description: 'Show scheduled tasks' },
    { name: 'checkpoint', description: 'Checkpoint management (save/list/restore)' },
    { name: 'swarm', description: 'Multi-agent swarm operations' },
    { name: 'buddy', description: 'Show companion status' },
    { name: 'model', description: 'Show or change the model' },
  ], []);

  const autocomplete = useAutocomplete(commandDefs);

  // ── Merged messages ───────────────────────────────────────────
  const allMessages = useMemo(
    () => [...systemMessages, ...messages],
    [systemMessages, messages],
  );

  const appendSystemMessage = useCallback((text: string) => {
    const msg: UIMessage = {
      id: `sys-${Date.now()}`,
      role: 'system',
      content: [{ type: 'text', text }],
      timestamp: new Date().toISOString(),
    };
    setSystemMessages((prev) => [...prev, msg]);
  }, []);

  // ── Compact state ─────────────────────────────────────────────
  const [compactState, setCompactState] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    if (activeSession) {
      activeSession.compactState()
        .then((s) => setCompactState(s as unknown as Record<string, unknown>))
        .catch(() => setCompactState(null));
    }
  }, [activeSession]);

  // ── Skills / agents / buddy — resolved from SDK ───────────────
  const getSkills = useCallback(() => {
    try { return client.skills.list(); } catch { return []; }
  }, [client]);

  const getAgents = useCallback(() => {
    try { return client.agents.list(); } catch { return []; }
  }, [client]);

  const getBuddyStatus = useCallback(() => {
    try { return `Buddy: ${client.buddy ? 'configured' : 'not configured'}`; } catch { return 'Buddy is not configured.'; }
  }, [client]);

  // ── Slash command context ─────────────────────────────────────
  const commandContext: CommandContext = useMemo(() => ({
    currentSessionId: activeSession?.id ?? null,
    onClear: () => { clearMessages(); setSystemMessages([]); },
    getCompactState: async () => {
      if (!activeSession) return null;
      try { const s = await activeSession.compactState(); return { compactCount: s?.compactCount }; } catch { return null; }
    },
    compact: async (force) => {
      if (!activeSession) return null;
      try { const r = await activeSession.compact({ force }); return { summarizedCount: r?.messagesRemoved }; } catch { return null; }
    },
    dream: async (force) => {
      if (!activeSession) return;
      try { await activeSession.dream({ force }); } catch {}
    },
    getTools: async () => {
      try {
        const metadata = await client.tools.listMetadata();
        return metadata.map((t) => ({ name: t.name, description: t.description }));
      } catch {
        return [];
      }
    },
    getSkills,
    getAgents,
    getSessions: () => sessions.map((s) => ({ id: s.id, title: s.title })),
    createSession: async (opts) => { await createNewSession(opts?.title); },
    switchSession: async (id) => { await switchSession(id); },
    deleteSession: async (id) => { await deleteSession(id); },
    getScheduledTasks: async () => {
      if (!schedulerRef.current) return [];
      return schedulerRef.current.list();
    },
    saveCheckpoint: async (label) => {
      if (!activeSession) throw new Error('No session');
      const cp = await activeSession.saveCheckpoint(label);
      return { id: cp.id };
    },
    listCheckpoints: async () => {
      if (!activeSession) return [];
      return activeSession.listCheckpoints();
    },
    restoreCheckpoint: async (id) => {
      if (!activeSession) throw new Error('No session');
      await activeSession.restoreCheckpoint(id);
    },
    getModel: () => model,
    setModel: async (m: string) => { setModel(m); return true; },
    listModels: () => DEFAULT_MODELS,
    getBuddyStatus,
  }), [activeSession, sessions, clearMessages, createNewSession, switchSession, deleteSession, model, getSkills, getAgents, getBuddyStatus]);

  const commandRegistry = useMemo(() => {
    const reg = createCommandRegistry();
    registerBuiltinCommands(reg, commandContext);
    return reg;
  }, [commandContext]);

  // ── Navigation ────────────────────────────────────────────────
  const [historyIdx, setHistoryIdx] = useState(-1);

  // Update input from history when navigating
  useEffect(() => {
    if (historyIdx >= 0 && historyIdx < inputHistory.length) {
      const text = inputHistory[inputHistory.length - 1 - historyIdx]!;
      setInputValue(text);
      inputRef.current = text;
    } else if (historyIdx === -1) {
      setInputValue('');
      inputRef.current = '';
    }
  }, [historyIdx, inputHistory]);

  // ── Tab completion ────────────────────────────────────────────
  const handleTabComplete = useCallback(() => {
    if (autocomplete.active && autocomplete.selected) {
      setInputValue(`/${autocomplete.selected.text} `);
      autocomplete.dismiss();
    }
  }, [autocomplete]);

  // ── Input change ─────────────────────────────────────────────
  const handleInputChange = useCallback((value: string) => {
    setInputValue(value);
    inputRef.current = value;
    autocomplete.update(value);
    // Reset history navigation when user starts typing manually
    if (historyIdx !== -1) {
      setHistoryIdx(-1);
    }
  }, [autocomplete, historyIdx]);

  // ── Send handler ──────────────────────────────────────────────
  const handleSend = useCallback(async (text: string) => {
    // Don't send if overlay is active
    if (autocomplete.active) return;
    autocomplete.dismiss();

    if (text.startsWith('/')) {
      const spaceIdx = text.indexOf(' ');
      const cmdName = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx);
      const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1);

      const cmd = commandRegistry.get(cmdName);
      if (cmd) {
        const result = await Promise.resolve(cmd.handler(args));
        if (result) appendSystemMessage(result);
        return;
      }
    }

    const session = activeSessionRef.current;
    if (!session) {
      appendSystemMessage('No active session. Use /session new to create one.');
      return;
    }

    setInputHistory((prev) => {
      const next = [...prev, text];
      return next.length > 100 ? next.slice(next.length - 100) : next;
    });
    setStartedAt(new Date().toISOString());
    await send(session, text, {
      model,
      onPermissionRequest: async (toolName, args, toolDesc) => {
        if (permissionMode === 'bypassPermissions') {
          return true;
        }
        return new Promise<boolean>((resolve) => {
          permissionResolveRef.current = resolve;
          setPermissionDialog({
            toolName,
            toolDescription: toolDesc,
            input: args,
            resolve: (allowed) => {
              permissionResolveRef.current = null;
              setPermissionDialog(null);
              resolve(allowed);
            },
          });
        });
      },
    });
  }, [commandRegistry, send, appendSystemMessage, autocomplete, permissionMode, model]);

  const cyclePermissionMode = useCallback(() => {
    setPermissionMode((prev) => {
      const modes: ActoviqPermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
      const idx = modes.indexOf(prev);
      return modes[(idx + 1) % modes.length]!;
    });
  }, []);

  // ── Keyboard context ──────────────────────────────────────────
  const overlayActive = autocomplete.active;
  const keyContext = permissionDialog ? 'permission' : streaming ? 'streaming' : overlayActive ? 'overlay' : 'default';

  const { suppressChar } = useKeyboard({
    // Ctrl+Enter submit: use the ref to get current input value
    onSubmit: () => {
      const currentValue = inputRef.current.trim();
      if (currentValue) {
        handleSend(currentValue);
        setInputValue('');
        inputRef.current = '';
        autocomplete.dismiss();
      }
    },
    onAbort: () => { if (streaming) abort(); },
    onClear: () => { clearMessages(); setSystemMessages([]); },
    onCyclePermissionMode: cyclePermissionMode,
    onOverlayUp: () => autocomplete.selectPrev(),
    onOverlayDown: () => autocomplete.selectNext(),
    onOverlayComplete: handleTabComplete,
    onOverlayDismiss: () => autocomplete.dismiss(),
    onNavigateUp: () => setHistoryIdx((i) => Math.min(i + 1, inputHistory.length - 1)),
    onNavigateDown: () => setHistoryIdx((i) => Math.max(i - 1, -1)),
    onPermissionYes: () => {
      permissionResolveRef.current?.(true);
      permissionResolveRef.current = null;
      setPermissionDialog(null);
    },
    onPermissionNo: () => {
      permissionResolveRef.current?.(false);
      permissionResolveRef.current = null;
      setPermissionDialog(null);
    },
    onScrollUp: () => setScrollOffset((o) => Math.min(o + 5, Math.max(0, allMessages.length - 1))),
    onScrollDown: () => setScrollOffset((o) => Math.max(0, o - 5)),
    context: keyContext,
    enabled: true,
  });

  // ── Overlay ───────────────────────────────────────────────────
  const overlay = autocomplete.active ? (
    <SlashCommandOverlay
      suggestions={autocomplete.suggestions}
      selectedIdx={autocomplete.selectedIdx}
    />
  ) : null;

  // ── Render ────────────────────────────────────────────────────
  return (
    <MainLayout
      sessionName={activeSession?.title ?? 'actoviq'}
      model={model}
      permissionMode={permissionMode}
      streaming={streaming}
      messages={allMessages}
      streamingBlocks={streamingBlocks}
      error={error}
      permissionDialog={permissionDialog}
      overlay={overlay}
      inputHistory={inputHistory}
      inputValue={inputValue}
      onSend={handleSend}
      onInputChange={handleInputChange}
      onTabComplete={handleTabComplete}
      suppressChar={suppressChar}
      startedAt={startedAt}
      scrollOffset={scrollOffset}
      phase={phase}
    />
  );
}
