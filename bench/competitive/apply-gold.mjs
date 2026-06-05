import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const workspace = process.cwd();
const solutions = {
  p01: `
const input = await readStdin();
const data = input.trim().split(/\\s+/).map(BigInt);
let at = 0;
const t = Number(data[at++]);
const out = [];
for (let i = 0; i < t; i++) {
  const c = data[at++], a = data[at++], b = data[at++];
  out.push(String(minOps(c, a, b)));
}
console.log(out.join('\\n'));
function gcd(a,b){ while(b!==0n) [a,b]=[b,a%b]; return a<0n?-a:a; }
function egcd(a,b){ if(b===0n) return [a,1n,0n]; const [g,x,y]=egcd(b,a%b); return [g,y,x-(a/b)*y]; }
function modInv(a,m){ const [g,x]=egcd(a,m); return ((x%m)+m)%m; }
function minOps(c,a,b){ if(c===0n)return 0n; if(a===0n&&b===0n)return -1n; if(a===0n)return c%b===0n?c/b:-1n; if(b===0n)return c%a===0n?c/a:-1n; const big=a>=b?a:b, small=a>=b?b:a; if(big===small)return c%big===0n?c/big:-1n; const g=gcd(big,small); if(c%g!==0n)return -1n; const B=big/g,S=small/g,C=c/g; const first=S===1n?0n:(C%S)*modInv(B%S,S)%S; const limit=C/B; if(first>limit)return -1n; const k=first+((limit-first)/S)*S; const rest=(C-B*k)/S; return k+rest; }
async function readStdin(){ return await new Promise(r=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>r(s));}); }
`,
  p02: `
const input = await readStdin();
const nums = input.trim().split(/\\s+/).map(Number);
let at=0,n=nums[at++]; const intervals=[];
for(let i=0;i<n;i++) intervals.push({l:nums[at++],r:nums[at++],w:nums[at++]});
intervals.sort((a,b)=>a.r-b.r||a.l-b.l);
const ends=intervals.map(x=>x.r), dp=Array(n+1).fill(0);
for(let i=1;i<=n;i++){ const cur=intervals[i-1]; const j=upper(ends,cur.l); dp[i]=Math.max(dp[i-1],dp[j]+cur.w); }
console.log(dp[n]);
function upper(a,v){let l=0,h=a.length;while(l<h){const m=(l+h)>>1;if(a[m]<=v)l=m+1;else h=m;}return l;}
async function readStdin(){ return await new Promise(r=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>r(s));}); }
`,
  p03: `
const input = await readStdin();
const nums=input.trim().split(/\\s+/).map(BigInt); let at=0,q=Number(nums[at++]); const out=[];
for(let i=0;i<q;i++){ const d=nums[at++], disc=1n+4n*d, root=sqrt(disc); out.push(root*root===disc&&(root-1n)%2n===0n?String((root-1n)/2n):'-1'); }
console.log(out.join('\\n'));
function sqrt(v){ if(v<2n)return v; let l=1n,h=v; while(l<=h){const m=(l+h)>>1n,s=m*m;if(s===v)return m;if(s<v)l=m+1n;else h=m-1n;} return h; }
async function readStdin(){ return await new Promise(r=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>r(s));}); }
`,
  p04: `
const input=await readStdin(); const nums=input.trim().split(/\\s+/).map(Number); let at=0,n=nums[at++]; const ch=Array.from({length:n+1},()=>[]);
for(let i=2;i<=n;i++) ch[nums[at++]].push(i);
function grundy(u){ const seen=new Set(ch[u].map(grundy)); let g=0; while(seen.has(g)) g++; return g; }
console.log(grundy(1)===0?'Second':'First');
async function readStdin(){ return await new Promise(r=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>r(s));}); }
`,
  p05: `
const input=await readStdin(); const nums=input.trim().split(/\\s+/).map(Number); const n=nums[0], a=nums.slice(1); const vals=[...new Set(a)].sort((x,y)=>x-y); const bit=Array(vals.length+2).fill(0); let inv=0n;
for(let i=0;i<n;i++){ const r=lower(vals,a[i])+1; inv+=BigInt(i-sum(r)); add(r,1); }
console.log(String(inv%998244353n));
function lower(arr,v){let l=0,h=arr.length;while(l<h){const m=(l+h)>>1;if(arr[m]<v)l=m+1;else h=m;}return l;}
function add(i,d){for(;i<bit.length;i+=i&-i)bit[i]+=d;} function sum(i){let s=0;for(;i>0;i-=i&-i)s+=bit[i];return s;}
async function readStdin(){ return await new Promise(r=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>r(s));}); }
`,
  p06: `
const input=await readStdin(); const nums=input.trim().split(/\\s+/).map(Number); let at=0,n=nums[at++],m=nums[at++]; const g=Array.from({length:n+1},()=>[]);
for(let i=0;i<m;i++){const u=nums[at++],v=nums[at++];g[u].push(v);g[v].push(u);}
const seen=Array(n+1).fill(false); let ok=true;
for(let s=1;s<=n;s++)if(!seen[s]){let v=0,d=0,st=[s];seen[s]=true;while(st.length){const u=st.pop();v++;d+=g[u].length;for(const x of g[u])if(!seen[x]){seen[x]=true;st.push(x);}} if(d/2!==v)ok=false;}
console.log(ok?'YES':'NO');
async function readStdin(){ return await new Promise(r=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>r(s));}); }
`,
  p07: `
const input=await readStdin(); const tok=input.trim().split(/\\s+/); let at=0,n=Number(tok[at++]),target=tok[at++]; const p=Array(n+1).fill(0);
for(let i=2;i<=n;i++)p[i]=Number(tok[at++]); const lab=['']; for(let i=1;i<=n;i++)lab.push(tok[at++]); const ch=Array.from({length:n+1},()=>[]);
for(let i=2;i<=n;i++)ch[p[i]].push(i); let ans=0; function dfs(u,s){const ns=s+lab[u]; if(ns.endsWith(target))ans++; for(const v of ch[u])dfs(v,ns);} dfs(1,''); console.log(ans);
async function readStdin(){ return await new Promise(r=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>r(s));}); }
`,
  p08: `
const input=await readStdin(); const [s,ks]=input.trim().split(/\\s+/); const k=Number(ks); let lo=1,hi=s.length,ans=1; while(lo<=hi){const mid=(lo+hi)>>1;if(can(mid)){ans=mid;lo=mid+1;}else hi=mid-1;} console.log(ans);
function can(len){let cnt=0; for(let st=0;st+len<=s.length;){const set=new Set();let ok=true;for(let i=st;i<st+len;i++){if(set.has(s[i])){ok=false;break;}set.add(s[i]);} if(ok){cnt++;st+=len;}else st++;} return cnt>=k;}
async function readStdin(){ return await new Promise(r=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>r(s));}); }
`,
  p09: `
const input=await readStdin(); const nums=input.trim().split(/\\s+/).map(Number); let at=0,n=nums[at++]; const g=Array.from({length:n+1},()=>[]);
for(let i=0;i<n-1;i++){const u=nums[at++],v=nums[at++];g[u].push(v);g[v].push(u);} const val=nums.slice(at,at+n),pos=Array(n); for(let i=0;i<n;i++)pos[val[i]]=i+1;
const parent=Array(n+1).fill(0),seen=Array(n+1).fill(false),q=[pos[0]]; seen[pos[0]]=true; for(let qi=0;qi<q.length;qi++){const u=q[qi];for(const v of g[u])if(!seen[v]){seen[v]=true;parent[v]=u;q.push(v);}}
const out=[]; for(let mex=0;mex<n;mex++){const used=Array(n+1).fill(false);for(let value=0;value<=mex;value++){let u=pos[value];while(u!==0&&!used[u]){used[u]=true;u=parent[u];}}out.push(String(used.filter(Boolean).length));} console.log(out.join(' '));
async function readStdin(){ return await new Promise(r=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>r(s));}); }
`,
  p10: `
const input=await readStdin(); const lines=input.trim().split(/\\r?\\n/); const [n,m,K]=lines[0].split(/\\s+/).map(Number); const grid=lines.slice(1); const MOD=1000000007; const dp=Array.from({length:n},()=>Array.from({length:m},()=>Array.from({length:K+1},()=>[0,0])));
if(grid[0][0]==='#'){console.log(0);process.exit(0);} if(n===1&&m===1){console.log(1);process.exit(0);} if(m>1&&grid[0][1]==='.')dp[0][1][0][0]=1; if(n>1&&grid[1][0]==='.')dp[1][0][0][1]=1;
for(let i=0;i<n;i++)for(let j=0;j<m;j++)if(grid[i][j]!== '#')for(let t=0;t<=K;t++)for(let d=0;d<2;d++){const w=dp[i][j][t][d]; if(!w)continue; for(const [nd,di,dj] of [[0,0,1],[1,1,0]]){const ni=i+di,nj=j+dj,nt=t+(nd===d?0:1); if(ni<n&&nj<m&&nt<=K&&grid[ni][nj]==='.')dp[ni][nj][nt][nd]=(dp[ni][nj][nt][nd]+w)%MOD;}}
let ans=0; for(let t=0;t<=K;t++)ans=(ans+dp[n-1][m-1][t][0]+dp[n-1][m-1][t][1])%MOD; console.log(ans);
async function readStdin(){ return await new Promise(r=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>r(s));}); }
`,
};

for (const [problem, source] of Object.entries(solutions)) {
  const filePath = path.join(workspace, 'solutions', problem, 'solution.mjs');
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, trim(source), 'utf8');
}

function trim(source) {
  return `${source.trim()}\n`;
}
