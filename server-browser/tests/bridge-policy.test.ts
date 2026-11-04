import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { bridgeScript } from '../server/bridge-source';
import { BrowserManager } from '../server/browser-manager';
import { defaultRuntimeRoot } from '../server/runtime';

// A stand-in for Playwright MCP that records what reaches it: its environment, working directory and every request.
// Like Playwright MCP it saves a call's output to the file named in "filename", relative to its working directory.
// `tabs` makes browser_tabs list/select answer with Playwright MCP's text list (`- <index>: (current)? [title](url)`),
// in that array's order, which need not match the plugin's validate targets. Without it, every call is JSON.
type ScriptedTab={title:string;url:string;suffix?:string};
type ScriptedTabs={tabs:ScriptedTab[];current?:number|null;afterSelect?:number|null};
const fakeMcp=(log:string,scripted?:ScriptedTabs)=>`import {appendFileSync,writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const record=value=>appendFileSync(${JSON.stringify(log)},JSON.stringify(value)+'\\n');
const tools=['browser_click','browser_file_upload','browser_drop','browser_navigate','browser_network_request','browser_tabs','browser_close','browser_run_code_unsafe','browser_pdf_save','browser_mouse_click_xy'].map(name=>({name,description:name,inputSchema:{type:'object',properties:{}}}));
const scripted=${JSON.stringify(scripted??null)};
const renderTabs=()=>scripted.tabs.map((tab,index)=>'- '+index+':'+(index===scripted.current?' (current)':'')+' ['+tab.title+']('+tab.url+')'+(tab.suffix||'')).join('\\n');
createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);record({method:message.method,params:message.params,...(message.method==='initialize'?{cwd:process.cwd(),env:process.env,argv:process.argv.slice(2)}:{})});if(message.id===undefined)return;
if(message.method==='tools/call'&&message.params.arguments?.filename)writeFileSync(message.params.arguments.filename,'saved by the stand-in');
let rendered;
if(scripted&&message.method==='tools/call'&&message.params.name==='browser_tabs'){
 const action=message.params.arguments?.action;
 if(action==='select')scripted.current=Object.prototype.hasOwnProperty.call(scripted,'afterSelect')?scripted.afterSelect:message.params.arguments?.index;
 if(action==='list'||action==='select')rendered=renderTabs();
}
const result=message.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{},serverInfo:{name:'fake',version:'1'}}:message.method==='tools/list'?{tools}:{content:[{type:'text',text:rendered??JSON.stringify(message.params)}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');});`;

type Control={route:string;body:Record<string,unknown>};
type FixtureView={activeTargetId?:string;activeIndex?:number;targets?:{id:string;index:number;title?:string;url:string;active?:boolean;pinned?:boolean}[]};
async function fixture(t:TestContext,options:{workspaceDirectory?:boolean;view?:FixtureView;tabs?:ScriptedTabs}={}){
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'paseo-browser-policy-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const runtime=path.join(root,'runtime'),cli=path.join(runtime,'node_modules','@playwright','mcp','cli.js'),log=path.join(root,'mcp.log');
  const workspace=path.join(root,'workspace'),data=path.join(root,'data');
  await mkdir(path.dirname(cli),{recursive:true});await mkdir(path.join(workspace,'nested'),{recursive:true});await mkdir(data);
  await writeFile(cli,fakeMcp(log,options.tabs));await writeFile(path.join(root,'bridge.mjs'),bridgeScript(runtime));
  await writeFile(path.join(workspace,'report.txt'),'synthetic report');await writeFile(path.join(root,'outside.txt'),'outside the workspace');
  await symlink(path.join(workspace,'report.txt'),path.join(workspace,'link-inside.txt'));await symlink(path.join(root,'outside.txt'),path.join(workspace,'link-outside.txt'));
  // The control endpoint: it answers like the plugin and normalizes navigation to a value the bridge cannot have made up itself.
  const controls:Control[]=[];
  const server=createServer(async(request:IncomingMessage,response)=>{
    let body='';for await(const chunk of request)body+=chunk;const input=JSON.parse(body||'{}');controls.push({route:request.url!.slice(1),body:input});
    const answer=(status:number,value:unknown)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(value));};
    if(request.headers.authorization!=='Bearer test-token')return answer(401,{error:'Unauthorized'});
    const view={leaseId:'lease-1',activeTargetId:'target-1',activeIndex:0,epoch:1,targets:[],maxTabs:20,tabCount:1,...options.view};
    if(request.url==='/acquire'){if(input.url!==undefined&&String(input.url).includes('@'))return answer(409,{error:'请在网页内登录，不要在地址中填写密码。'});return answer(200,{...view,...(input.url!==undefined?{url:'https://normalized.example/'}:{})});}
    if(request.url==='/validate')return answer(200,view);
    return answer(200,{ok:true});
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
  const port=(server.address() as {port:number}).port;
  const metadata=path.join(data,'session.json');
  // The bridge trusts session.json only while the Chromium it names runs with this workspace's Profile: a stand-in process.
  const chromium=spawn(process.execPath,['-e','setInterval(()=>{},1<<30)','--',`--user-data-dir=${path.join(data,'profile')}`,'--remote-debugging-address=127.0.0.1'],{stdio:'ignore'});
  t.after(()=>{chromium.kill('SIGKILL');});
  await writeFile(metadata,JSON.stringify({version:2,workspaceId:'workspace',endpoint:`http://127.0.0.1:${port}`,token:'test-token',cdpEndpoint:'http://127.0.0.1:9',mcpCli:cli,artifactDir:path.join(data,'artifacts'),workspaceDirectory:options.workspaceDirectory===false?null:workspace,browserPid:chromium.pid,epoch:1}));
  // A permissive umask for the bridge, as an Agent may have: the files Playwright MCP saves must still be private.
  const umask=process.umask(0o022);
  const child=spawn(process.execPath,[path.join(root,'bridge.mjs'),metadata],{stdio:['pipe','pipe','pipe'],env:{...process.env,SERVER_BROWSER_TEST_SECRET:'must-not-reach-mcp',NODE_OPTIONS:'--no-warnings',PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS:'1',HTTP_PROXY:'http://proxy.invalid:3128',LANG:'C.UTF-8',XDG_CACHE_HOME:path.join(root,'cache')}});
  process.umask(umask);
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.stdin.end();const timer=setTimeout(()=>child.kill('SIGKILL'),5000);await once(child,'exit');clearTimeout(timer);}});
  let id=0;const pending=new Map<number,(value:any)=>void>();
  createInterface({input:child.stdout}).on('line',line=>{const message=JSON.parse(line);pending.get(message.id)?.(message);pending.delete(message.id);});
  const request=(method:string,params:unknown={})=>new Promise<any>(resolve=>{const next=++id;pending.set(next,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:next,method,params})+'\n');});
  const call=async(name:string,args:Record<string,unknown>)=>(await request('tools/call',{name,arguments:args})).result;
  const mcpLog=async()=>(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const forwarded=async(name:string)=>(await mcpLog()).filter(entry=>entry.method==='tools/call'&&entry.params.name===name).map(entry=>entry.params.arguments);
  return {root,workspace,controls,request,call,mcpLog,forwarded};
}
const text=(result:any)=>(result.content??[]).map((item:any)=>item.text).join('\n');

test('Playwright MCP gets the workspace as its file root and only harmless environment variables', {timeout:30000}, async t=>{
  const {workspace,request,mcpLog}=await fixture(t);
  const reply=await request('initialize',{protocolVersion:'2025-03-26',capabilities:{roots:{listChanged:true},elicitation:{}},clientInfo:{name:'test',version:'1'}});
  assert.equal(reply.error,undefined);
  const started=(await mcpLog()).find(entry=>entry.method==='initialize');
  assert.equal(started.cwd,workspace,'relative file names resolve inside the workspace');
  assert.equal(started.params.capabilities.roots,undefined,'client roots cannot widen Playwright MCP file access');
  assert.deepEqual(started.params.capabilities.elicitation,{});
  for(const name of ['SERVER_BROWSER_TEST_SECRET','NODE_OPTIONS','PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS','HTTP_PROXY'])assert.equal(started.env[name],undefined,`${name} stays out of the MCP process`);
  for(const name of ['PATH','HOME','LANG','XDG_CACHE_HOME'])assert.ok(started.env[name],`${name} is inherited`);
  // The CDP address reaches Playwright MCP through its environment (readable only by the daemon user), never argv,
  // which every local account can read in the process list.
  assert.equal(started.env.PLAYWRIGHT_MCP_CDP_ENDPOINT,'http://127.0.0.1:9');
  assert.ok(!started.argv.some((arg:string)=>arg.includes('127.0.0.1')||arg==='--cdp-endpoint'),started.argv.join(' '));
});

test('only the allowlisted Playwright MCP tools are listed and callable', {timeout:30000}, async t=>{
  const {request,call,controls,forwarded}=await fixture(t);
  await request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
  const listed=((await request('tools/list')).result.tools as {name:string}[]).map(tool=>tool.name);
  assert.deepEqual(listed,['browser_click','browser_file_upload','browser_drop','browser_navigate','browser_network_request','browser_tabs','browser_read_page','browser_diagnostics']);
  for(const name of ['browser_pdf_save','browser_mouse_click_xy','browser_run_code_unsafe','browser_close','browser_install']){
    const result=await call(name,{});
    assert.equal(result.isError,true,name);
  }
  assert.match(text(await call('browser_pdf_save',{})),/不提供工具 browser_pdf_save/);
  assert.equal(controls.filter(item=>item.route==='acquire').length,0,'a refused tool never takes a lease');
  assert.deepEqual(await forwarded('browser_pdf_save'),[]);
  const clicked=await call('browser_click',{target:'#go'});
  assert.equal(clicked.isError,undefined,text(clicked));
  assert.deepEqual(await forwarded('browser_click'),[{target:'#go'}]);
  assert.equal(controls.filter(item=>item.route==='release').length,1);
});

test('uploads and drops accept only regular files inside the workspace, passed on as real paths', {timeout:30000}, async t=>{
  const {root,workspace,call,request,controls,forwarded}=await fixture(t);
  await request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
  const report=path.join(workspace,'report.txt');
  assert.equal((await call('browser_file_upload',{paths:['report.txt']})).isError,undefined);
  assert.equal((await call('browser_file_upload',{paths:[report,'./nested/../report.txt']})).isError,undefined);
  assert.deepEqual(await forwarded('browser_file_upload'),[{paths:[report]},{paths:[report,report]}]);
  const refused:[unknown,RegExp][]=[
    [['../outside.txt'],/只能上传当前工作区目录里的文件/],[[path.join(root,'outside.txt')],/只能上传当前工作区目录里的文件/],['/etc/hostname',/路径数组/],
    [['link-inside.txt'],/不能上传符号链接/],[['link-outside.txt'],/不能上传符号链接/],[['nested'],/只能上传普通文件/],[['missing.txt'],/找不到要上传的文件/],[[''],/上传路径无效/],
  ];
  const acquiredBefore=controls.filter(item=>item.route==='acquire').length;
  for(const [paths,message] of refused){const result=await call('browser_file_upload',{paths});assert.equal(result.isError,true,String(paths));assert.match(text(result),message);}
  const outside=await call('browser_drop',{target:'#zone',paths:['report.txt','../outside.txt']});
  assert.equal(outside.isError,true);assert.match(text(outside),/只能上传当前工作区目录里的文件/);
  assert.equal(controls.filter(item=>item.route==='acquire').length,acquiredBefore,'refused paths never take a lease');
  assert.equal((await forwarded('browser_file_upload')).length,2);
  assert.equal((await call('browser_drop',{target:'#zone',paths:['report.txt']})).isError,undefined);
  assert.equal((await call('browser_drop',{target:'#zone',data:{'text/plain':'hello'}})).isError,undefined);
  assert.deepEqual(await forwarded('browser_drop'),[{target:'#zone',paths:[report]},{target:'#zone',data:{'text/plain':'hello'}}]);
  assert.equal((await call('browser_file_upload',{})).isError,undefined,'cancelling a file chooser needs no paths');
});

test('without a known workspace directory no file is uploaded', {timeout:30000}, async t=>{
  const {call,request,forwarded}=await fixture(t,{workspaceDirectory:false});
  await request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
  const result=await call('browser_file_upload',{paths:['/etc/hostname']});
  assert.equal(result.isError,true);assert.match(text(result),/没有这个工作区的目录信息/);
  assert.deepEqual(await forwarded('browser_file_upload'),[]);
});

test('Agent navigation goes through the server and Playwright MCP receives only the normalized address', {timeout:30000}, async t=>{
  const {call,request,controls,forwarded}=await fixture(t);
  await request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
  assert.equal((await call('browser_navigate',{url:'example.com/start'})).isError,undefined);
  assert.equal(controls.find(item=>item.route==='acquire')?.body.url,'example.com/start');
  assert.deepEqual(await forwarded('browser_navigate'),[{url:'https://normalized.example/'}]);
  const refused=await call('browser_navigate',{url:'https://user:secret@example.com/'});
  assert.equal(refused.isError,true);assert.match(text(refused),/不要在地址中填写密码/);
  assert.equal((await forwarded('browser_navigate')).length,1,'a refused address never reaches Playwright MCP');
});

test('during manual takeover the page structure, network and console reads are refused and never reach Playwright MCP', {timeout:90000}, async t=>{
  // The real plugin server and Chromium, with a stand-in Playwright MCP that logs every call: a runtime whose Playwright is the real one.
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'paseo-browser-policy-manual-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const runtime=path.join(root,'runtime'),log=path.join(root,'mcp.log');
  await mkdir(path.join(runtime,'node_modules','@playwright','mcp'),{recursive:true});
  await symlink(path.join(defaultRuntimeRoot(),'node_modules','playwright'),path.join(runtime,'node_modules','playwright'));
  // Like the real runtime: its optional lib/ and fonts.conf, which Chromium needs where the host lacks those libraries.
  for(const extra of ['lib','fonts.conf'])await symlink(path.join(defaultRuntimeRoot(),extra),path.join(runtime,extra));
  await writeFile(path.join(runtime,'node_modules','@playwright','mcp','cli.js'),fakeMcp(log));
  const manager=new BrowserManager({dataRoot:path.join(root,'data'),runtimeRoot:runtime});
  t.after(()=>manager.close());
  assert.equal((await manager.start('takeover')).mode,'manual');
  const bridge=spawn(process.execPath,[manager.bridgePath,manager.metadataPath('takeover')],{stdio:['pipe','pipe','pipe']});
  t.after(async()=>{if(bridge.exitCode===null&&bridge.signalCode===null){bridge.stdin.end();const timer=setTimeout(()=>bridge.kill('SIGKILL'),5000);await once(bridge,'exit');clearTimeout(timer);}});
  let id=0;const pending=new Map<number,(value:any)=>void>();
  createInterface({input:bridge.stdout}).on('line',line=>{const message=JSON.parse(line);pending.get(message.id)?.(message);pending.delete(message.id);});
  const request=(method:string,params:unknown={})=>new Promise<any>(resolve=>{const next=++id;pending.set(next,resolve);bridge.stdin.write(JSON.stringify({jsonrpc:'2.0',id:next,method,params})+'\n');});
  const call=async(name:string,args:Record<string,unknown>)=>(await request('tools/call',{name,arguments:args})).result;
  const toolCalls=async()=>(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line)).filter(entry=>entry.method==='tools/call').map(entry=>entry.params.name);
  await request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
  const reads:[string,Record<string,unknown>][]=[['browser_snapshot',{}],['browser_find',{regex:'x'}],['browser_wait_for',{time:0.1}],['browser_network_requests',{}],['browser_network_request',{index:1,part:'response-body'}],['browser_console_messages',{}]];
  for(const [name,args] of reads){
    const result=await call(name,args);
    assert.equal(result.isError,true,name);assert.match(text(result),/不能读取页面结构.*browser_take_screenshot/,name);
  }
  assert.deepEqual(await toolCalls(),[],'no refused read reaches Playwright MCP');
  assert.equal((await call('browser_take_screenshot',{})).isError,undefined,'a screenshot still goes through');
  assert.deepEqual(await toolCalls(),['browser_tabs','browser_tabs','browser_take_screenshot'],'the bridge selects the tab, then forwards the screenshot');
  await manager.action('takeover',{kind:'mode',mode:'agent'});
  assert.equal((await call('browser_snapshot',{})).isError,undefined,'allowed again once the Agent is in control');
  assert.equal((await toolCalls()).at(-1),'browser_snapshot');
});

test('request headers and bodies are never offered; response parts are', {timeout:30000}, async t=>{
  const {request,call,controls,forwarded}=await fixture(t);
  await request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
  for(const args of [{index:1,part:'request-body'},{index:1,part:'request-headers'},{index:1}]){
    const result=await call('browser_network_request',args);
    assert.equal(result.isError,true,JSON.stringify(args));assert.match(text(result),/不提供请求头和请求正文/);
  }
  assert.equal(controls.filter(item=>item.route==='acquire').length,0,'a refused part never takes a lease');
  assert.deepEqual(await forwarded('browser_network_request'),[]);
  for(const part of ['response-headers','response-body'])assert.equal((await call('browser_network_request',{index:1,part})).isError,undefined,part);
  assert.deepEqual(await forwarded('browser_network_request'),[{index:1,part:'response-headers'},{index:1,part:'response-body'}]);
});

test('files Playwright MCP saves for the Agent are private to the daemon user, whatever umask the Agent has', {timeout:30000}, async t=>{
  const {workspace,request,call}=await fixture(t);
  await request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
  assert.equal((await call('browser_network_requests',{filename:'requests.log'})).isError,undefined);
  assert.equal((await stat(path.join(workspace,'requests.log'))).mode&0o777,0o600);
});

// Plugin order is about:blank, Paseo, Google. The child's list is about:blank, Google, Paseo: index 1 and index 2 swap.
const pluginTargets=[
  {id:'blank',index:0,title:'',url:'about:blank',active:false,pinned:false},
  {id:'paseo',index:1,title:'Paseo',url:'https://paseo.example/',active:true,pinned:false},
  {id:'google',index:2,title:'Google',url:'https://google.example/',active:false,pinned:false},
];
const childTabs:ScriptedTab[]=[
  {title:'',url:'about:blank'},
  {title:'Google',url:'https://google.example/'},
  {title:'Paseo',url:'https://paseo.example/'},
];
const toolNames=async(mcpLog:()=>Promise<any[]>)=> (await mcpLog()).filter(entry=>entry.method==='tools/call').map(entry=>({name:entry.params.name,arguments:entry.params.arguments}));

test('a reordered Playwright tab list selects the child index of the target URL', {timeout:30000}, async t=>{
  const {request,call,mcpLog}=await fixture(t,{view:{activeTargetId:'paseo',activeIndex:1,targets:pluginTargets},tabs:{tabs:childTabs}});
  await request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
  const shot=await call('browser_take_screenshot',{});
  assert.equal(shot.isError,undefined,text(shot));
  const calls=await toolNames(mcpLog);
  assert.deepEqual(calls.map(entry=>entry.name),['browser_tabs','browser_tabs','browser_tabs','browser_take_screenshot']);
  assert.deepEqual(calls[1].arguments,{action:'select',index:2},'Paseo is index 2 in the child, not the plugin index 1');
  assert.deepEqual(calls[3].arguments,{});
});

test('the same address with one trailing slash still selects that child tab', {timeout:30000}, async t=>{
  const tabs:ScriptedTab[]=[{title:'Other',url:'https://other.example/'},{title:'Paseo',url:'https://paseo.example'}];
  const {request,call,mcpLog}=await fixture(t,{view:{activeTargetId:'paseo',activeIndex:0,targets:[{id:'paseo',index:0,title:'Paseo',url:'https://paseo.example/',active:true}]},tabs:{tabs}});
  await request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
  assert.equal((await call('browser_take_screenshot',{})).isError,undefined);
  const calls=await toolNames(mcpLog);
  assert.deepEqual(calls[1].arguments,{action:'select',index:1});
  assert.equal(calls.at(-1)?.name,'browser_take_screenshot');
});

test('duplicate URLs fail and the tool is not forwarded', {timeout:30000}, async t=>{
  const tabs:ScriptedTab[]=[
    {title:'Paseo',url:'https://paseo.example/'},
    {title:'Google',url:'https://google.example/'},
    {title:'Paseo',url:'https://paseo.example/'},
  ];
  const {request,call,mcpLog}=await fixture(t,{view:{activeTargetId:'paseo',activeIndex:1,targets:pluginTargets},tabs:{tabs}});
  await request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
  const shot=await call('browser_take_screenshot',{});
  assert.equal(shot.isError,true);
  assert.match(text(shot),/多个共享标签页是这个地址/);
  const calls=await toolNames(mcpLog);
  assert.deepEqual(calls.map(entry=>entry.name),['browser_tabs'],'the list is read, then the call stops before select or the tool');
  assert.deepEqual(calls[0].arguments,{action:'list'});
});

test('the same URL is selected by title when exactly one of the matching tabs has it', {timeout:30000}, async t=>{
  const tabs:ScriptedTab[]=[
    {title:'服务器浏览器 · 互动体验',url:'about:blank'},
    {title:'Shared MCP proof',url:'about:blank'},
  ];
  const targets=[
    {id:'demo',index:0,title:'服务器浏览器 · 互动体验',url:'about:blank',active:false},
    {id:'proof',index:1,title:'Shared MCP proof',url:'about:blank',active:true},
  ];
  // The raw plugin index is 0, which is the demo page. The proof tab is the child's index 1.
  const {request,call,mcpLog}=await fixture(t,{view:{activeTargetId:'proof',activeIndex:0,targets},tabs:{tabs}});
  await request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
  assert.equal((await call('browser_take_screenshot',{})).isError,undefined);
  const calls=await toolNames(mcpLog);
  assert.deepEqual(calls[1].arguments,{action:'select',index:1});
  assert.equal(calls.at(-1)?.name,'browser_take_screenshot');
});

test('a parsed tab list with no URL match fails and the tool is not forwarded', {timeout:30000}, async t=>{
  const tabs:ScriptedTab[]=[{title:'Google',url:'https://google.example/'},{title:'Other',url:'https://other.example/'}];
  const {request,call,mcpLog}=await fixture(t,{view:{activeTargetId:'paseo',activeIndex:0,targets:pluginTargets},tabs:{tabs}});
  await request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
  const shot=await call('browser_take_screenshot',{});
  assert.equal(shot.isError,true);
  assert.match(text(shot),/不在共享浏览器的标签列表里/);
  const calls=await toolNames(mcpLog);
  assert.deepEqual(calls.map(entry=>entry.arguments?.action??entry.name),['list']);
  assert.equal(calls.some(entry=>entry.name==='browser_take_screenshot'),false);
});

test('the wrong current tab after select fails with tabsChanged and the tool is not forwarded', {timeout:30000}, async t=>{
  const {request,call,mcpLog}=await fixture(t,{view:{activeTargetId:'paseo',activeIndex:1,targets:pluginTargets},tabs:{tabs:childTabs,afterSelect:0}});
  await request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
  const shot=await call('browser_take_screenshot',{});
  assert.equal(shot.isError,true);
  assert.match(text(shot),/标签列表在操作前发生变化/);
  const calls=await toolNames(mcpLog);
  assert.deepEqual(calls.map(entry=>entry.name),['browser_tabs','browser_tabs','browser_tabs']);
  assert.deepEqual(calls[1].arguments,{action:'select',index:2});
  assert.equal(calls.some(entry=>entry.name==='browser_take_screenshot'),false);
});

test('a title containing ]( and a URL containing ) still select that child tab', {timeout:30000}, async t=>{
  const tabs:ScriptedTab[]=[
    {title:'Click ]( here',url:'https://other.example/a)b',suffix:' [crashed] [isolatedContext: reader]'},
    {title:'Wiki',url:'https://example.com/Foo_(bar)'},
  ];
  const targets=[{id:'wiki',index:0,title:'Wiki',url:'https://example.com/Foo_(bar)',active:false},{id:'tricky',index:1,title:'Click ]( here',url:'https://other.example/a)b',active:true}];
  // Plugin index 1 is the raw index. The child lists the tricky tab first, so the right index is 0.
  const {request,call,mcpLog}=await fixture(t,{view:{activeTargetId:'tricky',activeIndex:1,targets},tabs:{tabs}});
  await request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
  const shot=await call('browser_take_screenshot',{});
  assert.equal(shot.isError,undefined,text(shot));
  const calls=await toolNames(mcpLog);
  assert.deepEqual(calls.filter(entry=>entry.arguments?.action==='select').map(entry=>entry.arguments.index),[0]);
  assert.equal(calls.at(-1)?.name,'browser_take_screenshot');
});

test('a child that renders no tab list keeps the raw plugin index', {timeout:30000}, async t=>{
  const {request,call,mcpLog}=await fixture(t,{view:{activeTargetId:'paseo',activeIndex:1,targets:pluginTargets}});
  await request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
  const shot=await call('browser_take_screenshot',{});
  assert.equal(shot.isError,undefined,text(shot));
  const calls=await toolNames(mcpLog);
  assert.deepEqual(calls.map(entry=>entry.name),['browser_tabs','browser_tabs','browser_take_screenshot']);
  assert.deepEqual(calls[1].arguments,{action:'select',index:1});
});

test('the runtime\'s Playwright MCP takes the CDP address from PLAYWRIGHT_MCP_CDP_ENDPOINT, so the bridge can keep it out of argv', {timeout:60000}, async t=>{
  // A stand-in CDP endpoint that only records the discovery request MCP makes once a tool needs the browser.
  const hits:string[]=[];
  const server=createServer((request,response)=>{hits.push(request.url??'');response.writeHead(500);response.end();});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
  const endpoint=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const cli=path.join(defaultRuntimeRoot(),'node_modules','@playwright','mcp','cli.js');
  const child=spawn(process.execPath,[cli,'--headless'],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,HOME:process.env.HOME,PLAYWRIGHT_MCP_CDP_ENDPOINT:endpoint}});
  t.after(()=>{child.kill('SIGKILL');});
  let id=0;const pending=new Map<number,(value:any)=>void>();
  createInterface({input:child.stdout}).on('line',line=>{try{const message=JSON.parse(line);pending.get(message.id)?.(message);}catch{/* not JSON-RPC */}});
  const request=(method:string,params:unknown)=>new Promise<any>(resolve=>{const next=++id;pending.set(next,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:next,method,params})+'\n');});
  await request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  await request('tools/call',{name:'browser_tabs',arguments:{action:'list'}});
  assert.ok(hits.some(url=>url.startsWith('/json/version')),`Playwright MCP did not contact the endpoint from its environment: ${JSON.stringify(hits)}`);
});
