import {createTestDataDir,assertNotProduction,cleanupTestDir} from './test-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const root=createTestDataDir('wuxin-backup-retention');
assertNotProduction(root);
const {listBackupFiles,pruneBackupFiles,resolveBackupRetention,safeBackupPath}=await import('../server/backupFiles.ts');
const store=await import('../server/store.ts');
const backup=await import('../server/backup.ts');
const policy={auto:5,preRestore:5,manual:5};
const directory=path.join(root,'fixture');
fs.mkdirSync(directory);
const put=(name,meta)=>{
  fs.writeFileSync(path.join(directory,name),'{}');
  if(meta)fs.writeFileSync(path.join(directory,name+'.meta.json'),JSON.stringify(meta));
};
try{
  // Exactly the legacy format produced by the five-minute store snapshots.
  for(let i=0;i<24;i++)put(`auto-2026-01-01T00-${String(i).padStart(2,'0')}-00-127Z.json`);
  let items=listBackupFiles(directory);
  assert.equal(items.length,24);
  assert.ok(items.every(item=>item.type==='auto'));
  assert.equal(items[0].createdAt,'2026-01-01T00:23:00.127Z');
  assert.equal(items.at(-1).createdAt,'2026-01-01T00:00:00.127Z');
  assert.equal(pruneBackupFiles(directory,policy).removed,19);
  assert.equal(listBackupFiles(directory).length,5);
  assert.equal(pruneBackupFiles(directory,policy).removed,0);
  put('auto-2026-01-01T00-25-00.json',{name:'../../outside.json',type:'manual',createdAt:'invalid'});
  const entry=listBackupFiles(directory)[0];
  assert.equal(entry.type,'auto');assert.equal(entry.name,'auto-2026-01-01T00-25-00.json');
  assert.equal(entry.createdAt,'2026-01-01T00:25:00.000Z');
  assert.equal(safeBackupPath(directory,'../outside.json'),null);
  put('pre-shard-2020-01-01.json');
  put('db.json.corrupt-2020-01-01.json');
  for(let i=0;i<8;i++)put(`manual-2020-01-01T00-0${i}-00.json`,{type:'manual'});
  assert.equal(pruneBackupFiles(directory,{...policy,manual:0}).removed,1);
  assert.equal(listBackupFiles(directory).filter(x=>x.type==='manual').length,8,'zero means unlimited');
  const aged=pruneBackupFiles(directory,policy,{olderThanDays:30});
  assert.equal(aged.removed,5);
  assert.equal(listBackupFiles(directory).filter(x=>x.type==='manual').length,8,'age-only cleanup never deletes manual backups');
  assert.ok(fs.existsSync(path.join(directory,'pre-shard-2020-01-01.json')));
  assert.ok(fs.existsSync(path.join(directory,'db.json.corrupt-2020-01-01.json')));
  assert.equal(pruneBackupFiles(directory,policy).removed,3);
  assert.equal(listBackupFiles(directory).filter(x=>x.type==='manual').length,5);
  assert.ok(!fs.existsSync(path.join(directory,'manual-2020-01-01T00-00-00.json.meta.json')),'sidecars follow the deleted backup');

  put('auto-2020-01-01T00-00-00.json');put('auto-2020-01-02T00-00-00.json');
  const originalUnlink=fs.unlinkSync;
  try{
    fs.unlinkSync=(file,...args)=>{
      if(String(file).endsWith('auto-2020-01-01T00-00-00.json'))throw Object.assign(new Error('locked fixture'),{code:'EACCES'});
      return originalUnlink(file,...args);
    };
    const failed=pruneBackupFiles(directory,{...policy,auto:1});
    assert.equal(failed.removed,0,'failed deletes are not reported as removed');
    assert.equal(failed.failed.length,1);
    assert.equal(failed.failed[0].error,'EACCES');
  }finally{fs.unlinkSync=originalUnlink;}

  // Exercise the actual store writer, not just the maintenance pruning helper.
  store.ensureStore();
  store.updateDb(db=>{db.settings.backupRetention=policy;});
  const storeDirectory=path.join(root,'backups');
  for(let i=0;i<24;i++)fs.writeFileSync(path.join(storeDirectory,`auto-2020-01-01T00-${String(i).padStart(2,'0')}-00-000Z.json`),'{}');
  const realNow=Date.now;
  try{
    Date.now=()=>realNow()+6*60_000;
    store.updateDb(db=>{db.settings.ownerQq='fixture-owner';});
  }finally{Date.now=realNow;}
  assert.equal(backup.listBackups().filter(x=>x.type==='auto').length,5,'store snapshots use the saved UI limit');
  for(let i=0;i<6;i++)fs.writeFileSync(path.join(storeDirectory,`manual-2020-01-01T00-0${i}-00.json`),'{}');
  const fresh=backup.createBackup('manual');
  assert.equal(backup.listBackups().filter(x=>x.type==='manual').length,5);
  assert.equal(JSON.parse(fs.readFileSync(path.join(storeDirectory,fresh.name),'utf8')).settings.ownerQq,'fixture-owner');
  assert.deepEqual(resolveBackupRetention({settings:{backupRetention:{auto:0,manual:null}}}),{auto:0,preRestore:5,manual:0});
  console.log('PASS: legacy snapshot metadata, ordering, shared retention, unlimited/manual/age policies, actual deletion counts and store writer');
}finally{cleanupTestDir(root);}
