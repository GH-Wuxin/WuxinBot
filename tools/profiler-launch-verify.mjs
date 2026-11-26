import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import test from 'node:test';

const moduleUrl=process.env.PROFILER_LAUNCH_MANAGER
  ? pathToFileURL(path.resolve(process.env.PROFILER_LAUNCH_MANAGER)).href
  : new URL('../desktop/process-manager.mjs',import.meta.url).href;
const {ProcessManager,buildDefaultDefinitions}=await import(moduleUrl);
const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const emptyRuntime={listProcesses:async()=>[],listListeners:async()=>[],probePort:async()=>false};
const savedEnv=process.env.SKILL_PROFILER_ALGORITHM;
delete process.env.SKILL_PROFILER_ALGORITHM;
test.after(()=>{if(savedEnv===undefined)delete process.env.SKILL_PROFILER_ALGORITHM;else process.env.SKILL_PROFILER_ALGORITHM=savedEnv;});

function definition(){return buildDefaultDefinitions(projectRoot).find(d=>d.id==='skillProfiler');}
async function load(t,saved,version=2){
  const configDir=await fs.mkdtemp(path.join(os.tmpdir(),'wuxin-profiler-launch-'));
  t.after(async()=>{assert.equal(path.dirname(configDir),path.resolve(os.tmpdir()));await fs.rm(configDir,{recursive:true,force:true});});
  const defaults=definition();
  const config=version===1 ? {version:1,processes:[{...defaults,...saved}]} : {version:2,processOverrides:{skillProfiler:saved}};
  await fs.writeFile(path.join(configDir,'desktop-runtime.json'),JSON.stringify(config));
  const manager=new ProcessManager({projectRoot,configDir,buildDefinitions:()=>[defaults],runtime:emptyRuntime});
  await manager.initialize();
  return manager.getDefinition('skillProfiler');
}
test('current default and legacy environment select v041',()=>{
  assert.equal(definition().args.at(-1),'v041-formal');
  process.env.SKILL_PROFILER_ALGORITHM='v040-formal';
  try{assert.equal(definition().args.at(-1),'v041-formal');}finally{delete process.env.SKILL_PROFILER_ALGORITHM;}
});
for(const version of [1,2]){
  for(const value of ['v041-formal','v042-future','custom-algorithm','v100']){
    test(`v${version} preserves explicit selector ${value}`,async t=>{
      const args=['custom.py','--algorithm',value,'--port','9876'];
      const actual=await load(t,{cwd:path.join(projectRoot,'custom-profiler'),args},version);
      assert.deepEqual(actual.args,args);assert.equal(actual.cwd,path.join(projectRoot,'custom-profiler'));
    });
  }
  for(const args of [['custom.py','--algorithm','v040-formal','--analysis-workers','6'],['custom.py','--algorithm=v040-formal','--no-open']]){
    test(`v${version} upgrades a retired formal selector: ${args[1]}`,async t=>{
      const actual=await load(t,{args},version);
      assert.deepEqual(actual.args,args.map(arg=>arg.replace('v040-formal','v041-formal')));
    });
  }
}
test('saved current configuration survives reload unchanged',async t=>{
  const args=[...definition().args,'--analysis-workers','6'];
  const actual=await load(t,{args,enabled:true,env:{CUSTOM:'retained'}});
  assert.deepEqual(actual.args,args);assert.equal(actual.enabled,true);assert.equal(actual.env.CUSTOM,'retained');
});
test('known generated legacy launch still migrates to the current root',async t=>{
  const oldRoot='G:\\My pack\\Agent Work\\osu-skill-profiler';
  const args=['-u',path.join(oldRoot,'tools','map_demand_v01','cli.py'),'bid-review-ui','--manifest',path.join(oldRoot,'training','datasets','std_manifest.json'),'--no-open','--algorithm','v040-formal'];
  const actual=await load(t,{cwd:oldRoot,args},1);
  assert.equal(actual.cwd,definition().cwd);assert.deepEqual(actual.args,definition().args);
});
test('malformed or omitted selectors remain for the CLI to validate',async t=>{
  for(const args of [['custom.py'],['custom.py','--algorithm'],['custom.py','--algorithm=']])assert.deepEqual((await load(t,{args})).args,args);
});
