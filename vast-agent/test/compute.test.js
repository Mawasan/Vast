import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';

process.env.VAST_API_KEY = 'private-test-vast-key';
process.env.VAST_AGENT_ACCESS_TOKEN = 'private-test-agent-token';
process.env.VAST_AGENT_DATA_DIR = await mkdtemp(join(tmpdir(), 'vast-compute-'));
const { computeTools } = await import('../dist/tools/compute.js');
const { submitJob, getJob } = await import('../dist/core/jobs.js');
const { runInference, workerUrl } = await import('../dist/vast/inference.js');
const { prepareTemplateEndpoint } = await import('../dist/vast/serverless.js');
const { vastClient } = await import('../dist/core/vastClient.js');
const { createHttpApp } = await import('../dist/http/server.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const call = (name, input) => { const tool = computeTools.find(t => t.name === name); return tool.handler(z.object(tool.inputShape).parse(input)); };
const json = body => new Response(JSON.stringify(body), {headers:{'content-type':'application/json'}});
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const finish = async id => { for (let i=0;i<100;i++) { const job=await getJob(id); if(job.status !== 'running') return job; await new Promise(r=>setTimeout(r,10)); } throw new Error('job did not finish'); };

test('paid operations preview without network or creating jobs', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected request'); });
  assert.equal((await call('vast_rent_instance',{requestId:'preview',offerId:1,template:'x',diskGb:40,maxHourlyUsd:1})).status,'confirmation_required');
  assert.equal((await call('vast_generate_image',{requestId:'preview-image',endpoint:'x',workflow:{'1':{class_type:'SaveImage',inputs:{}}}})).status,'confirmation_required');
  assert.equal((await call('vast_generate_template_image',{requestId:'preview-template-image',endpoint:'x',template:'AKIRA',prompt:'test'})).status,'confirmation_required');
  assert.equal((await call('vast_prepare_template_endpoint',{template:'AKIRA'})).status,'confirmation_required');
  assert.equal((await call('vast_start_instance',{id:1})).status,'confirmation_required');
});
test('offer search unwraps repeated filters objects before calling Vast', async t => {
  let requestBody;
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    requestBody = JSON.parse(opts.body);
    return json({offers:[]});
  });
  await call('vast_search_offers', {filters:{filters:{filters:{gpu_name:{eq:'RTX_4090'}}}}});
  assert.deepEqual(requestBody.gpu_name, {eq:'RTX_4090'});
  assert.equal(Object.hasOwn(requestBody, 'filters'), false);
});
test('offer search rejects an ambiguous nested filters object', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected request'); });
  await assert.rejects(
    () => call('vast_search_offers', {filters:{filters:{gpu_name:{eq:'RTX_4090'}}, dph_total:{lte:0.5}}}),
    /do not mix a nested filters key/
  );
});
test('concurrent/reconnected requests execute once; changed arguments rejected', async () => {
  let count=0, release;
  const blocked = new Promise(r=>release=r);
  const run=async()=>{ count++; await blocked; return {instanceId:88}; };
  const [a,b] = await Promise.all([submitJob('same','rent',{x:1,y:2},run),submitJob('same','rent',{y:2,x:1},run)]);
  assert.equal(count,1); assert.equal(a.requestId,b.requestId);
  await assert.rejects(()=>submitJob('same','rent',{x:2},run),/different arguments/);
  release(); assert.equal((await finish('same')).result.instanceId,88);
  await submitJob('same','rent',{x:1,y:2},run); assert.equal(count,1);
});
test('restart and network ambiguity never replay a paid operation', async () => {
  await submitJob('uncertain','rent',{},async()=>{throw new Error('socket closed');});
  assert.equal((await finish('uncertain')).status,'unknown');
  await submitJob('uncertain','rent',{},async()=>{throw new Error('should never run');});
  const path=join(process.env.VAST_AGENT_DATA_DIR,'jobs',createHash('sha256').update('uncertain').digest('hex')+'.json');
  const job=JSON.parse(await readFile(path)); job.status='running'; await writeFile(path,JSON.stringify(job));
  assert.match((await getJob('uncertain')).error,/restarted/);
});
test('rental checks current price and submits exactly one non-retried PUT', async t => {
  let rate=.4, writes=0, disconnect=false;
  t.mock.method(globalThis,'fetch',async (url, opts)=>{
    if(disconnect) { writes++; throw new Error('disconnected'); }
    const path=new URL(url).pathname;
    if(path.endsWith('/users/current/')) return json({id:42});
    if(path.endsWith('/template/')) return json({templates:[{id:1,hash_id:'abc',name:'Test',creator_id:42,image:'test/image'}]});
    if(path.endsWith('/bundles/')) return json({offers:[{id:123,dph_total:rate,rentable:true}]});
    if(path.endsWith('/asks/123/')) {writes++; const body=JSON.parse(opts.body); assert.equal(body.template_hash_id,'abc'); assert.equal(body.disk,40); return json({success:true,new_contract:99});}
    throw new Error(`unexpected path ${path}`);
  });
  const args={offerId:123,template:'Test',diskGb:40,maxHourlyUsd:.5,confirm:true};
  await call('vast_rent_instance',{...args,requestId:'rent-ok'});
  const result=await finish('rent-ok'); assert.equal(result.status,'completed',result.error); assert.equal(result.result.instanceId,99); assert.equal(writes,1);
  rate=.8; await call('vast_rent_instance',{...args,requestId:'rent-price'}); assert.match((await finish('rent-price')).error,/exceeds/); assert.equal(writes,1);
  disconnect=true;
  await assert.rejects(()=>vastClient.putOnce('/asks/123/',{}),/disconnected/); assert.equal(writes,2);
});
test('start/stop distinguish accepted transition from reached state and preserve disk', async t => {
  let state='stopped', requested, deletes=0;
  t.mock.method(globalThis,'fetch',async (url,opts)=>{
    if(opts.method==='DELETE') deletes++;
    if(opts.method==='PUT') {requested=JSON.parse(opts.body).state; return json({success:true});}
    return json({instances:{id:9,actual_status:state}});
  });
  assert.equal((await call('vast_start_instance',{id:9,confirm:true})).reached,false); assert.equal(requested,'running');
  state='running'; assert.equal((await call('vast_stop_instance',{id:9,confirm:true})).reached,false); assert.equal(requested,'stopped'); assert.equal(deletes,0);
});
test('prepares one scale-to-zero endpoint and workergroup for a template', async t => {
  const writes=[];
  t.mock.method(globalThis,'fetch',async (url,opts={})=>{
    const path=new URL(url).pathname;
    if(path.endsWith('/users/current/')) return json({id:42});
    if(path.endsWith('/template/')) return json({templates:[{id:77,hash_id:'hash-akira',name:'AKIRA - Test',creator_id:42,image:'vastai/comfy'}]});
    if(path.endsWith('/endptjobs') || (path.endsWith('/endptjobs/') && opts.method==='GET')) return json({success:true,results:[]});
    if(path.endsWith('/workergroups/') && opts.method==='GET') return json({success:true,results:[]});
    if(path.endsWith('/endptjobs/') && opts.method==='POST') { writes.push(JSON.parse(opts.body)); return json({success:true,result:501}); }
    if(path.endsWith('/workergroups/') && opts.method==='POST') { writes.push(JSON.parse(opts.body)); return json({success:true,id:601}); }
    throw new Error(`unexpected path ${path} ${opts.method}`);
  });
  const result=await prepareTemplateEndpoint('AKIRA - Test');
  assert.equal(result.created,true);
  assert.equal(result.endpoint.id,501);
  assert.equal(result.workergroup.id,601);
  assert.equal(writes[0].cold_workers,0);
  assert.equal(writes[0].max_workers,1);
  assert.equal(writes[1].template_hash,'hash-akira');
});
test('repairs an Anima template and reprovisions its workergroup before reuse', async t => {
  const baseResource={name:'Anima',role:'base',source:'url',ref:'https://example.com/anima',filename:'anima.safetensors',targetPath:'/workspace/ComfyUI/models/diffusion_models'};
  const marker=`# >>> vast-agent:models >>>\n# vast-agent:models:json=${JSON.stringify([baseResource])}\n# <<< vast-agent:models <<<`;
  let template={id:78,hash_id:'hash-anima',name:'AKIRA - Anima',creator_id:42,image:'vastai/comfy',onstart:marker};
  const deletes=[]; const writes=[];
  t.mock.method(globalThis,'fetch',async (url,opts={})=>{
    const path=new URL(url).pathname;
    if(path.endsWith('/template/') && opts.method==='GET') return json({templates:[template]});
    if(path.endsWith('/template/') && opts.method==='PUT') { template={...template,...JSON.parse(opts.body)}; return json({template}); }
    if(path.endsWith('/endptjobs') || (path.endsWith('/endptjobs/') && opts.method==='GET')) return json({results:[{id:502,endpoint_name:'akira-anima',endpoint_state:'active'}]});
    if(path.endsWith('/workergroups/') && opts.method==='GET') return json({results:[{id:602,endpoint_id:502,endpoint_name:'akira-anima',template_id:78,template_hash:'hash-anima'}]});
    if(path.endsWith('/workergroups/602/') && opts.method==='DELETE') { deletes.push(path); return json({success:true}); }
    if(path.endsWith('/workergroups/') && opts.method==='POST') { writes.push(JSON.parse(opts.body)); return json({id:603}); }
    throw new Error(`unexpected path ${path} ${opts.method}`);
  });
  const result=await prepareTemplateEndpoint('hash-anima');
  assert.equal(result.templateUpdated,true);
  assert.deepEqual(deletes,['/api/v0/workergroups/602/']);
  assert.equal(writes[0].endpoint_id,502);
  assert.match(template.onstart,/qwen_3_06b_base\.safetensors/);
  assert.match(template.onstart,/qwen_image_vae\.safetensors/);
});
test('image request routes auth_data separately and preserves complete workflow', async t => {
  let sends=0;
  t.mock.method(globalThis,'fetch',async (url,opts)=>{
    if(String(url).includes('run.vast.ai')) { assert.match(opts.headers.Authorization,/Bearer/); return json({url:'http://8.8.8.8:8000',signature:'signed',reqnum:7}); }
    sends++; assert.equal(String(url),'http://8.8.8.8:8000/generate/sync'); assert.equal(opts.headers.Authorization,undefined);
    const body=JSON.parse(opts.body); assert.equal(body.auth_data.signature,'signed'); assert.equal(body.payload.input.workflow_json['1'].class_type,'SaveImage');
    return json({output:[{url:'https://storage.example/image.png'}]});
  });
  await call('vast_generate_image',{requestId:'image-ok',endpoint:'test',confirm:true,workflow:{'1':{class_type:'SaveImage',inputs:{}}}});
  const job=await finish('image-ok'); assert.equal(job.status,'completed',job.error); assert.equal(sends,1); assert.equal(job.result.output.output[0].url,'https://storage.example/image.png');
});
test('image request retrieves ComfyUI local_path output before the worker scales down', async t => {
  const imageBytes=Buffer.alloc(32,7);
  let generated=false, viewed=false;
  t.mock.method(globalThis,'fetch',async (url,opts={})=>{
    const value=String(url);
    if(value.includes('run.vast.ai')) return json({url:'http://8.8.4.4:8000',signature:'signed',reqnum:8});
    if(value==='http://8.8.4.4:8000/generate/sync') { generated=true; return json({output:[{local_path:'/workspace/ComfyUI/output/akira/test.png'}]}); }
    if(value==='http://8.8.4.4:8000/view?filename=test.png&type=output&subfolder=akira') { viewed=true; return new Response(imageBytes,{headers:{'content-type':'image/png'}}); }
    throw new Error(`unexpected URL ${value}`);
  });
  const result=await runInference({endpoint:'test',path:'/generate/sync',payload:{stream:false},cost:100,timeoutSeconds:10});
  assert.equal(generated,true); assert.equal(viewed,true);
  assert.equal(result.media.mimeType,'image/png'); assert.equal(result.media.base64,imageBytes.toString('base64'));
});
test('private worker destinations rejected; failed worker is not retried', async t => {
  for(const url of ['http://127.0.0.1:80','http://169.254.169.254','http://10.0.0.1','http://[::1]','http://localhost','http://user:password@8.8.8.8']) await assert.rejects(()=>workerUrl(url));
  let sends=0;
  t.mock.method(globalThis,'fetch',async url=>{
    if(String(url).includes('run.vast.ai')) return json({url:'http://8.8.8.8:8000',signature:'signed',reqnum:7});
    sends++; return new Response('{"error":"missing model"}',{status:500});
  });
  await assert.rejects(()=>runInference({endpoint:'test',path:'/generate/sync',payload:{},cost:100,timeoutSeconds:10}),/500.*missing model/); assert.equal(sends,1);
});
test('REST schemas and MCP expose the same tools, with protected execution and public discovery', async () => {
  const server=createHttpApp().listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers={Authorization:`Bearer ${process.env.VAST_AGENT_ACCESS_TOKEN}`};
  const client=new Client({name:'integration-test',version:'1.0.0'});
  try {
    assert.equal((await fetch(base+'/api/tools')).status,401);
    const rest=await (await fetch(base+'/api/tools',{headers})).json();
    const specResponse=await fetch(base+'/api/openapi.json');
    assert.equal(specResponse.status,200);
    const spec=await specResponse.json();
    assert.equal(Object.keys(spec.paths).length,rest.length);
    assert.equal(spec.servers[0].url,base);
    assert.equal((await fetch(base+'/api/tools/vast_search_offers',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
    const schema=rest.find(t=>t.name==='vast_rent_instance').inputSchema; assert.ok(schema.required.includes('maxHourlyUsd'));
    await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers}}));
    const mcp=await client.listTools(); assert.equal(mcp.tools.length,rest.length);
    const preview=await client.callTool({name:'vast_stop_instance',arguments:{id:9}}); assert.match(preview.content[0].text,/confirmation_required/);
  } finally { await client.close(); await new Promise(r=>server.close(r)); }
});
