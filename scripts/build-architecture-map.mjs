/**
 * 从 ARCHITECTURE-MAP.json 生成可交互思维导图 architecture-map.html。
 * 单一数据源：改 JSON 后重跑本脚本即可，图与机器可读数据永不脱节。
 *   node scripts/build-architecture-map.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const dataPath = path.join(root, 'ARCHITECTURE-MAP.json');
const outPath = path.join(root, 'architecture-map.html');

const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

const STAGE_COLOR = {
  s1: ['#E6F1FB', '#185FA5', '#0C447C'],
  s2: ['#E1F5EE', '#0F6E56', '#085041'],
  s3: ['#EEEDFE', '#534AB7', '#3C3489'],
  s4: ['#FAEEDA', '#854F0B', '#633806'],
  s5: ['#FBEAF0', '#993556', '#72243E'],
  s6: ['#EAF3DE', '#3B6D11', '#27500A'],
  s7: ['#FAECE7', '#993C1D', '#712B13'],
  s8: ['#F1EFE8', '#5F5E5A', '#2C2C2A'],
  s9: ['#FAEEDA', '#BA7517', '#633806'],
  s10: ['#E6F1FB', '#378ADD', '#042C53'],
  s11: ['#EAF3DE', '#639922', '#27500A'],
};

const css = `
:root{--bg:#faf9f7;--card:#ffffff;--line:#e3e1da;--tx:#2c2c2a;--tx2:#5f5e5a;--tx3:#8a8880}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--tx);font-family:"Microsoft YaHei","PingFang SC",-apple-system,"Segoe UI",sans-serif;font-size:13px;line-height:1.6}
.wrap{display:flex;height:100vh;overflow:hidden}
.main{flex:1;display:flex;flex-direction:column;min-width:0}
.bar{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--line);background:var(--card);flex-wrap:wrap}
.bar h1{font-size:15px;font-weight:500;margin:0}
.tag{font-size:11px;padding:2px 8px;border-radius:20px;background:#FCEBEB;color:#A32D2D;border:1px solid #F09595}
.spacer{flex:1}
.btn{border:1px solid var(--line);background:#fff;color:var(--tx);border-radius:8px;padding:5px 11px;font-size:12px;cursor:pointer;font-family:inherit}
.btn:hover{border-color:#b4b2a9}
.btn.on{background:#E6F1FB;border-color:#185FA5;color:#0C447C}
.srch{position:relative}
.srch input{border:1px solid var(--line);border-radius:8px;padding:5px 10px;font-size:12px;width:220px;font-family:inherit;background:#fff;color:var(--tx)}
.srch input:focus{outline:none;border-color:#185FA5}
.res{position:absolute;top:32px;left:0;width:320px;max-height:340px;overflow:auto;background:#fff;border:1px solid var(--line);border-radius:10px;z-index:20;display:none;box-shadow:0 4px 14px rgba(0,0,0,.06)}
.res div{padding:6px 10px;cursor:pointer;border-bottom:1px solid #f2f1ec;font-size:12px}
.res div:last-child{border-bottom:none}
.res div:hover{background:#f4f2ec}
.res .s{color:var(--tx3);font-size:11px}
.map{flex:1;min-height:0;display:flex;align-items:stretch;justify-content:center;overflow:auto;padding:12px}
.map svg{display:block;width:100%;height:100%;min-width:560px;min-height:520px}
.wrap.collapsed .side{display:none}
.nd{cursor:pointer}
.nd rect{transition:stroke-width .12s}
.nd:hover rect{stroke-width:2.2}
.nm{font-size:13px;font-weight:500}
.fl{font-size:11px}
.hint{padding:6px 16px;font-size:11px;color:var(--tx3);border-top:1px solid var(--line);background:var(--card)}
.side{width:352px;border-left:1px solid var(--line);background:var(--card);overflow:auto;padding:16px}
.side h2{font-size:14px;font-weight:500;margin:0 0 10px}
.kv{margin-bottom:9px}
.kv .k{font-size:11px;color:var(--tx3);letter-spacing:.3px}
.kv .v{font-size:12.5px;word-break:break-all}
.kv .v.mono{font-family:Consolas,"Courier New",monospace;font-size:12px;color:#0C447C}
.sec{margin-top:16px;padding-top:12px;border-top:1px solid var(--line)}
.sec h3{font-size:12px;font-weight:500;margin:0 0 8px;color:var(--tx2)}
.rel{display:block;width:100%;text-align:left;border:1px solid var(--line);background:#faf9f7;border-radius:8px;padding:6px 9px;margin-bottom:6px;cursor:pointer;font-family:inherit;font-size:12px;color:var(--tx)}
.rel:hover{border-color:#185FA5;background:#E6F1FB}
.rel .lb{display:block;font-size:11px;color:var(--tx3);margin-top:1px}
.empty{font-size:12px;color:var(--tx3)}
.note{margin-top:10px;padding:8px 10px;background:#FCEBEB;border:1px solid #F09595;border-radius:8px;font-size:12px;color:#501313}
.legend{display:flex;flex-wrap:wrap;gap:8px;padding:8px 16px;border-top:1px solid var(--line);background:var(--card)}
.lg{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--tx2)}
.lg i{width:11px;height:11px;border-radius:3px;display:inline-block;border:1px solid}
`;

const appJs = `
var DATA = __DATA__;
var SC = __SC__;
var ROOT = {id:'__root__', name:'agents-to-feishu', role:'飞书 ↔ 10 个 AI runtime 桥接（每条消息端到端闭环）'};
var CX = 380, CY = 372;
var view = {center:'__root__'};
var sel = null;
var showFlow = false;
var diag = null;

function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function byId(id){ if(id==='__root__') return ROOT;
  for(var i=0;i<DATA.stages.length;i++){ if(DATA.stages[i].id===id){ var s=DATA.stages[i]; return {id:s.id,name:s.name,role:s.desc,stage:s.id,kind:'stage',file:'-',lines:'-',dir:'-',desc:s.desc}; } }
  for(var j=0;j<DATA.nodes.length;j++){ if(DATA.nodes[j].id===id) return DATA.nodes[j]; }
  return null; }
function stageName(id){ for(var i=0;i<DATA.stages.length;i++){ if(DATA.stages[i].id===id) return DATA.stages[i].name; } return '-'; }
function flowIdx(id){ return DATA.flow.indexOf(id); }
function up(id){ var r=[]; for(var i=0;i<DATA.edges.length;i++){ if(DATA.edges[i].to===id) r.push(DATA.edges[i]); } return r; }
function down(id){ var r=[]; for(var i=0;i<DATA.edges.length;i++){ if(DATA.edges[i].from===id) r.push(DATA.edges[i]); } return r; }
function kids(centerId){
  if(centerId==='__root__'){
    var a=[]; for(var i=0;i<DATA.stages.length;i++){ var s=DATA.stages[i];
      a.push({id:s.id,name:s.name,role:s.desc,stage:s.id,kind:'stage',file:'-',lines:'-',dir:'-',desc:s.desc}); }
    return a;
  }
  var b=[]; for(var j=0;j<DATA.nodes.length;j++){ if(DATA.nodes[j].stage===centerId) b.push(DATA.nodes[j]); } return b;
}
function shortFile(n){
  if(!n.file||n.file==='-') return '';
  var f=n.file.split('/').pop();
  if(n.lines&&n.lines!=='-') f += ':'+n.lines.split(' ')[0];
  return f;
}
function wOf(n){
  var sub=shortFile(n);
  var a=n.name.length*13+26, b=sub.length*7+26;
  return Math.min(210, Math.max(104, Math.max(a,b)));
}
function color(n){
  if(n.id==='__root__') return ['#ffffff','#2c2c2a','#2c2c2a'];
  var c=SC[n.stage]; return c||['#F1EFE8','#5F5E5A','#2C2C2A'];
}
function pos(items){
  var n=items.length, out=[];
  if(n===0) return out;
  if(n===1){ out.push({x:CX+170,y:CY}); return out; }
  var R = n<=4 ? 168 : (n<=6 ? 196 : 226);
  var start = -90;
  for(var i=0;i<n;i++){
    var ang=(start + i*(360/n)) * Math.PI/180;
    out.push({x:CX + R*Math.cos(ang), y:CY + R*Math.sin(ang)});
  }
  return out;
}
function render(){
  var items=kids(view.center);
  var ps=pos(items);
  var svg='';
  svg+='<defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">';
  svg+='<path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>';

  if(view.center==='__root__'){
    var fp=[]; var stagePos={};
    for(var i=0;i<items.length;i++){ stagePos[items[i].id]=ps[i]; }
    for(var k=0;k<DATA.stages.length;k++){ var sid=DATA.stages[k].id; if(sid!=='s9'&&stagePos[sid]) fp.push(stagePos[sid]); }
    if(fp.length>2){
      var d='M'+fp[0].x+' '+fp[0].y;
      for(var m=1;m<fp.length;m++){ d+='L'+fp[m].x+' '+fp[m].y; }
      d+='Z';
      svg+='<path d="'+d+'" fill="none" stroke="'+(showFlow?'#A32D2D':'#c8c6bd')+'" stroke-width="'+(showFlow?2:1.2)+'" stroke-dasharray="6 5" opacity="'+(showFlow?0.9:0.75)+'"/>';
    }
  }

  for(var q=0;q<items.length;q++){
    var p=ps[q];
    svg+='<line x1="'+CX+'" y1="'+CY+'" x2="'+p.x+'" y2="'+p.y+'" stroke="#c8c6bd" stroke-width="1"/>';
  }

  var cn=byId(view.center); var cw=Math.min(230, Math.max(120, cn.name.length*14+30));
  svg+='<g class="nd" data-id="'+view.center+'">';
  svg+='<rect x="'+(CX-cw/2)+'" y="'+(CY-27)+'" width="'+cw+'" height="54" rx="12" fill="#2c2c2a" stroke="#2c2c2a" stroke-width="1"/>';
  svg+='<text class="nm" x="'+CX+'" y="'+(CY-6)+'" text-anchor="middle" dominant-baseline="central" fill="#ffffff">'+esc(cn.name)+'</text>';
  svg+='<text class="fl" x="'+CX+'" y="'+(CY+13)+'" text-anchor="middle" dominant-baseline="central" fill="#c8c6bd">'+(view.center==='__root__'?'点击分支下钻':esc(stageName(view.center)))+'</text>';
  svg+='</g>';

  var hl = [];
  if(diag && diag.nodes){
    for(var hi=0;hi<diag.nodes.length;hi++){
      var hn=byId(diag.nodes[hi]);
      if(hn){ if(hl.indexOf(hn.id)<0) hl.push(hn.id); if(hn.stage && hl.indexOf(hn.stage)<0) hl.push(hn.stage); }
    }
  }
  for(var r=0;r<items.length;r++){
    var n=items[r], pp=ps[r], w=wOf(n), h=shortFile(n)?48:40, col=color(n);
    var inFlow = DATA.flow.indexOf(n.id)>=0;
    var isSel = (sel===n.id);
    var inHl = hl.indexOf(n.id)>=0;
    var sw = isSel?2.6:( inHl?2.4:( (showFlow&&inFlow)?2:1));
    var st = isSel?'#A32D2D':( inHl?'#A32D2D':( (showFlow&&inFlow)?'#A32D2D':col[1] ));
    svg+='<g class="nd" data-id="'+n.id+'">';
    svg+='<rect x="'+(pp.x-w/2)+'" y="'+(pp.y-h/2)+'" width="'+w+'" height="'+h+'" rx="10" fill="'+col[0]+'" stroke="'+st+'" stroke-width="'+sw+'"/>';
    if(shortFile(n)){
      svg+='<text class="nm" x="'+pp.x+'" y="'+(pp.y-8)+'" text-anchor="middle" dominant-baseline="central" fill="'+col[2]+'">'+esc(n.name)+'</text>';
      svg+='<text class="fl" x="'+pp.x+'" y="'+(pp.y+11)+'" text-anchor="middle" dominant-baseline="central" fill="#77756e">'+esc(shortFile(n))+'</text>';
    } else {
      svg+='<text class="nm" x="'+pp.x+'" y="'+pp.y+'" text-anchor="middle" dominant-baseline="central" fill="'+col[2]+'">'+esc(n.name)+'</text>';
    }
    svg+='</g>';
  }
  document.getElementById('map').innerHTML='<svg width="100%" height="100%" viewBox="0 0 760 748" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">'+svg+'</svg>';
  var st=document.getElementById('stat');
  if(st) st.textContent='当前层 '+items.length+' 项 · 全图 '+DATA.nodes.length+' 节点 / '+DATA.edges.length+' 边 · 闭环 '+(DATA.flow.length-1)+' 步';
  var gs=document.querySelectorAll('#map .nd');
  for(var z=0;z<gs.length;z++){ gs[z].addEventListener('click', onNodeClick); }
  document.getElementById('back').style.display = (view.center==='__root__')?'none':'inline-block';
  renderPanel();
}
function onNodeClick(e){
  var id=this.getAttribute('data-id');
  if(id==='__root__') return;
  var n=byId(id);
  diag=null;
  if(view.center==='__root__' && n.kind==='stage'){ view.center=id; sel=null; render(); return; }
  if(view.center==='__root__'){ navigate(id); return; }
  sel=id; render();
}
function navigate(id){
  var n=byId(id); if(!n) return;
  diag=null;
  if(n.kind==='stage'){ view.center=id; sel=null; }
  else { view.center=n.stage||'__root__'; sel=id; }
  render();
  var it=document.getElementById('side'); if(it) it.scrollTop=0;
}
function byDiag(id){ if(!DATA.diagnostics) return null; for(var i=0;i<DATA.diagnostics.length;i++){ if(DATA.diagnostics[i].id===id) return DATA.diagnostics[i]; } return null; }
function openDiag(){
  var box=document.getElementById('dres');
  if(!DATA.diagnostics||!DATA.diagnostics.length){ box.innerHTML='<div class="empty">无症状索引</div>'; box.style.display='block'; return; }
  if(box.style.display==='block'){ box.style.display='none'; return; }
  var h='';
  for(var i=0;i<DATA.diagnostics.length;i++){
    var d=DATA.diagnostics[i];
    h+='<div data-dg="'+d.id+'"><b>'+esc(d.symptom)+'</b><div class="s">'+d.nodes.length+' 个相关节点</div></div>';
  }
  box.innerHTML=h; box.style.display='block';
  var ds=box.querySelectorAll('[data-dg]');
  for(var z=0;z<ds.length;z++){ ds[z].addEventListener('click', function(){ diag=byDiag(this.getAttribute('data-dg')); sel=null; box.style.display='none'; render(); var it2=document.getElementById('side'); if(it2) it2.scrollTop=0; }); }
}
function relHtml(list, kind){
  if(!list.length) return '<div class="empty">'+(kind==='up'?'无上游（流程起点）':'无下游（流程终点）')+'</div>';
  var h='';
  for(var i=0;i<list.length;i++){
    var e=list[i];
    var other = kind==='up'? e.from : e.to;
    var m=byId(other); if(!m) continue;
    h+='<button class="rel" data-go="'+other+'">'+esc(m.name)+'<span class="lb">'+esc(e.label||e.type)+'</span></button>';
  }
  return h||'<div class="empty">无</div>';
}
function renderPanel(){
  var el=document.getElementById('side');
  if(diag && !sel){
    var dh='<h2>问题定位</h2>';
    dh+='<div class="kv"><div class="k">症状</div><div class="v">'+esc(diag.symptom)+'</div></div>';
    dh+='<div class="kv"><div class="k">怎么查</div><div class="v">'+esc(diag.check)+'</div></div>';
    dh+='<div class="sec"><h3>相关节点（点击跳转 · '+diag.nodes.length+'）</h3>';
    for(var di=0;di<diag.nodes.length;di++){ var dm=byId(diag.nodes[di]); if(dm) dh+='<button class="rel" data-go="'+dm.id+'">'+esc(dm.name)+'<span class="lb">'+esc(dm.file||'-')+'</span></button>'; }
    dh+='</div><button class="btn" id="closediag" style="margin-top:10px">清除高亮</button>';
    el.innerHTML=dh; bind();
    var cb=document.getElementById('closediag'); if(cb) cb.addEventListener('click', function(){ diag=null; render(); });
    return;
  }
  if(!sel){ 
    var c=byId(view.center);
    el.innerHTML='<h2>'+esc(c.name)+'</h2>'
      +'<div class="kv"><div class="k">说明</div><div class="v">'+esc(c.role||c.desc||'-')+'</div></div>'
      +'<div class="sec"><h3>本层包含</h3>'+relHtml2(kids(view.center))+'</div>';
    bind(); return;
  }
  var n=byId(sel); if(!n){ el.innerHTML='<h2>未选择</h2>'; return; }
  var fi=flowIdx(n.id);
  var h='<h2>'+esc(n.name)+'</h2>';
  h+='<div class="kv"><div class="k">职责</div><div class="v">'+esc(n.role||'-')+'</div></div>';
  h+='<div class="kv"><div class="k">目录</div><div class="v mono">'+esc(n.dir||'-')+'</div></div>';
  h+='<div class="kv"><div class="k">文件</div><div class="v mono">'+esc(n.file||'-')+'</div></div>';
  h+='<div class="kv"><div class="k">行号</div><div class="v mono">'+esc(n.lines||'-')+'</div></div>';
  h+='<div class="kv"><div class="k">阶段</div><div class="v">'+esc(stageName(n.stage))+'（'+esc(n.stage)+'） · 类型 '+esc(n.kind||'-')+'</div></div>';
  if(fi>=0) h+='<div class="kv"><div class="k">闭环主流程</div><div class="v">第 '+(fi+1)+' / '+(DATA.flow.length-1)+' 步</div></div>';
  if(n.notes) h+='<div class="note">'+esc(n.notes)+'</div>';
  h+='<div class="sec"><h3>上游（谁调用/触发它 · '+up(n.id).length+'）</h3>'+relHtml(up(n.id),'up')+'</div>';
  h+='<div class="sec"><h3>下游（它调用/触发谁 · '+down(n.id).length+'）</h3>'+relHtml(down(n.id),'down')+'</div>';
  el.innerHTML=h;
  bind();
}
function relHtml2(items){
  if(!items.length) return '<div class="empty">无</div>';
  var h='';
  for(var i=0;i<items.length;i++){
    h+='<button class="rel" data-go="'+items[i].id+'">'+esc(items[i].name)+'<span class="lb">'+esc(items[i].kind||'stage')+'</span></button>';
  }
  return h;
}
function bind(){
  var bs=document.querySelectorAll('#side [data-go]');
  for(var i=0;i<bs.length;i++){ bs[i].addEventListener('click', function(){ navigate(this.getAttribute('data-go')); }); }
}
function doSearch(){
  var q=document.getElementById('q').value.trim().toLowerCase();
  var box=document.getElementById('res');
  if(!q){ box.style.display='none'; return; }
  var hits=[];
  for(var i=0;i<DATA.nodes.length;i++){
    var n=DATA.nodes[i];
    var hay=(n.name+' '+(n.role||'')+' '+(n.file||'')+' '+(n.notes||'')).toLowerCase();
    if(hay.indexOf(q)>=0) hits.push(n);
  }
  for(var j=0;j<DATA.stages.length;j++){
    var s=DATA.stages[j];
    if((s.name+' '+s.desc).toLowerCase().indexOf(q)>=0) hits.push({id:s.id,name:s.name,kind:'stage',role:s.desc,stage:s.id});
  }
  if(!hits.length){ box.innerHTML='<div class="empty">无匹配</div>'; box.style.display='block'; return; }
  var h='';
  for(var k=0;k<Math.min(hits.length,40);k++){
    h+='<div data-go="'+hits[k].id+'"><b>'+esc(hits[k].name)+'</b><div class="s">'+esc(stageName(hits[k].stage))+' · '+esc(hits[k].file||'-')+'</div></div>';
  }
  box.innerHTML=h; box.style.display='block';
  var ds=box.querySelectorAll('[data-go]');
  for(var z=0;z<ds.length;z++){ ds[z].addEventListener('click', function(){ navigate(this.getAttribute('data-go')); box.style.display='none'; document.getElementById('q').value=''; }); }
}
window.addEventListener('DOMContentLoaded', function(){
  render();
  document.getElementById('q').addEventListener('input', doSearch);
  document.getElementById('diag').addEventListener('click', openDiag);
  document.getElementById('back').addEventListener('click', function(){ view.center='__root__'; sel=null; render(); });
  document.getElementById('toggle').addEventListener('click', function(){ var w=document.querySelector('.wrap'); var c=w.classList.toggle('collapsed'); this.textContent=c?'展开侧边栏':'收起侧边栏'; });
  document.getElementById('flow').addEventListener('click', function(){
    showFlow=!showFlow; this.className = showFlow? 'btn on':'btn'; render();
  });
  document.addEventListener('keydown', function(e){ if(e.key==='Escape'){ view.center='__root__'; sel=null; render(); } });
});
`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>agents-to-feishu · 架构思维导图（正式版 v1.0.0）</title>
<style>${css}</style>
</head>
<body>
<div class="wrap">
  <div class="main">
    <div class="bar">
      <h1>agents-to-feishu 架构思维导图</h1>
      <span class="tag" style="background:#EAF3DE;color:#3B6D11;border-color:#97C459">正式版 v1.0.0 · 2026-08-29 · 已经独立审核</span>
      <span id="stat" style="font-size:11px;color:#8a8880"></span>
      <span class="spacer"></span>
      <div class="srch">
        <input id="q" placeholder="搜功能/文件/节点，如 resetSession、engine.ts">
        <div class="res" id="res"></div>
      </div>
      <div class="srch">
        <button class="btn" id="diag">问题定位</button>
        <div class="res" id="dres" style="width:460px"></div>
      </div>
      <button class="btn" id="flow">高亮闭合主流程</button>
      <button class="btn" id="back" style="display:none">返回全局</button>
      <button class="btn" id="toggle">收起侧边栏</button>
    </div>
    <div class="map" id="map"></div>
    <div class="legend" id="legend"></div>
    <div class="hint">中心为当前层：点击分支下钻，点击节点看「目录 / 文件 / 行号 / 上游 / 下游」，上下游按钮可直接跳转；<b>「问题定位」</b>按症状索引快速找到该看哪段代码。Esc 返回全局。</div>
  </div>
  <div class="side" id="side"></div>
</div>
<script>
${appJs.replace('__DATA__', JSON.stringify(data)).replace('__SC__', JSON.stringify(STAGE_COLOR))}
</script>
<script>
(function(){
  var SC=${JSON.stringify(STAGE_COLOR)};
  var h='';
  var DATA=${JSON.stringify(data)};
  for(var i=0;i<DATA.stages.length;i++){
    var s=DATA.stages[i], c=SC[s.id];
    h+='<span class="lg"><i style="background:'+c[0]+';border-color:'+c[1]+'"></i>'+s.order+' '+s.name+'</span>';
  }
  document.getElementById('legend').innerHTML=h;
})();
</script>
</body>
</html>
`;

fs.writeFileSync(outPath, html, 'utf8');
console.log('generated: ' + outPath);
console.log('nodes=' + data.nodes.length + ' edges=' + data.edges.length + ' stages=' + data.stages.length);
