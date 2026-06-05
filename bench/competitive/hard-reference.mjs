export const hardProblems = ['h01', 'h02', 'h03', 'h04', 'h05', 'h06', 'h07', 'h08', 'h09', 'h10'];

export const hardSolutionSources = {
  h01: `
const input = await readStdin();
const lines = input.trim().split(/\\r?\\n/);
const [n, q] = lines[0].split(/\\s+/).map(Number);
const ops = [];
for (let i = 1; i <= q; i++) {
  const [op, a, b] = lines[i].trim().split(/\\s+/);
  ops.push([op, Number(a), Number(b)]);
}
const seg = Array.from({ length: 4 * Math.max(1, q) }, () => []);
const active = new Map();
function key(u, v) { return u < v ? u + '#' + v : v + '#' + u; }
function addInterval(node, l, r, ql, qr, edge) {
  if (ql >= r || qr <= l) return;
  if (ql <= l && r <= qr) { seg[node].push(edge); return; }
  const m = (l + r) >> 1;
  addInterval(node * 2, l, m, ql, qr, edge);
  addInterval(node * 2 + 1, m, r, ql, qr, edge);
}
for (let i = 0; i < q; i++) {
  const [op, u, v] = ops[i];
  const k = key(u, v);
  if (op === '+') active.set(k, [i, u, v]);
  else if (op === '-') {
    const [start, a, b] = active.get(k);
    active.delete(k);
    addInterval(1, 0, q, start, i, [a, b]);
  }
}
for (const [start, u, v] of active.values()) addInterval(1, 0, q, start, q, [u, v]);
const parent = Array.from({ length: n + 1 }, (_, i) => i);
const size = Array(n + 1).fill(1);
const changes = [];
function find(x) { while (parent[x] !== x) x = parent[x]; return x; }
function unite(a, b) {
  a = find(a); b = find(b);
  if (a === b) { changes.push([0, 0, 0]); return; }
  if (size[a] < size[b]) [a, b] = [b, a];
  changes.push([b, a, size[a]]);
  parent[b] = a; size[a] += size[b];
}
function snapshot() { return changes.length; }
function rollback(mark) {
  while (changes.length > mark) {
    const [b, a, oldSize] = changes.pop();
    if (b === 0) continue;
    parent[b] = b; size[a] = oldSize;
  }
}
const out = [];
function dfs(node, l, r) {
  const mark = snapshot();
  for (const [u, v] of seg[node]) unite(u, v);
  if (r - l === 1) {
    const [op, u, v] = ops[l];
    if (op === '?') out.push(find(u) === find(v) ? 'YES' : 'NO');
  } else {
    const m = (l + r) >> 1;
    dfs(node * 2, l, m);
    dfs(node * 2 + 1, m, r);
  }
  rollback(mark);
}
if (q > 0) dfs(1, 0, q);
console.log(out.join('\\n'));
async function readStdin(){return await new Promise(r=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>r(s));});}
`,
  h02: `
const input = await readStdin();
const nums = input.trim().split(/\\s+/).map(Number);
let at = 0;
const n = nums[at++], q = nums[at++];
const a = [0];
for (let i = 0; i < n; i++) a.push(nums[at++]);
const queries = [];
for (let id = 0; id < q; id++) queries.push({ l: nums[at++], r: nums[at++], id });
queries.sort((x, y) => x.r - y.r);
const bit = Array(n + 2).fill(0), last = new Map(), ans = Array(q);
let ptr = 0;
for (let i = 1; i <= n; i++) {
  if (last.has(a[i])) add(last.get(a[i]), -1);
  add(i, 1);
  last.set(a[i], i);
  while (ptr < q && queries[ptr].r === i) {
    const cur = queries[ptr++];
    ans[cur.id] = sum(cur.r) - sum(cur.l - 1);
  }
}
console.log(ans.join('\\n'));
function add(i,v){for(;i<bit.length;i+=i&-i)bit[i]+=v;}
function sum(i){let s=0;for(;i>0;i-=i&-i)s+=bit[i];return s;}
async function readStdin(){return await new Promise(r=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>r(s));});}
`,
  h03: `
const s = (await readStdin()).trim();
const next = [], link = [], len = [];
next.push(new Map()); link.push(-1); len.push(0);
let last = 0, total = 0n;
const out = [];
for (const ch of s) {
  const cur = next.length;
  next.push(new Map()); len.push(len[last] + 1); link.push(0);
  let p = last;
  while (p !== -1 && !next[p].has(ch)) { next[p].set(ch, cur); p = link[p]; }
  if (p === -1) link[cur] = 0;
  else {
    const q = next[p].get(ch);
    if (len[p] + 1 === len[q]) link[cur] = q;
    else {
      const clone = next.length;
      next.push(new Map(next[q])); len.push(len[p] + 1); link.push(link[q]);
      while (p !== -1 && next[p].get(ch) === q) { next[p].set(ch, clone); p = link[p]; }
      link[q] = link[cur] = clone;
    }
  }
  last = cur;
  total += BigInt(len[cur] - len[link[cur]]);
  out.push(String(total));
}
console.log(out.join(' '));
async function readStdin(){return await new Promise(r=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>r(s));});}
`,
  h04: `
const MOD = 998244353, G = 3;
const nums = (await readStdin()).trim().split(/\\s+/).map(Number);
let at = 0, n = nums[at++], m = nums[at++];
let a = nums.slice(at, at + n); at += n;
let b = nums.slice(at, at + m);
let size = 1; while (size < n + m - 1) size <<= 1;
a = a.concat(Array(size - a.length).fill(0));
b = b.concat(Array(size - b.length).fill(0));
ntt(a, false); ntt(b, false);
for (let i = 0; i < size; i++) a[i] = mul(a[i], b[i]);
ntt(a, true);
console.log(a.slice(0, n + m - 1).join(' '));
function pow(a,e){let r=1;while(e>0){if(e&1)r=mul(r,a);a=mul(a,a);e>>=1;}return r;}
function mul(a,b){return Number((BigInt(a)*BigInt(b))%BigInt(MOD));}
function ntt(a, inv){
  const n=a.length;
  for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j)[a[i],a[j]]=[a[j],a[i]];}
  for(let len=2;len<=n;len<<=1){
    let wlen=pow(G,(MOD-1)/len); if(inv)wlen=pow(wlen,MOD-2);
    for(let i=0;i<n;i+=len){let w=1;for(let j=0;j<len/2;j++){const u=a[i+j],v=mul(a[i+j+len/2],w);a[i+j]=(u+v)%MOD;a[i+j+len/2]=(u-v+MOD)%MOD;w=mul(w,wlen);}}
  }
  if(inv){const ni=pow(n,MOD-2);for(let i=0;i<n;i++)a[i]=mul(a[i],ni);}
}
async function readStdin(){return await new Promise(r=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>r(s));});}
`,
  h05: `
const input = await readStdin();
const lines = input.trim().split(/\\r?\\n/);
const [n, q] = lines[0].split(/\\s+/).map(Number);
const init = [0, ...lines[1].split(/\\s+/).map(Number)];
const g = Array.from({ length: n + 1 }, () => []);
for (let i = 0; i < n - 1; i++) { const [u,v]=lines[2+i].split(/\\s+/).map(Number); g[u].push(v); g[v].push(u); }
const parent=Array(n+1).fill(0), depth=Array(n+1).fill(0), heavy=Array(n+1).fill(0), sz=Array(n+1).fill(0);
function dfs1(u,p){parent[u]=p;sz[u]=1;let best=0;for(const v of g[u])if(v!==p){depth[v]=depth[u]+1;dfs1(v,u);sz[u]+=sz[v];if(sz[v]>best){best=sz[v];heavy[u]=v;}}}
const head=Array(n+1), pos=Array(n+1), order=[0]; let timer=0;
function dfs2(u,h){head[u]=h;pos[u]=++timer;order[timer]=u;if(heavy[u])dfs2(heavy[u],h);for(const v of g[u])if(v!==parent[u]&&v!==heavy[u])dfs2(v,v);}
dfs1(1,0); dfs2(1,1);
const base=Array(n+1); for(let i=1;i<=n;i++)base[pos[i]]=init[i];
const max=Array(4*n+4).fill(0), lazy=Array(4*n+4).fill(0);
function build(o,l,r){if(l===r){max[o]=base[l];return;}const m=(l+r)>>1;build(o*2,l,m);build(o*2+1,m+1,r);max[o]=Math.max(max[o*2],max[o*2+1]);}
function push(o){if(lazy[o]){for(const c of [o*2,o*2+1]){max[c]+=lazy[o];lazy[c]+=lazy[o];}lazy[o]=0;}}
function upd(o,l,r,L,R,x){if(L<=l&&r<=R){max[o]+=x;lazy[o]+=x;return;}push(o);const m=(l+r)>>1;if(L<=m)upd(o*2,l,m,L,R,x);if(R>m)upd(o*2+1,m+1,r,L,R,x);max[o]=Math.max(max[o*2],max[o*2+1]);}
function qry(o,l,r,L,R){if(L<=l&&r<=R)return max[o];push(o);const m=(l+r)>>1;let ans=-Infinity;if(L<=m)ans=Math.max(ans,qry(o*2,l,m,L,R));if(R>m)ans=Math.max(ans,qry(o*2+1,m+1,r,L,R));return ans;}
function pathUpdate(u,v,x){while(head[u]!==head[v]){if(depth[head[u]]<depth[head[v]])[u,v]=[v,u];upd(1,1,n,pos[head[u]],pos[u],x);u=parent[head[u]];}if(depth[u]>depth[v])[u,v]=[v,u];upd(1,1,n,pos[u],pos[v],x);}
function pathQuery(u,v){let ans=-Infinity;while(head[u]!==head[v]){if(depth[head[u]]<depth[head[v]])[u,v]=[v,u];ans=Math.max(ans,qry(1,1,n,pos[head[u]],pos[u]));u=parent[head[u]];}if(depth[u]>depth[v])[u,v]=[v,u];return Math.max(ans,qry(1,1,n,pos[u],pos[v]));}
build(1,1,n);
const out=[]; for(let i=0;i<q;i++){const parts=lines[2+n-1+i].split(/\\s+/);if(parts[0]==='add')pathUpdate(Number(parts[1]),Number(parts[2]),Number(parts[3]));else out.push(String(pathQuery(Number(parts[1]),Number(parts[2]))));}
console.log(out.join('\\n'));
async function readStdin(){return await new Promise(r=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>r(s));});}
`,
  h06: `
const nums=(await readStdin()).trim().split(/\\s+/).map(Number);
let at=0,n=nums[at++]; const a=Array.from({length:n+1},()=>Array(n+1).fill(0));
for(let i=1;i<=n;i++)for(let j=1;j<=n;j++)a[i][j]=nums[at++];
const u=Array(n+1).fill(0),v=Array(n+1).fill(0),p=Array(n+1).fill(0),way=Array(n+1).fill(0);
for(let i=1;i<=n;i++){p[0]=i;let j0=0;const minv=Array(n+1).fill(Infinity),used=Array(n+1).fill(false);do{used[j0]=true;const i0=p[j0];let delta=Infinity,j1=0;for(let j=1;j<=n;j++)if(!used[j]){const cur=a[i0][j]-u[i0]-v[j];if(cur<minv[j]){minv[j]=cur;way[j]=j0;}if(minv[j]<delta){delta=minv[j];j1=j;}}for(let j=0;j<=n;j++)if(used[j]){u[p[j]]+=delta;v[j]-=delta;}else minv[j]-=delta;j0=j1;}while(p[j0]!==0);do{const j1=way[j0];p[j0]=p[j1];j0=j1;}while(j0!==0);}
console.log(String(-v[0]));
async function readStdin(){return await new Promise(r=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>r(s));});}
`,
  h07: `
const nums=(await readStdin()).trim().split(/\\s+/).map(Number);
let at=0,L=nums[at++],R=nums[at++],m=nums[at++]; const adj=Array.from({length:L+1},()=>[]);
for(let i=0;i<m;i++)adj[nums[at++]].push(nums[at++]);
const pairU=Array(L+1).fill(0),pairV=Array(R+1).fill(0),dist=Array(L+1).fill(0);
function bfs(){const q=[];for(let u=1;u<=L;u++){if(pairU[u]===0){dist[u]=0;q.push(u);}else dist[u]=Infinity;}let ok=false;for(let qi=0;qi<q.length;qi++){const u=q[qi];for(const v of adj[u]){const pu=pairV[v];if(pu===0)ok=true;else if(dist[pu]===Infinity){dist[pu]=dist[u]+1;q.push(pu);}}}return ok;}
function dfs(u){for(const v of adj[u]){const pu=pairV[v];if(pu===0||(dist[pu]===dist[u]+1&&dfs(pu))){pairU[u]=v;pairV[v]=u;return true;}}dist[u]=Infinity;return false;}
let ans=0;while(bfs())for(let u=1;u<=L;u++)if(pairU[u]===0&&dfs(u))ans++;
console.log(ans);
async function readStdin(){return await new Promise(r=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>r(s));});}
`,
  h08: `
const input=await readStdin(); const lines=input.trim().split(/\\r?\\n/); const [ns,ms,Ks,p]=lines[0].split(/\\s+/); const n=Number(ns),m=Number(ms),K=BigInt(Ks), MOD=1000000007;
const pi=Array(p.length).fill(0); for(let i=1;i<p.length;i++){let j=pi[i-1];while(j>0&&p[i]!==p[j])j=pi[j-1];if(p[i]===p[j])j++;pi[i]=j;}
function step(st,ch){let j=st;while(j>0&&ch!==p[j])j=pi[j-1];if(ch===p[j])j++;return j;}
const states=n*p.length; let mat=Array.from({length:states},()=>Array(states).fill(0));
for(let i=1;i<=m;i++){const [us,vs,c]=lines[i].split(/\\s+/);const u=Number(us)-1,v=Number(vs)-1;for(let st=0;st<p.length;st++){const ns=step(st,c);if(ns<p.length){const from=u*p.length+st,to=v*p.length+ns;mat[to][from]=(mat[to][from]+1)%MOD;}}}
let vec=Array(states).fill(0); vec[0]=1;
let e=K; while(e>0n){if(e&1n)vec=mulMV(mat,vec);mat=mulMM(mat,mat);e>>=1n;}
let ans=0; for(let st=0;st<p.length;st++)ans=(ans+vec[(n-1)*p.length+st])%MOD; console.log(ans);
function mulMV(A,x){const n=A.length,r=Array(n).fill(0);for(let i=0;i<n;i++){let s=0;for(let j=0;j<n;j++)if(A[i][j]&&x[j])s=(s+A[i][j]*x[j])%MOD;r[i]=s;}return r;}
function mulMM(A,B){const n=A.length,C=Array.from({length:n},()=>Array(n).fill(0));for(let i=0;i<n;i++)for(let k=0;k<n;k++)if(A[i][k])for(let j=0;j<n;j++)if(B[k][j])C[i][j]=(C[i][j]+A[i][k]*B[k][j])%MOD;return C;}
async function readStdin(){return await new Promise(r=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>r(s));});}
`,
  h09: `
const input=await readStdin(); const lines=input.trim().split(/\\r?\\n/); const [n,q]=lines[0].split(/\\s+/).map(Number); const g=Array.from({length:n+1},()=>[]);
for(let i=1;i<n;i++){const [u,v]=lines[i].split(/\\s+/).map(Number);g[u].push(v);g[v].push(u);}
const removed=Array(n+1).fill(false),sub=Array(n+1).fill(0),paths=Array.from({length:n+1},()=>[]);
function calc(u,p){sub[u]=1;for(const v of g[u])if(v!==p&&!removed[v]){calc(v,u);sub[u]+=sub[v];}}
function centroid(u,p,total){for(const v of g[u])if(v!==p&&!removed[v]&&sub[v]>total/2)return centroid(v,u,total);return u;}
function collect(u,p,d,c){paths[u].push([c,d]);for(const v of g[u])if(v!==p&&!removed[v])collect(v,u,d+1,c);}
function decomp(entry){calc(entry,0);const c=centroid(entry,0,sub[entry]);removed[c]=true;collect(c,0,0,c);for(const v of g[c])if(!removed[v])decomp(v);}
decomp(1); const best=Array(n+1).fill(Infinity); function mark(u){for(const [c,d] of paths[u])if(d<best[c])best[c]=d;} function query(u){let ans=Infinity;for(const [c,d] of paths[u])ans=Math.min(ans,best[c]+d);return ans;}
mark(1); const out=[]; for(let i=0;i<q;i++){const [op,us]=lines[n+i].split(/\\s+/);const u=Number(us);if(op==='mark')mark(u);else out.push(String(query(u)));} console.log(out.join('\\n'));
async function readStdin(){return await new Promise(r=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>r(s));});}
`,
  h10: `
const MOD=1000000007n; const nums=(await readStdin()).trim().split(/\\s+/).map(BigInt); let at=0,k=Number(nums[at++]),n=nums[at++]; const c=[]; for(let i=0;i<k;i++)c.push(nums[at++]%MOD); const init=[]; for(let i=0;i<k;i++)init.push(nums[at++]%MOD);
if(n<BigInt(k)){console.log(String(init[Number(n)]));process.exit(0);}
function combine(a,b){const tmp=Array(2*k-1).fill(0n);for(let i=0;i<k;i++)for(let j=0;j<k;j++)tmp[i+j]=(tmp[i+j]+a[i]*b[j])%MOD;for(let i=2*k-2;i>=k;i--){const val=tmp[i];if(val===0n)continue;for(let j=0;j<k;j++)tmp[i-1-j]=(tmp[i-1-j]+val*c[j])%MOD;}return tmp.slice(0,k);}
let pol=Array(k).fill(0n);pol[0]=1n;let e=Array(k).fill(0n);if(k===1)e[0]=c[0];else e[1]=1n;let exp=n;while(exp>0n){if(exp&1n)pol=combine(pol,e);e=combine(e,e);exp>>=1n;}let ans=0n;for(let i=0;i<k;i++)ans=(ans+pol[i]*init[i])%MOD;console.log(String(ans));
async function readStdin(){return await new Promise(r=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>r(s));});}
`,
};

