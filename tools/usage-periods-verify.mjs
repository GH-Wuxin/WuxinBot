import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createTestDataDir,cleanupTestDir} from './test-isolation.mjs';
const directory=createTestDataDir('usage-periods');process.env.NODE_ENV='test';
const {initializeUsageHistory,applyUsageTotals,buildUsageStats,usageDayStart,recordOpenAIUsage}=await import('../server/usage.ts');
const {usageSummary,usageAxis,usagePointLabel}=await import('../src/pages/Dashboard/usageView.js');
const now=Date.parse('2026-11-09T05:20:00Z'); // 13:20 in Shanghai, regardless of host/browser timezone.
const usage={totalTokens:9000,promptTokens:8000,completionTokens:1000,requests:40};
const event=(id,at,tokens=100)=>({id,kind:'llm-call',createdAt:at,totalTokens:tokens,promptTokens:tokens*.8,completionTokens:tokens*.2,cachedTokens:20,cacheMeasuredPromptTokens:80,cacheMetricsAvailable:true});
const events=[event('older','2026-10-31T15:59:59Z'),event('month','2026-10-31T16:00:00Z'),event('today','2026-11-09T04:00:00Z'),
 {...event('diagnostic','2026-11-09T04:00:00Z',10000),accountingExcluded:true},
 {...event('rewrite','2026-11-09T04:00:00Z',10000),kind:'rewrite-reply'},event('future','2026-11-10T04:00:00Z')];
try{
 usage.history=initializeUsageHistory(usage,events,now);
 const before=JSON.stringify(usage),stats=buildUsageStats(usage,events,now);
 assert.equal(JSON.stringify(usage),before,'Projection is read only');
 assert.equal(usage.totalTokens,9000,'Legacy lifetime total must not be replaced by retained rows');
 assert.equal(stats.today.totalTokens,100);assert.equal(usageSummary(stats,usage,'month').totals.totalTokens,200);
 assert.equal(usageSummary(stats,usage,'daily30').totals.totalTokens,300);
 assert.equal(stats.month[0].start,Date.parse('2026-10-31T16:00:00Z'));assert.equal(stats.month.length,9);
 assert.equal(stats.hourly24[0].label,'14:00');assert.equal(stats.hourly24.at(-1).label,'13:00');
 assert.deepEqual(usageAxis(stats.hourly24).map(x=>x.label),['14:00','20:00','02:00','07:00','13:00']);
 assert.equal(stats.coverage.daily30.partial,true);assert.equal(stats.coverage.daily7.partial,false);
 assert.ok(usagePointLabel(stats.hourly24[0],'hourly24',stats.timeZone).includes('14:00'));
 const accounted=JSON.stringify(usage.history);applyUsageTotals(usage,{total_tokens:100,accounted:true},now);
 assert.equal(JSON.stringify(usage.history),accounted,'A delivery diagnostic cannot charge the same model usage twice');
 applyUsageTotals(usage,{total_tokens:50,prompt_tokens:40,completion_tokens:10},now);
 const next=buildUsageStats(usage,[],now);assert.equal(next.today.totalTokens,150);assert.equal(next.today.requests,2);
 assert.equal(usageSummary(next,usage).cacheRate,25,'Unmeasured requests do not dilute cache coverage');
 assert.equal(usageSummary(next,usage,'all').totals.totalTokens,9050);
 const nextHour=buildUsageStats(usage,[],now+3600_000);assert.equal(nextHour.hourly24[0].label,'15:00');assert.equal(nextHour.hourly24.at(-1).label,'14:00');
 const leap=buildUsageStats({},[],Date.parse('2028-02-29T10:00:00Z'));assert.equal(leap.month.length,29);assert.equal(leap.month.at(-1).label,'2/29');
 const year=buildUsageStats({},[],Date.parse('2027-01-01T01:00:00Z'));assert.equal(year.month.length,1);assert.equal(year.daily7[0].label,'12/26');
 assert.equal(year.coverage.daily7.partial,false,'A fresh empty database has no missing earlier usage');

 // The real store proxy, event trimming, backup, and a fresh process must all
 // preserve aggregates; testing an array reduction alone would miss this.
 const store=await import('../server/store.ts');store.ensureStore();
 const {createBackup,restoreBackup}=await import('../server/backup.ts');
 const at=Date.now(),previousDay=usageDayStart(at)-3600_000;
 store.updateDb(db=>{
  applyUsageTotals(db.usage,{total_tokens:70,prompt_tokens:60,completion_tokens:10},previousDay);db.usage.requests++;
  for(let i=0;i<5005;i++){
   applyUsageTotals(db.usage,{total_tokens:2,prompt_tokens:1,completion_tokens:1},at);db.usage.requests++;
   db.usageEvents.push(event('fixture-'+i,new Date(at).toISOString(),2));
  }
  db.usageEvents=db.usageEvents.slice(-5000);
 });
 assert.equal(store.readDb().usageEvents.length,5000);
 store.updateDb(db=>{recordOpenAIUsage(db.usage,{provider:'openai-compatible',apiHost:'api.openai.com',model:'gpt-6.1-terra',usage:{prompt_tokens:70,completion_tokens:10},at});});
 const publicState=store.publicDb();assert.equal(publicState.usage.history,undefined,'Do not expose the full persistent history in every state payload');
 assert.equal(publicState.usage.openai,undefined,'Do not expose the OpenAI ledger raw in every state payload');
 assert.equal(publicState.usageStats.openai.hourly24.models['gpt-6.1-terra'].promptTokens,70);
 assert.equal(publicState.usage.totalTokens,10080);
 assert.equal(usageSummary(publicState.usageStats,publicState.usage,'daily7').totals.totalTokens,10080,'Event pruning cannot shrink period totals');
 assert.equal(usageSummary(publicState.usageStats,publicState.usage,'hourly24').totals.requests,
  5005+Number(previousDay>=publicState.usageStats.hourly24[0].start));
 const snapshot=createBackup('manual');
 store.updateDb(db=>{applyUsageTotals(db.usage,{total_tokens:200},at);db.usage.requests++;});
 assert.equal(restoreBackup(snapshot.name).ok,true);assert.equal(store.readDb().usage.totalTokens,10080);
 const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',
  `const s=await import('./server/store.ts');const u=await import('./server/usage.ts');const d=s.readDb();if(d.usage.totalTokens!==10080||u.buildUsageStats(d.usage,[],${at}).today.totalTokens!==10010||d.usage.openai?.total?.['gpt-6.1-terra']?.promptTokens!==70)process.exit(1);`],
  {cwd:process.cwd(),env:process.env,encoding:'utf8',windowsHide:true});
 assert.equal(child.status,0,child.stderr);
 console.log('PASS usage periods: real time labels, Shanghai boundaries, month/leap/year rollover, partial history, cache coverage, no duplicate accounting, 5000-row pruning, store proxy, backup and restart');
}finally{cleanupTestDir(directory);}
