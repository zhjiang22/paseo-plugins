import { t } from '../shared/text';
import { bridgeBudgets, BUDGETS } from './budgets';
import { MCP_ENVIRONMENT } from './runtime';

/**
 * The MCP bridge an Agent runs, written into the plugin's data directory so plugin bundling need not retain source files.
 * runtimeRoot is baked in: the bridge starts Playwright MCP only from that runtime directory.
 */
export function bridgeScript(runtimeRoot:string):string{
 // Replacer functions: a "$" in a path must not be read as a replacement pattern.
 return bridgeSource
  .replace('__SERVER_BROWSER_RUNTIME_ROOT__',()=>JSON.stringify(runtimeRoot))
  .replace('__SERVER_BROWSER_BUDGETS__',()=>JSON.stringify(bridgeBudgets(BUDGETS)))
  .replace('__SERVER_BROWSER_MCP_ENVIRONMENT__',()=>JSON.stringify(MCP_ENVIRONMENT))
  .replace('__SERVER_BROWSER_TEXT__',()=>JSON.stringify(bridgeMessages()));
}

/** Resolved when the bridge starts and on every language change in its session metadata. */
export const bridgeMessages=()=>({
 metadataRequired:t('bridge.metadataRequired'),
 invalidSessionFile:t('bridge.invalidSessionFile'),
 sessionTooLarge:t('bridge.sessionTooLarge'),
 notRunning:t('bridge.notRunning'),
 loopbackRequired:t('bridge.loopbackRequired'),
 mcpMissing:t('bridge.mcpMissing'),
 mcpScriptRejected:t('bridge.mcpScriptRejected'),
 callFailed:t('bridge.callFailed'),
 mcpExited:t('bridge.mcpExited'),
 mcpUnavailable:t('bridge.mcpUnavailable'),
 toolTimeout:t('bridge.toolTimeout'),
 controlFailed:t('bridge.controlFailed'),
 pathsArray:t('bridge.pathsArray'),
 workspaceMissing:t('bridge.workspaceMissing'),
 invalidUploadPath:t('bridge.invalidUploadPath'),
 dialogFailed:t('bridge.dialogFailed'),
 inspectionFailed:t('bridge.inspectionFailed'),
 panelManaged:t('bridge.panelManaged'),
 unsafeTool:t('bridge.unsafeTool'),
 requestDetailsBlocked:t('bridge.requestDetailsBlocked'),
 unconfirmedTabIndex:t('bridge.unconfirmedTabIndex'),
 unconfirmedNavigation:t('bridge.unconfirmedNavigation'),
 targetClosed:t('bridge.targetClosed'),
 tabsUnreadable:t('bridge.tabsUnreadable'),
 tabsChanged:t('bridge.tabsChanged'),
 ambiguousTab:t('bridge.ambiguousTab'),
 tabNotListed:t('bridge.tabNotListed'),
 uploadMissing:t('bridge.uploadMissing'),
 uploadSymlink:t('bridge.uploadSymlink'),
 uploadNotRegular:t('bridge.uploadNotRegular'),
 uploadOutside:t('bridge.uploadOutside'),
 unsupportedTool:t('bridge.unsupportedTool'),
 selectionFailed:t('bridge.selectionFailed'),
});

export const bridgeSource = String.raw`import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {lstat,open,readFile,realpath,stat} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';

const runtimeRoot=__SERVER_BROWSER_RUNTIME_ROOT__;
const budgets=__SERVER_BROWSER_BUDGETS__;
const mcpEnvironment=__SERVER_BROWSER_MCP_ENVIRONMENT__;
let messages=__SERVER_BROWSER_TEXT__;
function text(id,params={}){return (messages[id]||id).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g,(whole,key)=>Object.hasOwn(params,key)?String(params[key]??''):whole);}
const metadataPath=process.argv[2];
if(!metadataPath) throw new Error(text('metadataRequired'));
// What Playwright MCP writes (screenshots, request and console files, downloads) is for the daemon user alone, whatever
// umask the Agent was started with.
process.umask(0o077);
const owner=randomUUID();
let metadata;
let child;
let ending=false;
let sequence=0;
let initializeParams;
let initialized=false;
let tabSnapshot=new Map();
const pending=new Map();
let queue=Promise.resolve();
function send(value){if(!ending)process.stdout.write(JSON.stringify(value)+'\n');}
// The plugin writes these files itself: never follow a symbolic link, never block on a FIFO, never read a large file.
async function readJson(file,maxBytes){
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const info=await handle.stat();if(!info.isFile()||info.size>maxBytes)throw new Error(text('invalidSessionFile'));
  const buffer=Buffer.alloc(maxBytes+1);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
  if(bytesRead>maxBytes)throw new Error(text('sessionTooLarge'));
  return JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'));
 }finally{await handle.close();}
}
function notRunning(){const missing=new Error(text('notRunning'));missing.code='ENOENT';return missing;}
// A session.json left by a crash, a kill or a reboot names ports anyone may hold now. It counts only while the Chromium it
// records still runs as this user with this workspace's Profile (the plugin's own check); Chromium may rewrite its argv to
// one space-separated process title.
async function browserRunning(value){
 const pid=value.browserPid;if(!Number.isInteger(pid)||pid<1)return false;
 try{
  process.kill(pid,0);
  const info=await lstat('/proc/'+pid);if(process.getuid&&info.uid!==process.getuid())return false;
  const command=await readFile('/proc/'+pid+'/cmdline','utf8'),args=command.split('\0'),spaced=' '+command.replace(/\0/g,' ')+' ';
  return ['--user-data-dir='+join(dirname(metadataPath),'profile'),'--remote-debugging-address=127.0.0.1'].every(argument=>args.includes(argument)||spaced.includes(' '+argument+' '));
 }catch{return false;}
}
async function readMetadata(){
 let value;
 // Metadata includes bounded user translations (up to 4,000 characters per bridge message).
 try{value=await readJson(metadataPath,1048576);}
 catch(error){if(error&&error.code==='ENOENT')throw notRunning();throw error;}
 if(value.text&&typeof value.text==='object')messages={...messages,...value.text};
 for(const key of ['endpoint','cdpEndpoint']){const url=new URL(value[key]);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw new Error(text('loopbackRequired'));}
 if(!await browserRunning(value))throw notRunning();
 return value;
}
// Saved intent next to the connection file: running, and not already out of automatic recovery attempts.
async function restoring(){
 try{const saved=await readJson(join(dirname(metadataPath),'state.json'),1048576);const recent=Array.isArray(saved.recoveryAttempts)?saved.recoveryAttempts.filter(time=>typeof time==='number'&&Date.now()-time<300000).length:0;return saved.desiredRunning===true&&recent<3;}
 catch{return false;}
}
// After a plugin reload or daemon restart the panel plugin restores browsers in the background, and an Agent
// session may start first. Wait a bounded time for the connection file instead of failing MCP startup.
async function awaitMetadata(timeoutMs){
 const deadline=Date.now()+timeoutMs;
 for(;;){
  try{return await readMetadata();}
  catch(error){if(!error||error.code!=='ENOENT'||Date.now()>=deadline||!(await restoring()))throw error;await new Promise(resolve=>setTimeout(resolve,250));}
 }
}
function inside(root,file){const path=relative(root,file);return path!==''&&path!=='..'&&!path.startsWith('..'+sep)&&!isAbsolute(path);}
// Only node_modules/@playwright/mcp/cli.js inside the runtime directory is started, whatever session.json says.
async function mcpCli(value){
 const expected=join(runtimeRoot,'node_modules','@playwright','mcp','cli.js');
 let real,wanted,root;
 try{[real,wanted,root]=await Promise.all([realpath(typeof value==='string'&&value?value:expected),realpath(expected),realpath(runtimeRoot)]);}
 catch{throw new Error(text('mcpMissing'));}
 if(real!==wanted||!inside(root,real))throw new Error(text('mcpScriptRejected'));
 return real;
}
// The workspace directory is Playwright MCP's file root and the only place uploads may come from.
async function workspaceRoot(){
 const value=metadata&&metadata.workspaceDirectory;if(typeof value!=='string'||!isAbsolute(value))return null;
 try{const real=await realpath(value);return (await stat(real)).isDirectory()?real:null;}catch{return null;}
}
function childEnvironment(){
 const names=new Set(mcpEnvironment.names),env={};
 for(const [key,value] of Object.entries(process.env))if(value!==undefined&&(names.has(key)||mcpEnvironment.prefixes.some(prefix=>key.startsWith(prefix))))env[key]=value;
 return env;
}
async function launch(value){
 const cli=await mcpCli(value.mcpCli);
 const previous=child;
 child=undefined;
 previous?.kill('SIGTERM');
 metadata=value;
 const cwd=await workspaceRoot();
 // The CDP address goes in the environment, which only the daemon user can read, not on the command line every local
 // account can list. (The port itself stays unauthenticated on 127.0.0.1; see the README's security notes.)
 const processChild=spawn(process.execPath,[cli,'--headless','--idle-timeout','0','--no-webmcp','--output-dir',metadata.artifactDir,'--timeout-action','15000','--timeout-navigation','45000'],{stdio:['pipe','pipe','pipe'],env:{...childEnvironment(),PLAYWRIGHT_MCP_CDP_ENDPOINT:metadata.cdpEndpoint},...(cwd?{cwd}:{})});
 child=processChild;
 processChild.stderr.on('data',chunk=>process.stderr.write(chunk));
 const output=createInterface({input:processChild.stdout});
 output.on('line',line=>{
  if(processChild!==child)return;
  let value;try{value=JSON.parse(line);}catch{return;}
  const item=pending.get(value.id);
  if(item){clearTimeout(item.timer);pending.delete(value.id);value.error?item.reject(new Error(value.error.message||text('callFailed'))):item.resolve(value.result);}
  else send(value);
 });
 function stopped(){if(processChild!==child)return;child=undefined;for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error(text('mcpExited')));}pending.clear();output.close();}
 processChild.on('error',error=>{process.stderr.write(error.message+'\n');stopped();});
 processChild.on('exit',stopped);
}
function callChild(method,params,timeoutMs){
 if(!child)return Promise.reject(new Error(text('mcpUnavailable')));
 const id='server-browser-internal-'+(++sequence);
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{pending.delete(id);reject(new Error(text('toolTimeout')));child?.kill('SIGTERM');},timeoutMs);
  pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
 });
}
async function ensureChild(){
 const fresh=await awaitMetadata(5000);
 if(child&&fresh.cdpEndpoint===metadata?.cdpEndpoint&&fresh.endpoint===metadata?.endpoint&&fresh.workspaceDirectory===metadata?.workspaceDirectory){metadata=fresh;return;}
 await launch(fresh);
 if(initializeParams){await callChild('initialize',initializeParams,budgets.mcpCallMs);if(initialized)child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');}
}
// Each route has its own wait, a little longer than the server spends on it, so a lease is never left with nobody holding it.
const controlTimeouts={read:budgets.readMs,diagnostics:budgets.readMs,tabs:budgets.tabsMs};
async function control(action,extra={}){
 const fresh=await readMetadata();
 const response=await fetch(fresh.endpoint+'/'+action,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+fresh.token},body:JSON.stringify({...extra,workspaceId:fresh.workspaceId,owner,pid:process.pid}),signal:AbortSignal.timeout(controlTimeouts[action]||budgets.controlMs)});
 const data=await response.json(); if(!response.ok)throw new Error(data.error||text('controlFailed')); return data;
}
// Playwright MCP 0.0.82 tools the shared browser offers. Any other tool, including ones a later MCP adds, is refused.
const readonlyTools=new Set(['browser_snapshot','browser_find','browser_wait_for','browser_take_screenshot','browser_console_messages','browser_network_requests','browser_network_request']);
const writeTools=new Set(['browser_navigate','browser_navigate_back','browser_click','browser_type','browser_fill_form','browser_press_key','browser_select_option','browser_hover','browser_drag','browser_drop','browser_file_upload','browser_handle_dialog','browser_evaluate','browser_resize','browser_emulate_media','browser_tabs']);
// These read local files and hand them to the page.
const fileTools=new Set(['browser_file_upload','browser_drop']);
// A request's own headers and body are never offered: they carry submitted passwords and page-set Authorization headers, and
// Playwright MCP keeps every request of a tab until it navigates that tab itself. Its full details view lists the headers too.
const responseParts=new Set(['response-headers','response-body']);
// Arbitrary Node.js in the Playwright MCP process is not a browsing tool: it would outlive manual takeover and act as the daemon user.
const unsafeTools=new Set(['browser_run_code_unsafe','browser_run_code']);
const serverInstructions='This MCP controls the shared browser running on the Linux server, visible in the Paseo Server Browser panel. Prefer it for shared-browser tasks; other browser servers have separate sessions. Manual takeover blocks writes and reading the page structure (browser_snapshot, browser_find, browser_wait_for), network and console: look with browser_take_screenshot and wait for the user, never bypass with shell or another browser. Request headers and bodies are not available; browser_network_request takes part response-headers or response-body. Use browser_read_page for article text and browser_diagnostics for page/network/login problems. Missing explicit tab targets fail instead of selecting another page. File uploads must be regular files inside the workspace directory.';
const extraTools=[
 {name:'browser_read_page',description:'Read the current or explicit shared tab as clean article Markdown or visible text, optionally filtered by literal text. No navigation or modification. Reports truncation and extraction method.',inputSchema:{type:'object',properties:{tabId:{type:'string'},mode:{type:'string',enum:['article','visible'],default:'article'},selector:{type:'string',maxLength:500},query:{type:'string',maxLength:200},maxChars:{type:'integer',minimum:500,maximum:60000,default:16000}},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false}},
 {name:'browser_diagnostics',description:'Inspect shared browser/runtime and visible network/login signals. Does not navigate, refresh or expose cookies. Accessible pages do not prove successful authentication.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false}},
];
function textResult(value){return {content:[{type:'text',text:typeof value==='string'?value:JSON.stringify(value,null,2)}]};}
function refusal(id,text){send({jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text}]}});}
function toolCatalog(result){return {...result,tools:[...(result.tools||[]).filter(t=>readonlyTools.has(t.name)||writeTools.has(t.name)).map(tool=>tool.name==='browser_handle_dialog'?{...tool,description:'Respond to the pending shared-page dialog. It stays open until explicitly accepted or dismissed; manual takeover blocks Agent responses.',inputSchema:{type:'object',properties:{accept:{type:'boolean'},promptText:{type:'string'},dialogId:{type:'string'}},required:['accept'],additionalProperties:false}}:tool.name==='browser_tabs'?{...tool,description:'List, create, select or close shared tabs. Prefer stable tabId from list for select/close. Index refers to the last listed snapshot; closed targets fail rather than selecting another page.',inputSchema:{...tool.inputSchema,properties:{...tool.inputSchema.properties,tabId:{type:'string',description:'Stable tab ID from browser_tabs list; preferred over index'}}}}:tool),...extraTools]};}
function rememberTabs(result){const tabs=result.tabs||result.session?.tabs||[];tabSnapshot=new Map(tabs.map((tab,index)=>[index,tab.id]));return result;}
// Playwright MCP numbers tabs in its own page-discovery order, which need not match the plugin's page order. Its
// browser_tabs list renders "- <index>: (current)? [title](url)" and may append " [crashed]" and
// " [isolatedContext: ...]" (renderTabsMarkdown). Titles and URLs are not escaped.
function parseTabLine(line){
 const head=/^- (\d+):( \(current\))? \[/.exec(line.replace(/\r$/,''));
 if(!head)return undefined;
 let body=line.replace(/\r$/,'').slice(head[0].length);
 const isolated=/ \[isolatedContext: [^\]]*\]$/.exec(body);
 if(isolated)body=body.slice(0,isolated.index);
 if(body.endsWith(' [crashed]'))body=body.slice(0,-' [crashed]'.length);
 // The closing ")" is the last one, so a URL may contain ")". The title/URL split is the last "](", so a title may contain "](".
 if(!body.endsWith(')'))return undefined;
 const inner=body.slice(0,-1),split=inner.lastIndexOf('](');
 if(split<0)return undefined;
 return {index:Number(head[1]),current:Boolean(head[2]),title:inner.slice(0,split),url:inner.slice(split+2)};
}
function tabEntries(result){
 const text=(result.content||[]).filter(item=>item&&item.type==='text').map(item=>item.text).join('\n'),tabs=[];
 for(const line of text.split('\n')){const tab=parseTabLine(line);if(tab)tabs.push(tab);}
 return tabs;
}
function withoutTrailingSlash(value){return value.endsWith('/')?value.slice(0,-1):value;}
function sameUrl(left,right){return left===right||withoutTrailingSlash(left)===withoutTrailingSlash(right);}
// Exact URL first, then one trailing slash. Several matches are not guessed: the first can still be the wrong
// same-URL tab, and the later (current) check would pass. A title that belongs to exactly one of them tells them
// apart. No parsed list at all (the bridge-policy stand-in answers with JSON) stays unparsed so the raw index remains.
function matchTab(tabs,target){
 if(!tabs.length)return {kind:'unparsed'};
 if(!target||typeof target.url!=='string')return {kind:'missing'};
 const url=target.url;
 const exact=tabs.filter(tab=>tab.url===url);
 const chosen=exact.length?exact:tabs.filter(tab=>withoutTrailingSlash(tab.url)===withoutTrailingSlash(url));
 if(chosen.length===1)return {kind:'match',index:chosen[0].index};
 if(!chosen.length)return {kind:'missing'};
 const title=typeof target.title==='string'?target.title:undefined;
 const titled=title===undefined?[]:chosen.filter(tab=>tab.title===title);
 if(titled.length===1)return {kind:'match',index:titled[0].index,title};
 return {kind:'ambiguous'};
}
// Every path must be a regular file (not a symbolic link) whose real path is inside the workspace directory.
// Relative paths are read from the workspace directory, as Playwright MCP does. The checked real paths are what MCP receives.
async function workspaceFiles(paths){
 if(!Array.isArray(paths))throw new Error(text('pathsArray'));
 const root=await workspaceRoot();
 if(!root)throw new Error(text('workspaceMissing'));
 const checked=[];
 for(const item of paths){
  if(typeof item!=='string'||!item||item.includes('\u0000'))throw new Error(text('invalidUploadPath'));
  const candidate=resolve(root,item);
  let info;try{info=await lstat(candidate);}catch{throw new Error(text('uploadMissing',{path:item}));}
  if(info.isSymbolicLink())throw new Error(text('uploadSymlink',{path:item}));
  if(!info.isFile())throw new Error(text('uploadNotRegular',{path:item}));
  const real=await realpath(candidate);
  if(!inside(root,real))throw new Error(text('uploadOutside',{path:item}));
  checked.push(real);
 }
 return checked;
}
function withoutRoots(params){const capabilities={...(params&&params.capabilities||{})};delete capabilities.roots;return {...params,capabilities};}
async function handle(message){
 if(!message.method){child?.stdin.write(JSON.stringify(message)+'\n');return;}
 if(message.method==='initialize'){
  // Playwright MCP resolves and confines file names against its working directory, the workspace; not the client's roots.
  initializeParams=withoutRoots(message.params);
  await launch(await awaitMetadata(Number(process.env.PASEO_SERVER_BROWSER_BRIDGE_WAIT_MS)||20000));
  const result=await callChild(message.method,initializeParams,budgets.mcpCallMs);
  send({jsonrpc:'2.0',id:message.id,result:{...result,instructions:serverInstructions+'\n'+(result.instructions||'')}});return;
 }
 if(message.method==='notifications/roots/list_changed')return;
 if(message.method!=='tools/call'){
  if(message.method==='notifications/initialized')initialized=true;
  await ensureChild();
  if(message.id!==undefined){const result=await callChild(message.method,message.params,budgets.mcpCallMs);send({jsonrpc:'2.0',id:message.id,result:message.method==='tools/list'?toolCatalog(result):result});}
  else child.stdin.write(JSON.stringify(message)+'\n');
  return;
 }
 const name=message.params?.name;
 const args=message.params?.arguments||{};
 if(name==='browser_handle_dialog'){
  try{const value=await control('dialog',{accept:args.accept,promptText:args.promptText,dialogId:args.dialogId});send({jsonrpc:'2.0',id:message.id,result:textResult(value)});}
  catch(error){refusal(message.id,error.message||text('dialogFailed'));}
  return;
 }
 if(name==='browser_diagnostics'||name==='browser_read_page'){
  try{const value=await control(name==='browser_diagnostics'?'diagnostics':'read',{...args,toolName:name});send({jsonrpc:'2.0',id:message.id,result:textResult(value)});}
  catch(error){refusal(message.id,error.message||text('inspectionFailed'));}
  return;
 }
 if(name==='browser_close'||name==='browser_install'){refusal(message.id,text('panelManaged'));return;}
 if(unsafeTools.has(name)){refusal(message.id,text('unsafeTool'));return;}
 if(!readonlyTools.has(name)&&!writeTools.has(name)){refusal(message.id,text('unsupportedTool',{name:String(name)}));return;}
 if(name==='browser_network_request'&&!responseParts.has(args.part)){refusal(message.id,text('requestDetailsBlocked'));return;}
 const write=!readonlyTools.has(name)&&!(name==='browser_tabs'&&args.action==='list');
 let lease;
 try{
  await ensureChild();
  let forwarded=args;
  if(fileTools.has(name)&&args.paths!==undefined)forwarded={...args,paths:await workspaceFiles(args.paths)};
  let tabId=args.tabId;
  if(name==='browser_tabs'&&['select','close'].includes(args.action)&&args.index!==undefined&&!tabId){
   if(!Number.isInteger(args.index)||!tabSnapshot.has(args.index))throw new Error(text('unconfirmedTabIndex'));
   tabId=tabSnapshot.get(args.index);
  }
  // The server checks the address with the panel's rules and returns the normalized one; MCP only ever gets that.
  lease=await control('acquire',{write,toolName:name,...(name==='browser_navigate'?{url:args.url}:{}),...(name==='browser_tabs'?{tabAction:args.action}:{}),...(tabId?{tabId}:{}),createTab:name==='browser_tabs'&&args.action==='new',closeTab:name==='browser_tabs'&&args.action==='close'});
  if(name==='browser_navigate'){if(typeof lease.url!=='string')throw new Error(text('unconfirmedNavigation'));forwarded={...args,url:lease.url};}
  if(name==='browser_tabs'){
   const result=await control('tabs',{leaseId:lease.leaseId,action:args.action,tabId,url:args.url});
   await control('release',{leaseId:lease.leaseId,failed:false});lease=undefined;
   send({jsonrpc:'2.0',id:message.id,result:textResult(rememberTabs(result))});return;
  }
  const selected=await control('validate',{leaseId:lease.leaseId});
  if(!Number.isInteger(selected.activeIndex)||selected.activeIndex<0)throw new Error(text('targetClosed'));
  // Populate Playwright MCP's lazy tab list before selecting an existing CDP target.
  const listing=await callChild('tools/call',{name:'browser_tabs',arguments:{action:'list'}},budgets.mcpInternalMs);
  if(listing.isError)throw new Error(text('tabsUnreadable'));
  // That list's index belongs to Playwright MCP's own page order, not the plugin's. Select the tab the list
  // identifies. A list that parsed but does not identify one tab fails before select, instead of falling back to the
  // plugin's index. Only a list this bridge cannot parse at all keeps the raw index, with no (current) check.
  const target=(selected.targets||[]).find(item=>item&&item.id===selected.activeTargetId);
  const matched=matchTab(tabEntries(listing),target);
  if(matched.kind==='ambiguous')throw new Error(text('ambiguousTab'));
  if(matched.kind==='missing')throw new Error(text('tabNotListed'));
  const selection=await callChild('tools/call',{name:'browser_tabs',arguments:{action:'select',index:matched.kind==='match'?matched.index:selected.activeIndex}},budgets.mcpInternalMs);
  if(selection.isError)throw new Error(text('selectionFailed',{error:(selection.content||[]).filter(item=>item.type==='text').map(item=>item.text).join('\n')}));
  // A URL match is checked against Playwright MCP's own (current) marker: that index, the target URL, and the title
  // when the title was what distinguished two tabs with the same URL. Otherwise the tool would run on another page.
  if(matched.kind==='match'){
   const relisting=await callChild('tools/call',{name:'browser_tabs',arguments:{action:'list'}},budgets.mcpInternalMs);
   if(relisting.isError)throw new Error(text('tabsUnreadable'));
   const current=tabEntries(relisting).find(item=>item.current);
   if(!current||current.index!==matched.index||!sameUrl(current.url,target.url)||(matched.title!==undefined&&current.title!==matched.title))throw new Error(text('tabsChanged'));
  }
  const validated=await control('validate',{leaseId:lease.leaseId});
  if(validated.activeTargetId!==selected.activeTargetId||validated.activeIndex!==selected.activeIndex)throw new Error(text('tabsChanged'));
  const result=await callChild(message.method,{...message.params,arguments:forwarded},budgets.mcpCallMs);
  await control('release',{leaseId:lease.leaseId,failed:result.isError===true});lease=undefined;
  send({jsonrpc:'2.0',id:message.id,result});
 }catch(error){refusal(message.id,error instanceof Error?error.message:text('callFailed'));}
 finally{if(lease)await control('release',{leaseId:lease.leaseId,failed:true}).catch(()=>{});}
}
const input=createInterface({input:process.stdin});
input.on('line',line=>{
 let value;try{value=JSON.parse(line);}catch{return;}
 // Replies to child-initiated requests must not sit behind the request waiting on them.
 if(!value.method){child?.stdin.write(JSON.stringify(value)+'\n');return;}
 queue=queue.then(()=>handle(value)).catch(error=>{if(value.id!==undefined)send({jsonrpc:'2.0',id:value.id,error:{code:-32603,message:error.message}});});
});
async function shutdown(){if(ending)return;ending=true;child?.kill('SIGTERM');await control('disconnect').catch(()=>{});input.close();}
input.on('close',()=>{void shutdown();});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void shutdown().finally(()=>process.exit(0));});
`;
