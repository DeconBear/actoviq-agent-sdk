#!/usr/bin/env node
/**
 * Build a self-contained "benchmark task design" explorer — a single HTML file
 * you open directly in a browser (no server, no deploy). It embeds every task
 * across the three tracks so you can review what each one actually tests:
 *   - Knowledge  (bench/cases/standard/*.json)        — judged prompts
 *   - Execution  (bench/cases/agentic/*.json + fixtures) — tool tasks + verifier
 *   - Reviewer   (bench/fixtures/review/<name>/manifest) — planted bugs + traps
 *
 * Usage:  node bench/build-task-explorer.mjs   →   bench/task-explorer.html
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const MAX_FILE = 24_000; // cap embedded file size

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function listJson(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => ({ file: f, data: readJson(path.join(dir, f)) }))
    .filter((x) => x.data);
}

/** Collect text files under a fixture dir as { path, content }. */
function collectFiles(dir, exclude = new Set()) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (d, rel) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'package-lock.json') continue;
      if (exclude.has(entry.name)) continue;
      const full = path.join(d, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, r);
      else {
        let content = '';
        try {
          content = fs.readFileSync(full, 'utf-8');
          if (content.length > MAX_FILE) content = content.slice(0, MAX_FILE) + '\n… (truncated)';
        } catch { content = '(unreadable)'; }
        out.push({ path: r, content });
      }
    }
  };
  walk(dir, '');
  return out;
}

// ── Knowledge track ──────────────────────────────────────────────────
const knowledge = listJson(path.join(ROOT, 'bench', 'cases', 'standard')).map(({ data }) => ({
  id: data.id, title: data.title, category: data.category,
  prompt: data.prompt ?? '', expectedCoverage: data.expectedCoverage ?? [],
}));

// ── Execution track ──────────────────────────────────────────────────
const execution = listJson(path.join(ROOT, 'bench', 'cases', 'agentic')).map(({ data }) => ({
  id: data.id, title: data.title, category: data.category,
  prompt: data.prompt ?? '', fixture: data.fixture ?? '', verify: data.verify ?? '',
  files: data.fixture ? collectFiles(path.join(ROOT, 'bench', 'fixtures', 'agentic', data.fixture)) : [],
}));

// ── Reviewer track ───────────────────────────────────────────────────
const reviewDir = path.join(ROOT, 'bench', 'fixtures', 'review');
const reviewer = (fs.existsSync(reviewDir) ? fs.readdirSync(reviewDir, { withFileTypes: true }) : [])
  .filter((e) => e.isDirectory())
  .map((e) => e.name).sort()
  .map((name) => {
    const m = readJson(path.join(reviewDir, name, 'review-manifest.json'));
    if (!m) return null;
    return {
      fixture: name, title: m.title ?? name, task: m.task ?? '', context: m.context ?? '',
      bugs: m.bugs ?? [], traps: m.traps ?? [],
      files: collectFiles(path.join(reviewDir, name), new Set(['review-manifest.json'])),
    };
  })
  .filter(Boolean);

// ── Agents + scoring methodology ─────────────────────────────────────
const TRUNC = 2400;
const trunc = (s) => { s = s ?? ''; return s.length > TRUNC ? s.slice(0, TRUNC) + '\n… (truncated)' : s; };

const stdRec = readJson(path.join(ROOT, 'bench', 'results', 'benchmark-record.json'));
const agents = (stdRec?.agents ?? []).map((a) => ({
  label: a.label ?? a.name, model: a.model, hasTeamTool: !!a.hasTeamTool, hasWebSearch: !!a.hasWebSearch,
}));

// ── Results: standard runs (knowledge + execution) ───────────────────
const standardResults = (stdRec?.runs ?? []).map((r) => ({
  task: r.task?.id ?? '?', category: r.task?.category ?? '?', agent: r.agent?.label ?? r.agent?.name ?? '?',
  overall: r.scores?.overall ?? null,
  dims: { factual: r.scores?.factual, breadth: r.scores?.breadth, structure: r.scores?.structure, citation: r.scores?.citation, efficiency: r.scores?.efficiency },
  comment: r.scores?.comment ?? '', judgeFailed: !!r.scores?.judgeFailed,
  verified: r.metrics?.verified,
  metrics: { inputTokens: r.metrics?.inputTokens ?? 0, outputTokens: r.metrics?.outputTokens ?? 0, toolCallCount: r.metrics?.toolCallCount ?? 0, estimatedCost: r.metrics?.estimatedCost ?? 0, durationMs: r.metrics?.durationMs ?? 0 },
  answerPreview: trunc(r.answer),
}));

// ── Results: reviewer runs ───────────────────────────────────────────
const revRec = readJson(path.join(ROOT, 'bench', 'results', 'review-record.json'));
const reviewerResults = (revRec?.runs ?? []).map((r) => ({
  agent: r.agent, fixture: r.fixture, trial: r.trial ?? 1,
  recall: r.recall ?? 0, precision: r.precision ?? 0, falsePositives: r.falsePositives ?? 0,
  found: r.found ?? [], missed: r.missed ?? [], judgeFailed: !!r.judgeFailed,
  comment: r.comment ?? '', durationMs: r.durationMs ?? 0, reportPreview: trunc(r.report),
}));

const DATA = {
  generatedAt: new Date().toISOString(),
  knowledge, execution, reviewer,
  agents,
  standardResults, standardRuns: (stdRec?.runs ?? []).length, standardVersion: stdRec?.version ?? null,
  reviewerResults, reviewGeneratedAt: revRec?.generatedAt ?? null,
};

// Embed safely: escape < so a "</script>" or "<" in any prompt can't break out.
const embedded = JSON.stringify(DATA).replace(/</g, '\\u003c');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Actoviq Benchmark — Task Design</title>
<style>
  :root { --bg:#0e1116; --panel:#161b22; --panel2:#1c2230; --bd:#2a3140; --fg:#e6edf3; --dim:#8b949e;
          --acc:#3fb6a8; --code:#0b0f14; --bug:#f85149; --trap:#d29922; --chip:#21425f; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; }
  header { padding:20px 24px; border-bottom:1px solid var(--bd); position:sticky; top:0; background:var(--bg); z-index:5; }
  h1 { margin:0 0 4px; font-size:20px; }
  .sub { color:var(--dim); font-size:12px; }
  nav { display:flex; gap:8px; margin-top:14px; flex-wrap:wrap; }
  nav button { background:var(--panel); color:var(--fg); border:1px solid var(--bd); padding:7px 14px; border-radius:8px; cursor:pointer; font-size:13px; }
  nav button.active { background:var(--acc); color:#04201c; border-color:var(--acc); font-weight:600; }
  main { padding:20px 24px 80px; max-width:1100px; margin:0 auto; }
  section { display:none; }
  section.active { display:block; }
  .lead { color:var(--dim); margin:0 0 16px; }
  .card { background:var(--panel); border:1px solid var(--bd); border-radius:12px; padding:16px 18px; margin:0 0 16px; }
  .card h3 { margin:0 0 6px; font-size:16px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .id { color:var(--dim); font:12px ui-monospace,SFMono-Regular,Menlo,monospace; }
  .badge { font-size:11px; text-transform:uppercase; letter-spacing:.04em; padding:2px 8px; border-radius:999px; background:var(--chip); color:#bfe0ff; }
  .label { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.05em; margin:14px 0 6px; }
  pre { background:var(--code); border:1px solid var(--bd); border-radius:8px; padding:12px; overflow:auto; margin:0;
        font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; word-break:break-word; }
  .chips { display:flex; gap:6px; flex-wrap:wrap; }
  .chip { background:var(--panel2); border:1px solid var(--bd); border-radius:999px; padding:2px 10px; font-size:12px; color:#cdd9e5; }
  code.inline { background:var(--code); border:1px solid var(--bd); border-radius:6px; padding:2px 6px; font:12.5px ui-monospace,monospace; }
  details { border:1px solid var(--bd); border-radius:8px; margin:6px 0; background:var(--panel2); }
  details > summary { cursor:pointer; padding:8px 12px; font:12.5px ui-monospace,monospace; color:#cdd9e5; }
  details[open] > summary { border-bottom:1px solid var(--bd); }
  details pre { border:none; border-radius:0 0 8px 8px; }
  ul.findings { list-style:none; padding:0; margin:0; }
  ul.findings li { border:1px solid var(--bd); border-left-width:4px; border-radius:6px; padding:8px 12px; margin:6px 0; background:var(--panel2); }
  li.bug { border-left-color:var(--bug); }
  li.trap { border-left-color:var(--trap); }
  .loc { font:12px ui-monospace,monospace; color:var(--acc); }
  .tag { font-size:10px; text-transform:uppercase; letter-spacing:.06em; padding:1px 7px; border-radius:999px; margin-left:8px; }
  .tag.bug { background:rgba(248,81,73,.15); color:var(--bug); }
  .tag.trap { background:rgba(210,153,34,.15); color:var(--trap); }
  .tag.ok { background:rgba(63,182,168,.16); color:var(--acc); }
  .tag.bad { background:rgba(248,81,73,.15); color:var(--bug); }
  .pill { display:inline-block; margin-left:8px; padding:2px 9px; border-radius:999px; background:var(--chip); color:#bfe0ff; font-weight:600; font-size:12px; }
  .pill.warn { background:rgba(210,153,34,.18); color:var(--trap); }
  .count { color:var(--dim); font-weight:400; font-size:13px; }
</style>
</head>
<body>
<header>
  <h1>Actoviq Benchmark — Task Design</h1>
  <div class="sub" id="meta"></div>
  <nav id="nav"></nav>
</header>
<main id="main"></main>
<script>
const DATA = ${embedded};
const $ = (t, props={}, ...kids) => { const e=document.createElement(t); Object.assign(e, props);
  for (const k of kids) e.append(k); return e; };
const txtPre = (s) => $('pre', { textContent: s || '(empty)' });

function badge(cat){ return $('span',{className:'badge',textContent:cat||'?'}); }

function fileBlocks(files){
  const wrap = $('div');
  if(!files || !files.length){ wrap.append($('div',{className:'sub',textContent:'(no files)'})); return wrap; }
  for(const f of files){
    const d = $('details'); d.append($('summary',{textContent:f.path}));
    d.append($('pre',{textContent:f.content})); wrap.append(d);
  }
  return wrap;
}

function knowledgeCard(t){
  const c=$('div',{className:'card'});
  c.append($('h3',{}, badge(t.category), document.createTextNode(t.title+' '), $('span',{className:'id',textContent:t.id})));
  c.append($('div',{className:'label',textContent:'Prompt'})); c.append(txtPre(t.prompt));
  if(t.expectedCoverage && t.expectedCoverage.length){
    c.append($('div',{className:'label',textContent:'Expected coverage'}));
    const chips=$('div',{className:'chips'}); for(const x of t.expectedCoverage) chips.append($('span',{className:'chip',textContent:x}));
    c.append(chips);
  }
  return c;
}

function executionCard(t){
  const c=$('div',{className:'card'});
  c.append($('h3',{}, badge(t.category), document.createTextNode(t.title+' '), $('span',{className:'id',textContent:t.id})));
  c.append($('div',{className:'label',textContent:'Prompt'})); c.append(txtPre(t.prompt));
  const meta=$('div'); meta.style.margin='10px 0';
  meta.append($('span',{className:'label',textContent:'Fixture '})); meta.append($('code',{className:'inline',textContent:t.fixture||'(none)'}));
  meta.append(document.createTextNode('  '));
  meta.append($('span',{className:'label',textContent:'Verify '})); meta.append($('code',{className:'inline',textContent:t.verify||'(none)'}));
  c.append(meta);
  c.append($('div',{className:'label',textContent:'Fixture files'})); c.append(fileBlocks(t.files));
  return c;
}

function findingList(items, kind){
  const ul=$('ul',{className:'findings'});
  for(const b of items){
    const li=$('li',{className:kind});
    const head=$('div',{}); head.append($('span',{className:'loc',textContent:b.location||b.id||''}));
    head.append($('span',{className:'tag '+kind,textContent: kind==='bug'?'bug':'trap — must NOT flag'}));
    li.append(head); li.append($('div',{textContent:b.description||''}));
    ul.append(li);
  }
  return ul;
}

function reviewerCard(t){
  const c=$('div',{className:'card'});
  c.append($('h3',{}, badge('review'), document.createTextNode(t.title+' '), $('span',{className:'id',textContent:t.fixture})));
  c.append($('div',{className:'label',textContent:'Task (shown to the reviewer)'})); c.append(txtPre(t.task));
  c.append($('div',{className:'label',textContent:'Context (injected into the reviewer system prompt)'})); c.append(txtPre(t.context));
  c.append($('div',{className:'label',textContent:'Code under review'})); c.append(fileBlocks(t.files));
  c.append($('div',{className:'label',textContent:'Ground-truth bugs ('+t.bugs.length+') — reviewer SHOULD find these'}));
  c.append(findingList(t.bugs,'bug'));
  if(t.traps && t.traps.length){
    c.append($('div',{className:'label',textContent:'Traps ('+t.traps.length+') — correct code; flagging is a false positive'}));
    c.append(findingList(t.traps,'trap'));
  }
  return c;
}

function buildTaskList(sec, lead, items, render){
  sec.append($('p',{className:'lead',textContent:lead}));
  if(!items.length) sec.append($('div',{className:'sub',textContent:'(no tasks found)'}));
  for(const it of items) sec.append(render(it));
}

function buildOverview(sec){
  sec.append($('p',{className:'lead',textContent:'The benchmark compares agents across three task tracks. Below: the agents, how each track is scored, and the dataset sizes. See the per-track tabs for task design and the Results tab for recorded runs.'}));
  sec.append($('div',{className:'label',textContent:'Agents compared'}));
  if(!DATA.agents.length) sec.append($('div',{className:'sub',textContent:'(no recorded runs yet — run the bench to populate)'}));
  for(const a of DATA.agents){
    const c=$('div',{className:'card'});
    c.append($('h3',{}, document.createTextNode(a.label+' '), $('span',{className:'id',textContent:a.model})));
    const tags=$('div',{className:'chips'});
    tags.append($('span',{className:'chip',textContent:'team tool: '+(a.hasTeamTool?'on':'off')}));
    tags.append($('span',{className:'chip',textContent:'web search: '+(a.hasWebSearch?'on':'off')}));
    c.append(tags); sec.append(c);
  }
  sec.append($('div',{className:'label',textContent:'Scoring methodology'}));
  const md=[
    ['Knowledge','DeepSeek-v4-pro judge, 5 dimensions (1-10): factual, breadth, structure, citation, efficiency. Overall = factual·0.30 + breadth·0.25 + structure·0.20 + citation·0.15 + efficiency·0.10.'],
    ['Execution','Objective verifier — the agent works in an isolated workspace, then a shell command runs; exit 0 = pass. No LLM judge for the outcome.'],
    ['Reviewer','Recall = real bugs found / total. Precision = found / (found + false positives). Fixtures include "trap" code that must NOT be flagged.'],
  ];
  for(const [k,v] of md){ const c=$('div',{className:'card'}); c.append($('h3',{}, badge(k.toLowerCase()), document.createTextNode(' '+k))); c.append($('div',{textContent:v})); sec.append(c); }
}

const f = (n) => (n==null?'—':n);
const num = (n) => (n||0).toLocaleString();
function dimsLine(d){ return 'factual '+f(d.factual)+' · breadth '+f(d.breadth)+' · structure '+f(d.structure)+' · citation '+f(d.citation)+' · efficiency '+f(d.efficiency); }
function scorePill(v, failed){ const s=$('span',{className:'pill',textContent: failed?'judge failed':(v==null?'—':v.toFixed(1))}); if(failed) s.classList.add('warn'); return s; }

function buildStandardResults(sec){
  sec.append($('div',{className:'label',textContent:'Knowledge + Execution — '+DATA.standardResults.length+' runs'}));
  if(!DATA.standardResults.length){ sec.append($('div',{className:'sub',textContent:'No standard results yet. Run: npx tsx bench/standard/run-all.ts'})); return; }
  const byTask={}; for(const r of DATA.standardResults){ (byTask[r.task]=byTask[r.task]||[]).push(r); }
  for(const task of Object.keys(byTask).sort()){
    const runs=byTask[task]; const c=$('div',{className:'card'});
    c.append($('h3',{}, badge(runs[0].category), $('span',{className:'id',textContent:task})));
    for(const r of runs){
      const row=$('details'); const sum=$('summary',{});
      sum.append($('strong',{textContent:r.agent})); sum.append(document.createTextNode(' '));
      if(r.verified!==undefined) sum.append($('span',{className:'tag '+(r.verified?'ok':'bad'),textContent:r.verified?'verified ✓':'verify ✗'}));
      sum.append(scorePill(r.overall, r.judgeFailed));
      sum.append($('span',{className:'sub',textContent:'  '+num(r.metrics.inputTokens+r.metrics.outputTokens)+' tok · '+r.metrics.toolCallCount+' tools · $'+(r.metrics.estimatedCost||0).toFixed(3)}));
      row.append(sum);
      const body=$('div'); body.style.padding='10px 12px';
      body.append($('div',{className:'sub',textContent:'dims: '+dimsLine(r.dims)}));
      if(r.comment) body.append($('div',{style:'margin:6px 0',textContent:'judge: '+r.comment}));
      const d2=$('details'); d2.append($('summary',{textContent:'answer preview'})); d2.append($('pre',{textContent:r.answerPreview||'(empty)'})); body.append(d2);
      row.append(body); c.append(row);
    }
    sec.append(c);
  }
}

function buildReviewerResults(sec){
  sec.append($('div',{className:'label',textContent:'Reviewer — '+DATA.reviewerResults.length+' runs'+(DATA.reviewGeneratedAt?' · '+new Date(DATA.reviewGeneratedAt).toLocaleString():'')}));
  if(!DATA.reviewerResults.length){ sec.append($('div',{className:'sub',textContent:'No reviewer results yet. Run: npx tsx bench/standard/run-review.ts'})); return; }
  for(const r of DATA.reviewerResults){
    const c=$('div',{className:'card'});
    c.append($('h3',{}, $('strong',{textContent:r.agent}), $('span',{className:'id',textContent:r.fixture+' #'+r.trial})));
    if(r.judgeFailed){ c.append($('div',{}, $('span',{className:'tag bad',textContent:'judge failed'}))); }
    else {
      const stats=$('div',{className:'chips'});
      stats.append($('span',{className:'chip',textContent:'recall '+Math.round(r.recall*100)+'%'}));
      stats.append($('span',{className:'chip',textContent:'precision '+Math.round(r.precision*100)+'%'}));
      stats.append($('span',{className:'chip',textContent:'false positives '+r.falsePositives}));
      c.append(stats);
      c.append($('div',{className:'sub',style:'margin-top:6px',textContent:'found: ['+r.found.join(', ')+']   missed: ['+r.missed.join(', ')+']'}));
    }
    if(r.comment) c.append($('div',{style:'margin:6px 0',textContent:'judge: '+r.comment}));
    const d=$('details'); d.append($('summary',{textContent:'reviewer report'})); d.append($('pre',{textContent:r.reportPreview||'(empty)'})); c.append(d);
    sec.append(c);
  }
}

const sections = [
  { key:'overview', label:'Overview', count: DATA.agents.length, build: buildOverview },
  { key:'knowledge', label:'Knowledge', count: DATA.knowledge.length, build:(sec)=>buildTaskList(sec,'Judged prompts — answer quality on a DeepSeek 5-dim rubric. No tools executed.',DATA.knowledge,knowledgeCard) },
  { key:'execution', label:'Execution', count: DATA.execution.length, build:(sec)=>buildTaskList(sec,'Real tool use in an isolated workspace; an objective verifier command decides pass/fail.',DATA.execution,executionCard) },
  { key:'reviewer', label:'Reviewer', count: DATA.reviewer.length, build:(sec)=>buildTaskList(sec,'Read-only bug detection — scored on recall (bugs found) and precision (no false positives).',DATA.reviewer,reviewerCard) },
  { key:'results', label:'Results', count: DATA.standardResults.length + DATA.reviewerResults.length, build:(sec)=>{ buildStandardResults(sec); buildReviewerResults(sec); } },
];

document.getElementById('meta').textContent =
  DATA.knowledge.length+' knowledge · '+DATA.execution.length+' execution · '+DATA.reviewer.length+' reviewer tasks  ·  '+(DATA.standardResults.length+DATA.reviewerResults.length)+' recorded runs  ·  generated '+new Date(DATA.generatedAt).toLocaleString();

const nav=document.getElementById('nav'), main=document.getElementById('main');
sections.forEach((s,i)=>{
  const btn=$('button',{className: i===0?'active':''});
  btn.append(document.createTextNode(s.label+' ')); btn.append($('span',{className:'count',textContent:'('+s.count+')'}));
  btn.onclick=()=>{ document.querySelectorAll('nav button').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('main section').forEach(x=>x.classList.remove('active'));
    btn.classList.add('active'); document.getElementById('sec-'+s.key).classList.add('active'); window.scrollTo(0,0); };
  nav.append(btn);
  const sec=$('section',{id:'sec-'+s.key, className: i===0?'active':''});
  s.build(sec);
  main.append(sec);
});
</script>
</body>
</html>
`;

const outPath = path.join(ROOT, 'bench', 'task-explorer.html');
fs.writeFileSync(outPath, html, 'utf-8');
console.log(`Wrote ${outPath}`);
console.log(`  ${knowledge.length} knowledge · ${execution.length} execution · ${reviewer.length} reviewer tasks`);
console.log(`Open it directly in a browser (no server needed).`);
