import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createCase} from './test-support/worker-acceptance-adapter.mjs';
const specification=JSON.parse(await fs.readFile(new URL('./test-support/worker-scenarios.json',import.meta.url),'utf8'));
for(const scenario of specification.cases)for(const mode of scenario.modes)test(`worker ${scenario.id} ${mode}: ${scenario.title}`,{timeout:120000},async()=>{
 const fixture=await createCase(specification.fixture,scenario.id,mode);
 try{
  for(const step of scenario.steps)await fixture.step(step);
  const actual=await fixture.inspect();assert.equal(actual.metadata.mode,mode);
  for(const key of specification.executionMatrix.requiredMetadata)assert.equal(typeof actual.metadata[key],'string',`metadata ${key}`);
  for(const [key,value] of Object.entries(scenario.expect))assert.equal(JSON.stringify(actual[key]),JSON.stringify(value),key);
 }finally{await fixture.close();}
});
