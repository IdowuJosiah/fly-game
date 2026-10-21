const WebSocket=require('ws');
const URL=process.env.URL||'ws://localhost:3100/ws';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function client(name){
  const c={name,msgs:[],snaps:0,first:0,last:0,events:{},ended:null,room:null,opp:[],errors:[],restarts:0,bytes:0,maxBytes:0};
  c.ws=new WebSocket(URL);
  c.open=new Promise(r=>c.ws.on('open',r));
  c.ws.on('message',d=>{
    const raw=d.toString(); const m=JSON.parse(raw);
    if(m.t==='snap'){ c.snaps++; const n=Date.now(); if(!c.first)c.first=n; c.last=n; c.bytes+=raw.length; c.maxBytes=Math.max(c.maxBytes,raw.length); c.lastSnap=m; for(const e of m.ev) c.events[e.type]=(c.events[e.type]||0)+1; }
    else if(m.t==='room') c.room=m;
    else if(m.t==='end') c.ended=m;
    else if(m.t==='opp') c.opp.push(m.status);
    else if(m.t==='error') c.errors.push(m.msg);
    else if(m.t==='restart'){ c.restarts++; c.ended=null; c.snaps=0; c.first=0; }
  });
  c.send=o=>c.ws.send(JSON.stringify(o));
  return c;
}
function wander(c,until){ // fake paddle input following the ball nearest to own wall
  return setInterval(()=>{ const s=c.lastSnap; if(!s||c.ws.readyState!==1)return; const team=c.room.team;
    let best=null; for(const b of s.balls){ if(b[5]===team){ best=b; } }
    c.send({t:'input',y: best?best[2]:20}); },33);
}
(async()=>{
  const ok=(label,cond)=>console.log((cond?'PASS':'FAIL'),label);
  const a=client('A'), b=client('B'); await a.open; await b.open;
  // errors
  b.send({t:'join',code:'ZZZZ'}); await sleep(150); ok('unknown code rejected', b.errors[0]==='No room with that code.');
  b.send({t:'input',y:'x'}); b.send({t:'garbage'}); b.ws.send('not json'); await sleep(100);
  a.send({t:'create'}); await sleep(150); ok('room created with code', a.room&&/^[A-Z2-9]{4}$/.test(a.room.code)&&a.room.team===0);
  b.send({t:'join',code:a.room.code.toLowerCase()}); await sleep(300);
  ok('joiner is team 1', b.room&&b.room.team===1);
  const ia=wander(a), ib=wander(b);
  await sleep(2000);
  const rate=a.snaps/((a.last-a.first)/1000);
  console.log('snapshot rate A ~',rate.toFixed(1),'/s, avg bytes',Math.round(a.bytes/a.snaps),'max',a.maxBytes);
  ok('snapshots ~20 Hz', rate>17&&rate<23);
  ok('both players get snapshots', b.snaps>30);
  // wait for the short match (ROUND_TIME=6 + 3s countdown)
  for(let i=0;i<150&&!a.ended;i++) await sleep(100);
  ok('match ends with a result', !!a.ended && !!b.ended && a.ended.winner===b.ended.winner);
  console.log('winner',a.ended&&a.ended.winner,'share',a.ended&&a.ended.share,'len',a.ended&&a.ended.tm,'events seen',JSON.stringify(a.events));
  // rematch
  const before=a.restarts; a.send({t:'rematch'}); await sleep(300);
  ok('opponent told about rematch request', b.opp.includes('rematch'));
  b.send({t:'rematch'}); await sleep(500);
  ok('rematch restarts both', a.restarts===before+1&&b.restarts>=1&&a.snaps>0);
  // disconnect B mid-match, rejoin within grace
  const tokenB=b.room.token, code=a.room.code;
  clearInterval(ib); b.ws.terminate(); await sleep(300);
  ok('A told B is away', a.opp.includes('away'));
  const b2=client('B2'); await b2.open; b2.send({t:'rejoin',code,token:tokenB}); await sleep(400);
  ok('B rejoined same team', b2.room&&b2.room.team===1); ok('A told B is back', a.opp.includes('back'));
  const ib2=wander(b2); await sleep(500); ok('rejoined player gets snapshots', b2.snaps>5);
  // disconnect again and let the grace period lapse => bot takes over
  clearInterval(ib2); b2.ws.terminate(); await sleep(2200);
  ok('bot takes over after grace', a.opp.includes('bot'));
  // bad rejoin token
  const c3=client('C'); await c3.open; c3.send({t:'rejoin',code,token:'nope'}); await sleep(200); ok('bad token refused', c3.errors.length===1);
  clearInterval(ia); a.ws.close(); c3.ws.close(); await sleep(200);
  process.exit(0);
})();
