const WebSocket=require('ws');
const URL=process.env.URL||'ws://localhost:3100/ws';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function client(name){
  const c={name,msgs:[],snaps:0,first:0,last:0,events:{},ended:null,room:null,opp:[],errors:[],restarts:0,bytes:0,maxBytes:0,waits:[],resumes:0};
  c.ws=new WebSocket(URL);
  c.open=new Promise(r=>c.ws.on('open',r));
  c.ws.on('message',d=>{
    const raw=d.toString(); const m=JSON.parse(raw);
    if(m.t==='snap'){ if(m.wt){ c.waits.push(m.st); } if(m.rs) c.resumes++; c.snaps++; const n=Date.now(); if(!c.first)c.first=n; c.last=n; c.bytes+=raw.length; c.maxBytes=Math.max(c.maxBytes,raw.length); c.lastSnap=m; for(const e of m.ev) c.events[e.type]=(c.events[e.type]||0)+1; }
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
  b.send({t:'join',code:'ZZZZ'}); await sleep(150); ok('unknown code rejected', b.errors[0]==='Room not found');
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
  for(let i=0;i<300&&!a.ended;i++) await sleep(100);   // room for 15s of sudden death after a tie
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
  ok('match paused while B was away', a.waits.length>0 && a.waits.every(t=>t===a.waits[0]));
  let ib2=wander(b2); await sleep(1500); ok('rejoined player gets snapshots', b2.snaps>5); ok('short hold before resuming', a.resumes>0);
  // B goes silent without disconnecting (a dead connection): the match pauses, then resumes when B speaks again
  a.waits=[]; const awayBefore=a.opp.filter(x=>x==='away').length;
  clearInterval(ib2); await sleep(2500);
  ok('silent player pauses the match', a.opp.filter(x=>x==='away').length===awayBefore+1 && a.waits.length>0 && !a.ended);
  ib2=wander(b2); await sleep(400); ok('A told silent B is back', a.opp[a.opp.length-1]==='back');
  // disconnect again and let the grace period lapse => B forfeits
  a.ended=null; clearInterval(ib2); b2.ws.terminate(); await sleep(2200);
  ok('match ends when a player stays gone', !!a.ended && a.ended.forfeit===1 && a.ended.winner===0);
  // rejoining after the forfeit shows the result instead of a live match
  const b3=client('B3'); await b3.open; b3.send({t:'rejoin',code,token:tokenB}); await sleep(400);
  ok('forfeited player sees the result', !!b3.ended && b3.ended.forfeit===1); b3.ws.close();
  // bad rejoin token
  const c3=client('C'); await c3.open; c3.send({t:'rejoin',code,token:'nope'}); await sleep(200); ok('bad token refused', c3.errors.length===1);
  // random matchmaking
  const p1=client('P1'), p2=client('P2'), p3=client('P3'), p4=client('P4'); await Promise.all([p1.open,p2.open,p3.open,p4.open]);
  p4.send({t:'create'}); await sleep(150);                       // a private room must not be picked
  p1.send({t:'find'}); await sleep(150);
  ok('searcher waits in a public room', p1.room&&p1.room.pub===true&&p1.room.players===1);
  p2.send({t:'find'}); await sleep(400);
  ok('second searcher is paired with the first', p2.room&&p2.room.code===p1.room.code&&p2.room.team===1&&p1.restarts===1);
  ok('private rooms are left alone', p4.restarts===0);
  p3.send({t:'find'}); await sleep(150); const firstCode=p3.room&&p3.room.code; p3.send({t:'leave'}); await sleep(150);
  const p5=client('P5'); await p5.open; p5.send({t:'find'}); await sleep(150);
  ok('cancelled search is not matched', p5.room&&p5.room.players===1&&p5.room.code!==firstCode&&p3.restarts===0);
  for(const x of [p1,p2,p3,p4,p5]) x.ws.close();
  // the room creator leaves the app to send the code: the code must keep working
  const h=client('H'); await h.open; h.send({t:'create'}); await sleep(150);
  const hcode=h.room.code, htok=h.room.token; h.ws.terminate(); await sleep(400);
  const f=client('F'); await f.open; f.send({t:'join',code:hcode}); await sleep(300);
  ok('code still works after the creator drops', f.room&&f.room.code===hcode&&f.errors.length===0);
  ok('friend waits for the creator', f.room&&f.room.wait===true&&f.restarts===0);
  const h2=client('H2'); await h2.open; h2.send({t:'rejoin',code:hcode,token:htok}); await sleep(400);
  ok('match starts when the creator is back', h2.restarts===1&&f.restarts===1);
  for(const x of [f,h2]) x.ws.close();
  // creator still connected but silent (phone in the background): friend waits, pings resume the start
  const q=client('Q'); await q.open; q.send({t:'create'}); await sleep(2300);
  const g=client('G'); await g.open; g.send({t:'join',code:q.room.code}); await sleep(300);
  ok('silent creator does not start the match', g.room&&g.room.wait===true&&g.restarts===0);
  q.send({t:'ping'}); await sleep(300);
  ok('creator pinging again starts it', q.restarts===1&&g.restarts===1);
  for(const x of [q,g]) x.ws.close();
  // pressing cancel really closes the room
  const k=client('K'); await k.open; k.send({t:'create'}); await sleep(150); const kcode=k.room.code; k.send({t:'leave'}); await sleep(150);
  const j=client('J'); await j.open; j.send({t:'join',code:kcode}); await sleep(200);
  ok('cancelled room is closed', j.errors[0]==='Room not found');
  for(const x of [k,j]) x.ws.close();
  clearInterval(ia); a.ws.close(); c3.ws.close(); await sleep(200);
  process.exit(0);
})();
