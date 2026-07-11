/**
 * Browser transcript UI bundle injected into /app.js.
 * Mirrors src/gui/transcript/parts.ts reducer semantics for the live DOM.
 */
export function getTranscriptClientScript(): string {
  return `
/* === Actoviq transcript UI (parts-driven) === */
(function () {
  const TR = {
    parts: [],
    toolIndex: new Map(),
    currentAssistantId: null,
    currentThinkingId: null,
    seq: 0,
    nodes: new Map(),
    root: null,
    jumpBtn: null,
    stick: true,
    autoScrollPref: true,
    onPermissionDecision: null,
    onAskUserSubmit: null,
    renderMarkdownInto: null,
    scheduleMarkdownRender: null,
    guiIcon: null,
  };

  function nextId(prefix) {
    TR.seq += 1;
    return prefix + '-' + TR.seq;
  }
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => {
      switch (c) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        default: return '&#39;';
      }
    });
  }
  function toolInputHint(inputValue) {
    if (inputValue == null) return '';
    try {
      const obj = typeof inputValue === 'string'
        ? (function () { try { return JSON.parse(inputValue); } catch { return null; } })()
        : inputValue;
      if (obj && typeof obj === 'object') {
        const pick = obj.command || obj.path || obj.file_path || obj.filePath || obj.pattern || obj.query || obj.url || obj.prompt
          || (Array.isArray(obj.questions) ? (obj.questions.length + ' question(s)') : null);
        if (typeof pick === 'string' && pick.trim()) {
          const one = pick.trim().replace(/\\s+/g, ' ');
          return one.length > 72 ? one.slice(0, 72) + '…' : one;
        }
      }
      const text = typeof inputValue === 'string' ? inputValue : JSON.stringify(inputValue);
      const one = text.trim().replace(/\\s+/g, ' ');
      return one.length > 72 ? one.slice(0, 72) + '…' : one;
    } catch { return ''; }
  }
  function summarizeToolInput(inputValue) {
    if (inputValue == null) return '';
    try {
      const text = typeof inputValue === 'string' ? inputValue : JSON.stringify(inputValue, null, 2);
      return text.length > 900 ? text.slice(0, 900) + '\\n...' : text;
    } catch { return String(inputValue); }
  }
  function parseDiffStats(text) {
    const added = Number(String(text).match(/\\+(\\d+)(?:\\s*line)?/i)?.[1] || 0);
    const removed = Number(String(text).match(/(?:^|\\s)-(\\d+)(?:\\s*line)?/im)?.[1] || 0);
    return { added, removed };
  }
  function parseDiffLines(text) {
    const rows = [];
    for (const line of String(text || '').split('\\n')) {
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('diff ')) rows.push({ type: 'meta', text: line });
      else if (line.startsWith('+')) rows.push({ type: 'add', text: line.slice(1) });
      else if (line.startsWith('-')) rows.push({ type: 'del', text: line.slice(1) });
      else rows.push({ type: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line });
    }
    return rows;
  }
  function classifyToolFamily(toolName) {
    const name = String(toolName || '').toLowerCase();
    if (name === 'bash' || name === 'powershell') return 'bash';
    if (name === 'edit' || name === 'write' || name === 'notebookedit') return 'edit';
    if (name === 'todowrite' || name === 'todo') return 'todo';
    if (name === 'read') return 'read';
    if (name === 'glob' || name === 'grep') return 'search';
    if (name === 'tavilysearch' || name === 'websearch' || name === 'webfetch') return 'web';
    if (name === 'task' || name === 'agent') return 'task';
    if (name === 'askuserquestion') return 'question';
    return 'generic';
  }
  function isReadonlyExploreTool(toolName) {
    const f = classifyToolFamily(toolName);
    return f === 'read' || f === 'search';
  }
  function formatDuration(ms) {
    if (typeof ms !== 'number') return '';
    return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
  }
  function iconSvg(name) {
    if (typeof TR.guiIcon === 'function') return TR.guiIcon(name);
    return '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>';
  }
  function toolIconName(family) {
    if (family === 'bash') return 'terminal';
    if (family === 'edit') return 'review';
    if (family === 'todo') return 'list';
    if (family === 'read' || family === 'search') return 'search';
    if (family === 'web') return 'globe';
    if (family === 'task') return 'agent';
    if (family === 'question') return 'chat';
    return 'gear';
  }

  function finalizeStreamingText() {
    if (TR.currentAssistantId) {
      const part = TR.parts.find((p) => p.id === TR.currentAssistantId);
      if (part) part.streaming = false;
    }
    TR.currentAssistantId = null;
    if (TR.currentThinkingId) {
      const part = TR.parts.find((p) => p.id === TR.currentThinkingId);
      if (part) { part.streaming = false; part.collapsed = true; }
    }
    TR.currentThinkingId = null;
  }

  function applyEvent(event) {
    const changed = [];
    const type = String(event.type || '');
    if (type === 'user') {
      finalizeStreamingText();
      const id = nextId('user');
      TR.parts.push({ id, kind: 'user', text: String(event.text || '') });
      changed.push(id);
    } else if (type === 'assistant') {
      finalizeStreamingText();
      const id = nextId('assistant');
      TR.parts.push({ id, kind: 'assistant', text: String(event.text || ''), streaming: false });
      changed.push(id);
    } else if (type === 'delta') {
      const text = String(event.text || '');
      if (!text) return changed;
      if (TR.currentThinkingId) {
        const thinking = TR.parts.find((p) => p.id === TR.currentThinkingId);
        if (thinking) { thinking.streaming = false; thinking.collapsed = true; renderPart(thinking); }
        TR.currentThinkingId = null;
      }
      if (!TR.currentAssistantId) {
        const id = nextId('assistant');
        TR.parts.push({ id, kind: 'assistant', text: '', streaming: true });
        TR.currentAssistantId = id;
        changed.push(id);
      }
      const part = TR.parts.find((p) => p.id === TR.currentAssistantId);
      if (part) { part.text += text; part.streaming = true; changed.push(part.id); }
    } else if (type === 'thinking.delta') {
      const text = String(event.text || '');
      const snapshot = typeof event.snapshot === 'string' ? event.snapshot : undefined;
      if (!TR.currentThinkingId) {
        if (TR.currentAssistantId) {
          const a = TR.parts.find((p) => p.id === TR.currentAssistantId);
          if (a) a.streaming = false;
          TR.currentAssistantId = null;
        }
        const id = nextId('thinking');
        TR.parts.push({ id, kind: 'thinking', text: snapshot != null ? snapshot : text, streaming: true, collapsed: false });
        TR.currentThinkingId = id;
        changed.push(id);
      } else {
        const part = TR.parts.find((p) => p.id === TR.currentThinkingId);
        if (part) {
          part.text = snapshot != null ? snapshot : (part.text + text);
          part.streaming = true;
          part.collapsed = false;
          changed.push(part.id);
        }
      }
    } else if (type === 'tool.call' || type === 'tool') {
      finalizeStreamingText();
      const toolUseId = String(event.id || event.toolUseId || nextId('tool'));
      const toolName = String(event.name || event.toolName || 'Tool');
      const existingIdx = TR.toolIndex.get(toolUseId);
      if (existingIdx != null && TR.parts[existingIdx] && TR.parts[existingIdx].kind === 'tool') {
        const part = TR.parts[existingIdx];
        part.toolName = toolName;
        part.state = 'running';
        part.input = event.input != null ? event.input : part.input;
        part.hint = toolInputHint(part.input);
        part.collapsed = false;
        if (type === 'tool') {
          part.outputText = String(event.text || '');
          part.ok = event.ok !== false;
          part.state = part.ok ? 'success' : 'error';
          part.collapsed = true;
          if (typeof event.durationMs === 'number') part.durationMs = event.durationMs;
        }
        changed.push(part.id);
      } else {
        const id = nextId('tool');
        const done = type === 'tool';
        const part = {
          id, kind: 'tool', toolName, toolUseId,
          state: done ? (event.ok === false ? 'error' : 'success') : 'running',
          input: event.input,
          outputText: done ? String(event.text || '') : undefined,
          ok: done ? event.ok !== false : undefined,
          durationMs: typeof event.durationMs === 'number' ? event.durationMs : undefined,
          hint: toolInputHint(event.input),
          collapsed: done,
        };
        TR.toolIndex.set(toolUseId, TR.parts.length);
        TR.parts.push(part);
        changed.push(id);
      }
    } else if (type === 'tool.input.delta') {
      const toolUseId = String(event.id || ('stream-tool-' + String(event.index ?? 'pending')));
      let idx = TR.toolIndex.get(toolUseId);
      if (idx == null) {
        finalizeStreamingText();
        const id = nextId('tool');
        const part = {
          id, kind: 'tool', toolName: String(event.name || 'Tool'), toolUseId,
          state: 'input-streaming', input: { partial_json: event.snapshot || event.delta || '' },
          hint: 'Building input…', collapsed: false,
        };
        TR.toolIndex.set(toolUseId, TR.parts.length);
        TR.parts.push(part);
        changed.push(id);
      } else {
        const part = TR.parts[idx];
        part.state = 'input-streaming';
        part.input = { partial_json: event.snapshot || event.delta || '' };
        part.hint = 'Building input…';
        changed.push(part.id);
      }
    } else if (type === 'tool.progress') {
      const idx = TR.toolIndex.get(String(event.id || ''));
      if (idx != null) {
        const part = TR.parts[idx];
        const data = event.data;
        const progress = data && typeof data === 'object'
          ? Object.entries(data).map(([k, v]) => k + ': ' + String(v)).slice(0, 3).join(' · ')
          : String(data || '');
        if (progress) part.hint = progress;
        changed.push(part.id);
      }
    } else if (type === 'tool.result') {
      const toolUseId = String(event.id || '');
      let idx = TR.toolIndex.get(toolUseId);
      if (idx == null) {
        applyEvent({ type: 'tool.call', id: toolUseId, name: event.name, input: event.input });
        idx = TR.toolIndex.get(toolUseId);
      }
      if (idx != null) {
        const part = TR.parts[idx];
        part.ok = event.ok !== false;
        part.state = part.ok ? 'success' : 'error';
        part.outputText = String(event.text || '');
        if (typeof event.durationMs === 'number') part.durationMs = event.durationMs;
        if (event.name) part.toolName = String(event.name);
        part.hint = part.hint || toolInputHint(part.input);
        part.collapsed = true;
        changed.push(part.id);
      }
    } else if (type === 'permission.request') {
      const permissionId = String(event.id || '');
      const toolName = String(event.toolName || 'Tool');
      let target = null;
      for (let i = TR.parts.length - 1; i >= 0; i--) {
        const p = TR.parts[i];
        if (p && p.kind === 'tool' && p.toolName === toolName && (p.state === 'running' || p.state === 'input-streaming')) {
          target = p; break;
        }
      }
      if (!target) {
        finalizeStreamingText();
        const toolUseId = String(event.toolUseId || nextId('perm-tool'));
        const id = nextId('tool');
        target = {
          id, kind: 'tool', toolName, toolUseId,
          state: classifyToolFamily(toolName) === 'question' ? 'awaiting-answer' : 'awaiting-approval',
          input: event.input, hint: toolInputHint(event.input) || String(event.summary || ''),
          collapsed: false, permissionId, permissionSummary: String(event.summary || ''),
        };
        TR.toolIndex.set(toolUseId, TR.parts.length);
        TR.parts.push(target);
        changed.push(id);
      } else {
        target.state = classifyToolFamily(toolName) === 'question' ? 'awaiting-answer' : 'awaiting-approval';
        target.permissionId = permissionId;
        target.permissionSummary = String(event.summary || '');
        if (event.input != null) target.input = event.input;
        target.collapsed = false;
        changed.push(target.id);
      }
    } else if (type === 'notice' || type === 'system') {
      const id = nextId(type);
      TR.parts.push({ id, kind: type === 'system' ? 'system' : 'notice', text: String(event.message || event.text || '') });
      changed.push(id);
    } else if (type === 'error') {
      finalizeStreamingText();
      const id = nextId('error');
      TR.parts.push({ id, kind: 'error', text: String(event.message || event.text || 'Error') });
      changed.push(id);
    } else if (type === 'clear') {
      reset();
      return changed;
    } else if (type === 'done') {
      finalizeStreamingText();
      for (const p of TR.parts) {
        if (p.kind === 'assistant' || p.kind === 'thinking') p.streaming = false;
      }
    }
    for (const id of changed) {
      const part = TR.parts.find((p) => p.id === id);
      if (part) renderPart(part);
    }
    if (type === 'done' || type === 'thinking.delta') {
      // re-render thinking collapse state
      for (const p of TR.parts) {
        if (p.kind === 'thinking') renderPart(p);
      }
    }
    maybeScroll();
    return changed;
  }

  function reset() {
    TR.parts = [];
    TR.toolIndex.clear();
    TR.currentAssistantId = null;
    TR.currentThinkingId = null;
    TR.seq = 0;
    TR.nodes.clear();
    if (TR.root) TR.root.textContent = '';
  }

  function ensureShell() {
    if (!TR.root) return;
    const parent = TR.root.parentElement;
    if (!parent) return;
    if (!parent.classList.contains('transcript-shell')) {
      const shell = document.createElement('div');
      shell.className = 'transcript-shell';
      parent.insertBefore(shell, TR.root);
      shell.appendChild(TR.root);
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.className = 'transcript-jump';
      jump.textContent = '↓ Jump to bottom';
      jump.addEventListener('click', () => {
        TR.stick = true;
        jump.classList.remove('visible');
        TR.root.scrollTop = TR.root.scrollHeight;
      });
      shell.appendChild(jump);
      TR.jumpBtn = jump;
      TR.root.addEventListener('scroll', () => {
        const distance = TR.root.scrollHeight - TR.root.scrollTop - TR.root.clientHeight;
        TR.stick = distance < 80;
        if (TR.jumpBtn) TR.jumpBtn.classList.toggle('visible', !TR.stick && TR.root.scrollHeight > TR.root.clientHeight + 40);
      }, { passive: true });
    }
  }

  function maybeScroll() {
    if (!TR.root || !TR.autoScrollPref || !TR.stick) {
      if (TR.jumpBtn && TR.root && !TR.stick) TR.jumpBtn.classList.add('visible');
      return;
    }
    TR.root.scrollTop = TR.root.scrollHeight;
  }

  function toggleCollapsed(part, force) {
    part.collapsed = typeof force === 'boolean' ? force : !part.collapsed;
    renderPart(part);
  }

  function copyText(text) {
    const value = String(text || '');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).catch(() => {});
      return;
    }
    const ta = document.createElement('textarea');
    ta.value = value;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove();
  }

  function buildMessageRow(part) {
    const row = document.createElement('div');
    row.className = 'message-row row-' + (part.kind === 'notice' ? 'system' : part.kind);
    row.dataset.partId = part.id;
    const wrap = document.createElement('div');
    wrap.className = 'msg-wrap';
    if (part.kind === 'error') {
      const label = document.createElement('div');
      label.className = 'msg-error-label';
      label.textContent = 'Error';
      wrap.appendChild(label);
    }
    const node = document.createElement('div');
    const msgKind = part.kind === 'notice' ? 'system' : part.kind;
    node.className = 'message ' + msgKind + ((msgKind === 'user' || msgKind === 'assistant') ? ' md-prose' : '');
    if (msgKind === 'user' || msgKind === 'assistant') {
      if (typeof TR.renderMarkdownInto === 'function') TR.renderMarkdownInto(node, part.text || '');
      else node.textContent = part.text || '';
      if (part.streaming && typeof TR.scheduleMarkdownRender === 'function') {
        node.dataset.raw = part.text || '';
        TR.scheduleMarkdownRender(node);
      }
      const bar = document.createElement('div');
      bar.className = 'msg-copy-bar';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Copy';
      btn.addEventListener('click', (ev) => { ev.stopPropagation(); copyText(part.text || ''); });
      bar.appendChild(btn);
      wrap.appendChild(bar);
    } else {
      node.textContent = part.text || '';
    }
    wrap.appendChild(node);
    row.appendChild(wrap);
    return row;
  }

  function buildThinkingCard(part) {
    const card = document.createElement('article');
    card.className = 'thinking-card' + (part.collapsed ? ' collapsed' : '') + (part.streaming ? ' streaming' : '');
    card.dataset.partId = part.id;
    const header = document.createElement('header');
    const label = document.createElement('span');
    const chars = String(part.text || '').length;
    label.textContent = part.streaming ? 'Thinking…' : ('Thought' + (chars ? ' · ' + chars + ' chars' : ''));
    const toggle = document.createElement('span');
    toggle.innerHTML = iconSvg('chevronDown');
    header.append(label, toggle);
    header.addEventListener('click', () => toggleCollapsed(part));
    const body = document.createElement('div');
    body.className = 'thinking-body';
    body.textContent = part.text || '';
    card.append(header, body);
    return card;
  }

  function inputRecord(input) {
    if (!input || typeof input !== 'object') return {};
    return input;
  }

  function appendApprovalFooter(card, part) {
    if (part.state !== 'awaiting-approval' || !part.permissionId) return;
    const footer = document.createElement('div');
    footer.className = 'tool-approval-footer';
    const mk = (label, decision, primary) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      if (primary) btn.className = 'primary';
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (typeof TR.onPermissionDecision === 'function') TR.onPermissionDecision(part.permissionId, decision);
        part.state = 'running';
        part.permissionId = undefined;
        renderPart(part);
      });
      return btn;
    };
    footer.append(
      mk('Allow', 'allow', true),
      mk('Always', 'always', false),
      mk('Always (user)', 'always-user', false),
      mk('Deny', 'deny', false),
    );
    card.appendChild(footer);
  }

  function appendQuestionFooter(card, part) {
    if (part.state !== 'awaiting-answer' || !part.permissionId) return;
    const input = inputRecord(part.input);
    const questions = Array.isArray(input.questions) ? input.questions : [];
    const wrap = document.createElement('div');
    wrap.className = 'tool-question';
    const answers = {};
    const otherInputs = {};

    questions.forEach((q, qi) => {
      const block = document.createElement('div');
      block.className = 'tool-question-block';
      const header = document.createElement('div');
      header.className = 'tool-question-header';
      header.textContent = q.header || ('Q' + (qi + 1));
      const text = document.createElement('p');
      text.className = 'tool-question-text';
      text.textContent = q.question || '';
      const opts = document.createElement('div');
      opts.className = 'tool-question-options';
      const multi = !!q.multiSelect;
      const selected = new Set();
      const key = String(q.header || q.question || qi);
      (q.options || []).forEach((opt) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tool-question-option';
        const strong = document.createElement('strong');
        strong.textContent = opt.label || '';
        const small = document.createElement('small');
        small.textContent = opt.description || '';
        btn.append(strong, small);
        if (opt.preview) {
          const prev = document.createElement('small');
          prev.textContent = String(opt.preview).slice(0, 120);
          btn.appendChild(prev);
        }
        btn.addEventListener('click', () => {
          if (multi) {
            if (selected.has(opt.label)) selected.delete(opt.label);
            else selected.add(opt.label);
          } else {
            selected.clear();
            selected.add(opt.label);
            opts.querySelectorAll('.tool-question-option').forEach((el) => el.classList.remove('selected'));
          }
          btn.classList.toggle('selected', selected.has(opt.label));
          answers[key] = [...selected].join(', ');
        });
        opts.appendChild(btn);
      });
      const other = document.createElement('input');
      other.className = 'tool-question-other';
      other.placeholder = 'Other…';
      other.addEventListener('input', () => {
        otherInputs[key] = other.value;
        if (other.value.trim()) answers[key] = other.value.trim();
      });
      block.append(header, text, opts, other);
      wrap.appendChild(block);
    });

    const footer = document.createElement('div');
    footer.className = 'tool-question-footer';
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'q-submit';
    submit.textContent = 'Submit';
    submit.addEventListener('click', (ev) => {
      ev.stopPropagation();
      for (const [k, v] of Object.entries(otherInputs)) {
        if (String(v || '').trim()) answers[k] = String(v).trim();
      }
      if (typeof TR.onAskUserSubmit === 'function') TR.onAskUserSubmit(part.permissionId, answers, part.input);
      else if (typeof TR.onPermissionDecision === 'function') TR.onPermissionDecision(part.permissionId, 'allow', answers);
      part.state = 'success';
      part.permissionId = undefined;
      part.collapsed = true;
      renderPart(part);
    });
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'q-skip';
    skip.textContent = 'Skip';
    skip.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (typeof TR.onPermissionDecision === 'function') TR.onPermissionDecision(part.permissionId, 'deny');
      part.state = 'error';
      part.permissionId = undefined;
      renderPart(part);
    });
    footer.append(submit, skip);
    card.append(wrap, footer);
  }

  function fillToolBody(body, part) {
    body.textContent = '';
    const family = classifyToolFamily(part.toolName);
    const input = inputRecord(part.input);
    const output = String(part.outputText || '');

    if (family === 'bash') {
      const term = document.createElement('div');
      term.className = 'tool-bash-body';
      const cmd = document.createElement('div');
      cmd.className = 'tool-bash-cmd';
      cmd.textContent = String(input.command || part.hint || '');
      term.appendChild(cmd);
      const full = output;
      const truncated = full.length > 4000;
      const pre = document.createElement('div');
      pre.textContent = truncated ? full.slice(0, 4000) + '\\n…' : full;
      term.appendChild(pre);
      body.appendChild(term);
      if (truncated) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'tool-show-more';
        more.textContent = 'Show more';
        more.addEventListener('click', (ev) => {
          ev.stopPropagation();
          pre.textContent = full;
          more.remove();
        });
        body.appendChild(more);
      }
      return;
    }

    if (family === 'edit') {
      const path = String(input.file_path || input.filePath || input.path || '');
      if (path) {
        const chip = document.createElement('div');
        chip.className = 'tool-path-chip';
        chip.textContent = path;
        body.appendChild(chip);
      }
      let diffText = output;
      if (!diffText && (input.old_string || input.new_string || input.content)) {
        const oldS = String(input.old_string || '');
        const newS = String(input.new_string || input.content || '');
        diffText = oldS.split('\\n').map((l) => '-' + l).join('\\n') + '\\n' + newS.split('\\n').map((l) => '+' + l).join('\\n');
      }
      if (diffText) {
        const box = document.createElement('div');
        box.className = 'tool-diff';
        const rows = parseDiffLines(diffText).slice(0, 200);
        for (const row of rows) {
          const line = document.createElement('div');
          line.className = 'tool-diff-line ' + row.type;
          const prefix = document.createElement('span');
          prefix.className = 'tool-diff-prefix';
          prefix.textContent = row.type === 'add' ? '+' : row.type === 'del' ? '-' : row.type === 'meta' ? '' : ' ';
          const text = document.createElement('span');
          text.textContent = row.text;
          line.append(prefix, text);
          box.appendChild(line);
        }
        body.appendChild(box);
        const stats = parseDiffStats(diffText);
        if (stats.added || stats.removed) {
          const strip = document.createElement('div');
          strip.className = 'msg-change-strip';
          if (stats.added) { const s = document.createElement('span'); s.className = 'add'; s.textContent = '+' + stats.added; strip.appendChild(s); }
          if (stats.removed) { const s = document.createElement('span'); s.className = 'del'; s.textContent = '-' + stats.removed; strip.appendChild(s); }
          body.appendChild(strip);
        }
      } else if (output) {
        const pre = document.createElement('pre');
        pre.textContent = output.length > 1400 ? output.slice(0, 1400) + '\\n...' : output;
        body.appendChild(pre);
      }
      return;
    }

    if (family === 'todo') {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      const ul = document.createElement('ul');
      ul.className = 'tool-todo-list';
      for (const todo of todos) {
        const li = document.createElement('li');
        const status = String(todo.status || 'pending');
        li.className = 'tool-todo-item ' + status;
        const mark = document.createElement('span');
        mark.className = 'tool-todo-mark';
        mark.textContent = status === 'completed' ? '✓' : status === 'in_progress' ? '•' : '';
        const label = document.createElement('span');
        label.textContent = todo.activeForm || todo.content || '';
        li.append(mark, label);
        ul.appendChild(li);
      }
      body.appendChild(ul);
      return;
    }

    if (family === 'web' || family === 'search' || family === 'read') {
      const pre = document.createElement('pre');
      const text = output || summarizeToolInput(part.input);
      pre.textContent = text.length > 1400 ? text.slice(0, 1400) + '\\n...' : text;
      body.appendChild(pre);
      if (family === 'web' && output) {
        try {
          const parsed = JSON.parse(output);
          const results = parsed.results || parsed;
          if (Array.isArray(results) && results.length) {
            body.textContent = '';
            const ul = document.createElement('ul');
            ul.className = 'tool-result-list';
            for (const item of results.slice(0, 8)) {
              const li = document.createElement('li');
              li.className = 'tool-result-item';
              const strong = document.createElement('strong');
              strong.textContent = item.title || item.url || 'Result';
              li.appendChild(strong);
              if (item.url) {
                const a = document.createElement('a');
                a.href = item.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
                a.textContent = item.url;
                li.appendChild(a);
              }
              if (item.content || item.snippet) {
                const small = document.createElement('small');
                small.textContent = String(item.content || item.snippet).slice(0, 180);
                li.appendChild(small);
              }
              ul.appendChild(li);
            }
            body.appendChild(ul);
          }
        } catch { /* keep pre */ }
      }
      return;
    }

    if (family === 'task') {
      const pre = document.createElement('pre');
      pre.textContent = (output || summarizeToolInput(part.input) || part.hint || '').slice(0, 1400);
      body.appendChild(pre);
      return;
    }

    if (family === 'question' && part.state !== 'awaiting-answer') {
      const pre = document.createElement('pre');
      pre.textContent = output || summarizeToolInput(part.input);
      body.appendChild(pre);
      return;
    }

    const pre = document.createElement('pre');
    const text = output || summarizeToolInput(part.input);
    pre.textContent = text.length > 1400 ? text.slice(0, 1400) + '\\n...' : text;
    if (!text) pre.classList.add('hidden');
    body.appendChild(pre);
  }

  function buildToolCard(part) {
    const family = classifyToolFamily(part.toolName);
    const card = document.createElement('article');
    card.className = 'tool-card ' + part.state + (part.collapsed ? ' collapsed' : '');
    card.dataset.partId = part.id;
    card.dataset.family = family;
    card.dataset.toolId = part.toolUseId;

    const header = document.createElement('header');
    const spinner = document.createElement('span');
    spinner.className = 'tool-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const icon = document.createElement('span');
    icon.className = 'tool-icon';
    icon.innerHTML = iconSvg(toolIconName(family));
    const labels = document.createElement('div');
    labels.className = 'tool-labels';
    const title = document.createElement('strong');
    if (family === 'bash' && inputRecord(part.input).command) {
      title.textContent = 'Bash';
    } else {
      title.textContent = part.toolName || 'Tool';
    }
    const status = document.createElement('small');
    const hintBits = [];
    if (part.state === 'error') hintBits.push('Failed');
    if (part.hint) hintBits.push(part.hint);
    if (part.durationMs) hintBits.push(formatDuration(part.durationMs));
    if (family === 'edit') {
      const stats = parseDiffStats(String(part.outputText || ''));
      if (stats.added || stats.removed) hintBits.push('+' + stats.added + '/-' + stats.removed);
    }
    status.textContent = hintBits.filter(Boolean).join(' · ') || (part.state === 'running' || part.state === 'input-streaming' ? 'Running…' : 'Done');
    labels.append(title, status);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'tool-copy';
    copy.title = 'Copy';
    copy.innerHTML = iconSvg('copy');
    copy.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const input = inputRecord(part.input);
      copyText(input.command || input.file_path || part.outputText || summarizeToolInput(part.input));
    });
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tool-toggle';
    toggle.setAttribute('aria-expanded', part.collapsed ? 'false' : 'true');
    toggle.innerHTML = iconSvg('chevronDown');
    const onToggle = (ev) => {
      if (ev) ev.stopPropagation();
      toggleCollapsed(part);
    };
    toggle.addEventListener('click', onToggle);
    header.addEventListener('click', (ev) => {
      if (ev.target.closest && (ev.target.closest('.tool-toggle') || ev.target.closest('.tool-copy'))) return;
      onToggle(ev);
    });
    header.append(spinner, icon, labels, copy, toggle);

    const body = document.createElement('div');
    body.className = 'tool-body';
    if (!part.collapsed) fillToolBody(body, part);
    card.append(header, body);
    appendApprovalFooter(card, part);
    appendQuestionFooter(card, part);
    return card;
  }

  function renderPart(part) {
    if (!TR.root) return;
    ensureShell();
    let node = TR.nodes.get(part.id);
    const fresh =
      part.kind === 'thinking' ? buildThinkingCard(part)
      : part.kind === 'tool' ? buildToolCard(part)
      : buildMessageRow(part);
    if (node && node.parentElement) {
      node.replaceWith(fresh);
    } else {
      TR.root.appendChild(fresh);
    }
    TR.nodes.set(part.id, fresh);

    // Streaming assistant: keep dataset.raw in sync for markdown scheduler
    if (part.kind === 'assistant' && part.streaming) {
      const msg = fresh.querySelector('.message.assistant');
      if (msg) {
        msg.dataset.raw = part.text || '';
        if (typeof TR.scheduleMarkdownRender === 'function') TR.scheduleMarkdownRender(msg);
      }
    }
  }

  function hydrate(entries) {
    reset();
    if (!TR.root) return;
    const events = [];
    for (const entry of entries || []) {
      if (entry.type === 'user') events.push({ type: 'user', text: entry.text || '' });
      else if (entry.type === 'assistant') events.push({ type: 'assistant', text: entry.text || '' });
      else if (entry.type === 'tool') {
        events.push({
          type: 'tool',
          id: entry.id || ('hist-' + events.length),
          name: entry.name || 'Tool',
          input: entry.input,
          ok: entry.ok !== false,
          text: entry.text || '',
          durationMs: entry.durationMs,
        });
      } else if (entry.type === 'notice' || entry.type === 'error' || entry.type === 'system') {
        events.push({ type: entry.type, message: entry.text || '', text: entry.text || '' });
      }
    }
    // Apply then optionally collapse explore groups visually by re-rendering
    for (const ev of events) applyEvent(ev);
    collapseExploreGroups();
    maybeScroll();
  }

  function collapseExploreGroups() {
    if (!TR.root) return;
    // Post-process consecutive readonly tool cards into a details group
    const children = [...TR.root.children];
    let buffer = [];
    const flush = () => {
      if (buffer.length < 2) { buffer = []; return; }
      const details = document.createElement('details');
      details.className = 'tool-group';
      const summary = document.createElement('summary');
      summary.textContent = 'Explored ' + buffer.length + ' files';
      const body = document.createElement('div');
      body.className = 'tool-group-body';
      buffer[0].el.replaceWith(details);
      details.appendChild(summary);
      details.appendChild(body);
      for (const item of buffer) body.appendChild(item.el);
      buffer = [];
    };
    for (const el of children) {
      const partId = el.dataset.partId;
      const part = TR.parts.find((p) => p.id === partId);
      if (part && part.kind === 'tool' && isReadonlyExploreTool(part.toolName) && part.state !== 'running') {
        buffer.push({ el, part });
      } else {
        flush();
      }
    }
    flush();
  }

  function createController(sharedHooks) {
    // Reuse the singleton store/DOM for the primary transcript; manager gets a lightweight shim.
    return {
      init(opts) {
        TR.root = opts.root;
        TR.autoScrollPref = opts.autoScroll !== false;
        TR.renderMarkdownInto = opts.renderMarkdownInto || sharedHooks.renderMarkdownInto || null;
        TR.scheduleMarkdownRender = opts.scheduleMarkdownRender || sharedHooks.scheduleMarkdownRender || null;
        TR.guiIcon = opts.guiIcon || sharedHooks.guiIcon || null;
        TR.onPermissionDecision = opts.onPermissionDecision || sharedHooks.onPermissionDecision || null;
        TR.onAskUserSubmit = opts.onAskUserSubmit || sharedHooks.onAskUserSubmit || null;
        ensureShell();
      },
      setAutoScroll(value) { TR.autoScrollPref = value !== false; },
      applyEvent,
      reset,
      hydrate,
      getCurrentAssistantNode() {
        if (!TR.currentAssistantId) return null;
        const node = TR.nodes.get(TR.currentAssistantId);
        return node ? node.querySelector('.message.assistant') : null;
      },
      finalizeAssistant() {
        finalizeStreamingText();
        for (const p of TR.parts) {
          if (p.kind === 'assistant' || p.kind === 'thinking') renderPart(p);
        }
      },
      scroll: maybeScroll,
      store: TR,
      classifyToolFamily,
      buildToolCard,
      renderToolEvent(event, targetRoot) {
        // One-shot specialized card for secondary panes (Manager) without hijacking main store.
        const toolUseId = String(event.id || ('mgr-' + Date.now()));
        const part = {
          id: 'ephemeral-' + toolUseId,
          kind: 'tool',
          toolName: String(event.name || 'Tool'),
          toolUseId,
          state: event.ok === false ? 'error' : (event.text != null || event.ok != null ? (event.ok === false ? 'error' : 'success') : 'running'),
          input: event.input,
          outputText: event.text != null ? String(event.text) : undefined,
          ok: event.ok,
          durationMs: event.durationMs,
          hint: toolInputHint(event.input),
          collapsed: event.text != null || event.ok != null,
        };
        const card = buildToolCard(part);
        if (targetRoot) targetRoot.appendChild(card);
        return { part, card };
      },
      updateEphemeralToolCard(card, event) {
        if (!card) return;
        const part = {
          id: card.dataset.partId || 'ephemeral',
          kind: 'tool',
          toolName: String(event.name || card.querySelector('strong')?.textContent || 'Tool'),
          toolUseId: card.dataset.toolId || '',
          state: event.ok === false ? 'error' : 'success',
          input: event.input,
          outputText: String(event.text || ''),
          ok: event.ok !== false,
          durationMs: event.durationMs,
          hint: toolInputHint(event.input),
          collapsed: true,
        };
        const fresh = buildToolCard(part);
        card.replaceWith(fresh);
        return fresh;
      },
    };
  }

  const hooks = {};
  window.__ActoviqTranscript = createController(hooks);
  window.__ActoviqTranscriptCreate = function (opts) {
    // Secondary controllers share card builders but keep independent roots via ephemeral helpers.
    const ctrl = createController(hooks);
    if (opts) ctrl.init(opts);
    return ctrl;
  };
})();
`;
}
