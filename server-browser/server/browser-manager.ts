import { onTextChange } from '../shared/i18n';
import { t } from '../shared/text';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, lstat, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import type { BrowserConnection as Browser, BrowserContext, BrowserPage as Page, BrowserCDPSession, BrowserDialog as PageDialog, BrowserFrame } from './browser-types';
import { browserSettingsSchema, readPageInputSchema, type BrowserAction, type BrowserFrameQuality, type BrowserFrameResult, type BrowserSession, type BrowserSettings, type BrowserHealth, type BrowserReading, type BrowserReadInput, type BrowserActivity, type BrowserTarget, type BrowserDialog, type BrowserDevicePreset, type BrowserOrphan, type BrowserInputEvent, type BrowserInputRequest, type BrowserInputResult } from '../shared/browser';
import { bridgeScript, bridgeMessages } from './bridge-source';
import { demoHtml, demoRefreshScript } from './demo';
import { maintainArtifacts } from './artifacts';
import { readPageContent } from './reading';
import { BrowserActivityLog, type ActivityPage } from './activity';
import { applyDeviceEmulation } from './device-emulation';
import { DEVICE_PRESETS } from '../shared/devices';
import { STALE_CONFIRMATION, assertManualTarget, needsManualTarget } from './manual-target';
import { captureBrowserFrame, frameScale, type FrameLimits } from './frame';
import { contentRevision, sessionRevision } from './revision';
import { fitPageWidth } from './page-fit';
import { browserProxy, browserSandboxMode, chromiumArguments, chromiumEnvironment, defaultRuntimeRoot, headlessShellExecutable, missingChromium, missingRuntime, type SandboxMode } from './runtime';
import { BUDGETS, withTimeout, type Budgets } from './budgets';
import { normalizeNavigationUrl, restorableUrl, withoutCredentials } from './navigation';
import { ensurePrivateDirectory, readPrivateJson } from './private-files';

export { normalizeNavigationUrl } from './navigation';
type PlaywrightRuntime={chromium:{connectOverCDP(endpoint:string,options?:{timeout?:number}):Promise<Browser>;executablePath():string}};
/**
 * expiresAt: revoked when not renewed in time. operation: an Agent tab change in progress; the lease outlives it.
 * sensitive: a read that can carry what the user types or sends while in control (see MANUAL_REFUSED_READS).
 */
type Lease={id:string;owner:string;pid:number;write:boolean;sensitive:boolean;targetId:string|null;epoch:number;activityId:string;activityTargetId:string|null;expiresAt:number;operation?:Promise<void>};
/** The Chromium that is running: whether its sandbox is on, and why not. */
type SandboxState={enabled:boolean;mode:SandboxMode;fallbackReason?:string};
type SavedTab={url:string;demo:boolean;pinned:boolean;active:boolean};
/**
 * loaderId: the main frame's current document; a same-document navigation (history API, fragment) keeps it.
 * frames: the document of every child frame in the tab's own renderer process (frame id → loaderId), to notice a frame that
 * loads a new one. remote: frames in another process (site isolation), each watched through a CDP session on its own target,
 * with the loaders of the frames in it; remoteChecks: such sessions being set up.
 * opened: how often the page replaced its own document in place (document.open(), a javascript: URL), part of documentScope.
 * replaced: frames whose document.open() was just handled, so the 'init' lifecycle event that follows is not counted again.
 * commits: called when the main frame commits a new document (a pending screenshot must start again).
 */
type RemoteFrame={cdp:BrowserCDPSession;frames:Map<string,string>;replaced:Set<string>};
type PageState={documentKey?:string;loaderId?:string;mainFrameId?:string;opened:number;frames:Map<string,string>;replaced:Set<string>;remote:Map<BrowserFrame,RemoteFrame>;remoteChecks:Set<Promise<void>>;commits:Set<()=>void>;url:string;title:string;demo:boolean;pinned:boolean;httpStatus:number|null;requestFailure:string|null};
type FrameTree={frame:{id?:string;loaderId:string;url:string;urlFragment?:string};childFrames?:FrameTree[]};
/** Frame id → loader for every frame in these trees. */
function loadersIn(nodes:FrameTree[]|undefined,into=new Map<string,string>()):Map<string,string>{for(const node of nodes??[]){if(node.frame.id&&node.frame.loaderId)into.set(node.frame.id,node.frame.loaderId);loadersIn(node.childFrames,into);}return into;}
type ControlInput={workspaceId?:string;owner?:string;pid?:number;write?:boolean;leaseId?:string;tabId?:string;tabIndex?:number;createTab?:boolean;closeTab?:boolean;mode?:string;selector?:string;query?:string;maxChars?:number;action?:string;url?:unknown;toolName?:string;tabAction?:string;failed?:boolean;dialogId?:string;accept?:boolean;promptText?:string};
/** label: the workspace's name when it was last seen, so its leftovers stay recognisable after the workspace is gone. */
type SavedState={version:2;desiredRunning:boolean;mode:BrowserSession['mode'];width:number;height:number;tabs:SavedTab[];settings:BrowserSettings;recoveryCount:number;lastRecoveredAt:number|null;lastFailure:string|null;recoveryAttempts:number[];devicePreset?:BrowserDevicePreset|'custom';label?:string|null};
type LiveSession={
 workspaceId:string;status:BrowserSession['status'];mode:BrowserSession['mode'];width:number;height:number;agentId:string|null;error:string|null;
 browser?:Browser;context?:BrowserContext;child?:ChildProcess;cdpEndpoint?:string;
 pages:Map<string,Page>;pageState:Map<string,PageState>;pendingPages:Map<Page,Promise<string>>;trackTail:Promise<void>;activeId:string|null;
 starting?:Promise<void>;loading?:Promise<void>;tail:Promise<void>;persistTail:Promise<void>;loaded:boolean;desiredRunning:boolean;settings:BrowserSettings;savedTabs:SavedTab[];
 frameTask?:Promise<BrowserFrameResult['frame']>;resizing?:Promise<void>;lastFrame?:NonNullable<BrowserFrameResult['frame']>;frameKey?:string;frameTabId?:string;
 leases:Map<string,Lease>;controlPending:boolean;manualOps:number;stopping:boolean;generation:number;epoch:number;health:BrowserHealth|null;uptimeStart:number|null;
 token:Buffer|null;sandbox:SandboxState|null;viewRevision:string;devicePreset:BrowserDevicePreset|'custom';deviceWidth:number;deviceHeight:number;pageCdp:Map<string,BrowserCDPSession>;viewers:Map<string,number>;dialog:BrowserDialog|null;dialogHandle?:PageDialog;pendingDialogs:Map<string,{snapshot:BrowserDialog;handle:PageDialog}>;dialogWaiters:Set<()=>void>;agentAvailability?:BrowserSession['agentAvailability'];
 /**
  * inputEpoch: bumped by everything that ends a viewer's live input stream (Agent turns, dialogs, tab changes, a new document
  * in any frame, another viewer's input). inputStream: who sent live input last, and its last batch. inputSeqs: the last
  * batch of each recent viewer, so a viewer's older batch is refused even after another viewer typed in between.
  * inputSeqFloor: the highest last batch of viewers dropped from inputSeqs; a viewer not remembered must send above it.
  */
 inputEpoch:number;inputStream:{viewerId:string;seq:number}|null;inputSeqs:Map<string,number>;inputSeqFloor:number;browserVersion:string;label:string|null;
 activity:BrowserActivityLog;recoveryCount:number;lastRecoveredAt:number|null;lastFailure:string|null;recoveryAttempts:number[];recoveryTimer?:ReturnType<typeof setTimeout>;
 persistTimer?:ReturnType<typeof setTimeout>;artifactTask?:Promise<void>;artifactBytes:number;artifactCount:number;cleanedArtifacts:number;
};
/** budgets and now exist for tests: shorter limits and an injected clock for lease expiry. */
export type BrowserManagerOptions={runtimeRoot?:string;dataRoot?:string;executablePath?:string;budgets?:Partial<Budgets>;now?:()=>number};
export type BrowserDiagnostics={session:BrowserSession;checks:{name:string;status:'ok'|'warning'|'error';detail:string}[];health:BrowserHealth};
const DEFAULT_SETTINGS:BrowserSettings={autoRecover:true,maxTabs:20,maxArtifactMB:256,artifactMaxAgeHours:48};
const FRAME_QUALITY:Record<BrowserFrameQuality,{quality:number;cache:number}>={smooth:{quality:35,cache:180},balanced:{quality:55,cache:450},sharp:{quality:80,cache:900}};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const safeId=(id:string)=>{if(!/^[A-Za-z0-9_-]{1,120}$/.test(id))throw new Error(t('serverError.invalidWorkspace'));return id;};
/** A message without page addresses: any `scheme://…` (query, fragment and redirect target included) becomes [网页地址]. */
export const withoutAddresses=(error:unknown)=>(error instanceof Error?error.message:String(error??'')).replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi,()=>t('serverError.redactedAddress'))||t('serverError.operationFailed');
/** An error as the panel, the Agent and saved state see it: common failures in words, page addresses replaced, at most 220 characters. */
export const safeFailure=(error:unknown)=>{
 const text=error instanceof Error?error.message:String(error??'');
 if(/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(text))return t('serverError.dnsFailed');
 if(/CERT_|SSL_|TLS|certificate/i.test(text))return t('serverError.tlsFailed');
 if(/timed? ?out|Timeout/i.test(text))return t('serverError.connectionTimeout');
 if(/ERR_CONNECTION|ECONN|ENETUNREACH|ERR_INTERNET|ERR_PROXY/i.test(text))return t('serverError.networkFailed');
 return withoutAddresses(text).slice(0,220);
};
const AGENT_ID=/^[A-Za-z0-9._:-]{1,128}$/;
/**
 * Playwright MCP reads that can carry what the user types or sends while in control: the page structure (its accessibility
 * snapshots show the values of form fields, password fields included), network requests and console messages. While the user
 * is in control they are refused like writes, decided here by tool name, so an Agent session still running an older bridge is
 * covered too. Screenshots, the plugin's reader (form fields left out) and diagnostics stay allowed.
 */
const MANUAL_REFUSED_READS=new Set(['browser_snapshot','browser_find','browser_wait_for','browser_network_requests','browser_network_request','browser_console_messages']);
const MANUAL_READ=()=>t('serverError.manualRead');
const sandboxFailure=(log:string)=>/No usable sandbox/i.test(log)?t('runtime.sandboxUnavailable'):/Running as root/i.test(log)?t('runtime.sandboxRoot'):t('runtime.sandboxStartFailed');

export class BrowserManager{
 readonly runtimeRoot:string;readonly dataRoot:string;readonly bridgePath:string;
 private stopText:()=>void;
 private sessions=new Map<string,LiveSession>();private gate?:Server;private gateEndpoint?:string;private gateStarting?:Promise<void>;
 private retired=new Set<string>();private retiring=new Map<string,Promise<void>>();
 private disposed=false;private runtime?:PlaywrightRuntime;private executableOverride?:string;
 private maintenanceTimer?:ReturnType<typeof setInterval>;private restoring?:Promise<void>;
 private readonly budgets:Budgets;private readonly now:()=>number;
 /** Workspace directories from the daemon, for session.json: the bridge confines file uploads to them. */
 private workspaceDirectories=new Map<string,string>();
 /** Workspace names from the daemon, saved with the state so a gone workspace's leftovers can be told apart. */
 private workspaceLabels=new Map<string,string>();
 /** In automatic mode, set once Chromium failed to start with its sandbox and started without it on this host. */
 private sandboxUnavailable:string|null=null;
 constructor(options:BrowserManagerOptions={}){
  this.stopText=onTextChange(()=>{for(const session of this.sessions.values()){session.health=null;void this.writeMetadata(session).catch(()=>{});void this.refreshDemoText(session);}});
  this.runtimeRoot=options.runtimeRoot??defaultRuntimeRoot();
  this.dataRoot=options.dataRoot??(process.env.PASEO_SERVER_BROWSER_DATA||path.join(this.runtimeRoot,'visual'));this.bridgePath=path.join(this.dataRoot,'mcp-bridge.mjs');
  this.executableOverride=options.executablePath??process.env.PASEO_SERVER_BROWSER_EXECUTABLE;
  this.budgets={...BUDGETS,...options.budgets};this.now=options.now??Date.now;
 }
 /** A language change updates plugin-owned demo labels in place, leaving website and user content alone. */
 private async refreshDemoText(session:LiveSession):Promise<void>{
  for(const [id,page] of session.pages){
   if(!session.pageState.get(id)?.demo||page.isClosed())continue;
   try{if(await withTimeout(page.evaluate<boolean>(demoRefreshScript()),this.budgets.diagnosticsScriptMs,()=>false)){const info=session.pageState.get(id);if(info)info.title=t('demo.title');this.invalidateView(session);}}catch{}
  }
 }
 /** Called with the daemon's workspace descriptor whenever the panel or a restore confirms a workspace. */
 setWorkspaceDirectory(workspaceId:string,directory:string,label?:string|null):void{
  safeId(workspaceId);
  const name=label?.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,160);if(name)this.workspaceLabels.set(workspaceId,name);
  if(!path.isAbsolute(directory)||this.workspaceDirectories.get(workspaceId)===directory)return;
  this.workspaceDirectories.set(workspaceId,directory);
  const session=this.sessions.get(workspaceId);if(session?.status==='running'&&!session.stopping)void this.writeMetadata(session).catch(()=>{});
 }
 metadataPath(workspaceId:string):string{return path.join(this.dataRoot,safeId(workspaceId),'session.json');}
 private statePath(workspaceId:string):string{return path.join(this.dataRoot,safeId(workspaceId),'state.json');}
 private artifactDir(workspaceId:string):string{return path.join(this.dataRoot,safeId(workspaceId),'artifacts');}
 private session(workspaceId:string,allowRetired=false):LiveSession{
  safeId(workspaceId);if(this.retired.has(workspaceId)&&!allowRetired)throw new Error(t('serverError.workspaceArchived'));let session=this.sessions.get(workspaceId);
  if(!session){session={workspaceId,status:'idle',mode:'manual',width:1120,height:720,agentId:null,error:null,pages:new Map(),pageState:new Map(),pendingPages:new Map(),trackTail:Promise.resolve(),activeId:null,tail:Promise.resolve(),persistTail:Promise.resolve(),loaded:false,desiredRunning:false,settings:{...DEFAULT_SETTINGS},savedTabs:[],leases:new Map(),controlPending:false,manualOps:0,stopping:false,generation:0,epoch:0,health:null,uptimeStart:null,token:null,sandbox:null,viewRevision:randomUUID(),devicePreset:'custom',deviceWidth:1120,deviceHeight:720,pageCdp:new Map(),viewers:new Map(),dialog:null,pendingDialogs:new Map(),dialogWaiters:new Set(),inputEpoch:0,inputStream:null,inputSeqs:new Map(),inputSeqFloor:0,browserVersion:'',label:null,activity:new BrowserActivityLog(),recoveryCount:0,lastRecoveredAt:null,lastFailure:null,recoveryAttempts:[],artifactBytes:0,artifactCount:0,cleanedArtifacts:0};this.sessions.set(workspaceId,session);}return session;
 }
 private activityPage(session:LiveSession,tabId:string|null):ActivityPage{
  const page=tabId?session.pages.get(tabId):undefined,info=tabId?session.pageState.get(tabId):undefined;
  return {tabId,pageTitle:info?.title??'',pageUrl:page&&!page.isClosed()?page.url():info?.url??''};
 }
 private async finishActivity(session:LiveSession,id:string,failed:boolean,tabId:string|null):Promise<void>{
  const page=tabId?session.pages.get(tabId):undefined,info=tabId?session.pageState.get(tabId):undefined;
  let metadata:ActivityPage|undefined;
  if(page&&!page.isClosed()){
   metadata=this.activityPage(session,tabId);let timer:ReturnType<typeof setTimeout>|undefined;
   try{metadata.pageTitle=await Promise.race([page.title().catch(()=>metadata!.pageTitle),new Promise<string>(resolve=>{timer=setTimeout(()=>resolve(metadata!.pageTitle),200);})]);}finally{if(timer)clearTimeout(timer);}
  }else if(info)metadata=this.activityPage(session,tabId);
  session.activity.finish(id,failed,metadata);
 }
 private async load(session:LiveSession):Promise<void>{
  if(session.loading)return session.loading;if(session.loaded)return;
  session.loading=this.loadSavedState(session);
  try{await session.loading;}finally{session.loaded=true;session.loading=undefined;}
 }
 private async loadSavedState(session:LiveSession):Promise<void>{
  try{
   const file=this.statePath(session.workspaceId),info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())return;
   const saved=await readPrivateJson(file,1_048_576) as Partial<SavedState>;
   if(saved.version!==2)return;
   session.desiredRunning=saved.desiredRunning===true;session.mode=saved.mode==='agent'?'agent':'manual';
   session.width=Number.isInteger(saved.width)&&saved.width!>=320&&saved.width!<=2560?saved.width!:1120;
   session.height=Number.isInteger(saved.height)&&saved.height!>=320&&saved.height!<=1600?saved.height!:720;
   session.deviceWidth=session.width;session.deviceHeight=session.height;
   session.devicePreset=saved.devicePreset&&['desktop','iphone','pixel','ipad','custom'].includes(saved.devicePreset)?saved.devicePreset:'custom';
   session.settings=browserSettingsSchema.parse({...DEFAULT_SETTINGS,...saved.settings});
   session.savedTabs=Array.isArray(saved.tabs)?saved.tabs.slice(0,session.settings.maxTabs).flatMap(tab=>{const url=restorableUrl(tab.url);return url||tab.demo?[{url:url??'about:blank',demo:!url,pinned:tab.pinned===true,active:tab.active===true}]:[]}):[];
   session.recoveryCount=Number.isInteger(saved.recoveryCount)&&saved.recoveryCount!>=0?saved.recoveryCount!:0;
   session.lastRecoveredAt=typeof saved.lastRecoveredAt==='number'?saved.lastRecoveredAt:null;session.lastFailure=typeof saved.lastFailure==='string'?safeFailure(saved.lastFailure):null;
   session.recoveryAttempts=Array.isArray(saved.recoveryAttempts)?saved.recoveryAttempts.filter(value=>typeof value==='number'&&Date.now()-value<300_000):[];
   session.label=typeof saved.label==='string'?saved.label.slice(0,160):null;
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')session.error=t('serverError.savedStateUnreadable');}
  // A small regular file with a well-formed Agent id; anything else is ignored.
  try{const saved=await readPrivateJson(path.join(path.dirname(this.metadataPath(session.workspaceId)),'agent.json'),4096) as {agentId?:unknown};if(typeof saved?.agentId==='string'&&AGENT_ID.test(saved.agentId))session.agentId=saved.agentId;}catch{}
 }
 private rememberTabs(session:LiveSession):void{
  if(!session.pages.size)return;
  session.savedTabs=[...session.pages.entries()].flatMap(([id,page])=>{if(page.isClosed())return [];const state=session.pageState.get(id),url=restorableUrl(page.url());return url||state?.demo?[{url:url??'about:blank',demo:!url,pinned:state?.pinned??false,active:id===session.activeId}]:[];});
 }
 private async persist(session:LiveSession):Promise<void>{
  if(session.persistTimer){clearTimeout(session.persistTimer);session.persistTimer=undefined;}
  if(!session.stopping)this.rememberTabs(session);
  session.label=this.workspaceLabels.get(session.workspaceId)??session.label;
  const saved:SavedState={version:2,desiredRunning:session.desiredRunning,mode:session.mode,width:session.deviceWidth,height:session.deviceHeight,devicePreset:session.devicePreset,tabs:session.savedTabs,settings:session.settings,recoveryCount:session.recoveryCount,lastRecoveredAt:session.lastRecoveredAt,lastFailure:session.lastFailure,recoveryAttempts:session.recoveryAttempts,label:session.label};
  const content=JSON.stringify(saved)+'\n';const operation=session.persistTail.then(()=>this.atomicPrivate(this.statePath(session.workspaceId),content));session.persistTail=operation.catch(()=>{});await operation;
 }
 private schedulePersist(session:LiveSession):void{
  if(this.disposed||session.stopping||session.status==='starting'||session.status==='recovering')return;
  if(session.persistTimer)clearTimeout(session.persistTimer);session.persistTimer=setTimeout(()=>{session.persistTimer=undefined;void this.persist(session).catch(()=>{});},250);session.persistTimer.unref?.();
 }
 private playwright():PlaywrightRuntime{
  if(!this.runtime){
   const load=createRequire(path.join(this.runtimeRoot,'package.json'));
   try{this.runtime=load('playwright') as PlaywrightRuntime;}catch(error){if((error as NodeJS.ErrnoException).code==='MODULE_NOT_FOUND')throw new Error(missingRuntime(this.runtimeRoot));throw error;}
  }
  return this.runtime;
 }
 private async executable():Promise<string>{
  if(this.executableOverride){try{await access(this.executableOverride);}catch{throw new Error(t('runtime.executableMissing'));}return this.executableOverride;}
  const cache=process.env.PLAYWRIGHT_BROWSERS_PATH??path.join(homedir(),'.cache/ms-playwright');
  const shell=headlessShellExecutable(),candidates=shell?(await readdir(cache).catch(()=>[] as string[])).filter(item=>/^chromium_headless_shell-\d+$/.test(item)).sort((a,b)=>Number(b.split('-').at(-1))-Number(a.split('-').at(-1))):[];
  for(const candidate of candidates){const file=path.join(cache,candidate,shell!);try{await access(file);return file;}catch{}}
  const file=this.playwright().chromium.executablePath();try{await access(file);}catch{throw new Error(missingChromium());}return file;
 }
 private async atomicPrivate(file:string,content:string):Promise<void>{const directory=path.dirname(file);await ensurePrivateDirectory(directory,directory===this.dataRoot?t('runtime.dataDirectory'):t('runtime.workspaceDirectory'));const tmp=`${file}.${randomUUID()}.tmp`;await writeFile(tmp,content,{mode:0o600});await rename(tmp,file);await chmod(file,0o600);}
 /** session.json: everything the Agent bridge needs, with a token that only works for this workspace's browser. */
 private async writeMetadata(session:LiveSession):Promise<void>{
  if(!session.cdpEndpoint||!this.gateEndpoint||!session.token)return;
  await this.atomicPrivate(this.metadataPath(session.workspaceId),JSON.stringify({version:2,text:bridgeMessages(),workspaceId:session.workspaceId,endpoint:this.gateEndpoint,token:session.token.toString('hex'),cdpEndpoint:session.cdpEndpoint,mcpCli:path.join(this.runtimeRoot,'node_modules/@playwright/mcp/cli.js'),artifactDir:this.artifactDir(session.workspaceId),workspaceDirectory:this.workspaceDirectories.get(session.workspaceId)??null,browserPid:session.child?.pid,epoch:session.epoch})+'\n');
 }
 private async ensureGate():Promise<void>{
  if(this.disposed)throw new Error(t('serverError.pluginClosing'));if(this.gateEndpoint)return;if(this.gateStarting)return this.gateStarting;
  this.gateStarting=(async()=>{
   await ensurePrivateDirectory(this.dataRoot,t('runtime.dataDirectory'));await this.atomicPrivate(this.bridgePath,bridgeScript(this.runtimeRoot));
   const server=createServer((request,response)=>{void this.handleControl(request,response);});this.gate=server;
   await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
   const address=server.address();if(!address||typeof address==='string')throw new Error(t('serverError.controlStartFailed'));this.gateEndpoint=`http://127.0.0.1:${address.port}`;
   this.maintenanceTimer=setInterval(()=>{for(const session of this.sessions.values())void this.cleanArtifacts(session).catch(()=>{});},5*60_000);this.maintenanceTimer.unref?.();
  })();try{await this.gateStarting;}finally{this.gateStarting=undefined;}
 }
 /** A lease ends when its bridge process is gone or when it was not renewed in time, but never while a tab change it started still runs. */
 private purgeLeases(session:LiveSession):void{
  const now=this.now();
  for(const [id,lease]of session.leases){
   if(lease.operation)continue;
   let gone=lease.expiresAt<=now;
   if(!gone){try{process.kill(lease.pid,0);}catch(error){gone=(error as NodeJS.ErrnoException).code==='ESRCH';}}
   if(gone)this.revokeLease(session,id);
  }
 }
 private revokeLease(session:LiveSession,id:string):void{const lease=session.leases.get(id);if(!lease)return;session.activity.finish(lease.activityId,true);session.leases.delete(id);}
 private agentBusy(session:LiveSession):boolean{this.purgeLeases(session);return session.leases.size>0||session.controlPending;}
 /** The page title, or the last known one when the page does not answer in time (for example while a script blocks it). */
 private pageTitle(session:LiveSession,id:string,page:Page):Promise<string>{const known=session.pageState.get(id)?.title??'';if([...session.pendingDialogs.values()].some(item=>item.snapshot.tabId===id))return Promise.resolve(known);return withTimeout(page.title().catch(()=>known),this.budgets.titleMs,()=>known);}
 private async targets(session:LiveSession):Promise<{id:string;index:number;title:string;url:string;active:boolean;pinned:boolean}[]>{await this.syncPages(session);const pages=session.context?.pages()??[];return (await Promise.all([...session.pages].filter(([,page])=>!page.isClosed()).map(async([id,page])=>({id,index:pages.indexOf(page),title:await this.pageTitle(session,id,page),url:withoutCredentials(page.url()),active:session.activeId===id,pinned:session.pageState.get(id)?.pinned??false})))).filter(target=>target.index>=0).sort((a,b)=>a.index-b.index);}
 private async leaseView(session:LiveSession,lease:Lease){
  const targets=await this.targets(session);const target=lease.targetId?targets.find(item=>item.id===lease.targetId):null;
  if(lease.targetId&&!target)throw new Error(t('serverError.targetClosed'));
  return {leaseId:lease.id,activeTargetId:lease.targetId,activeIndex:target?.index??-1,epoch:session.epoch,targets,maxTabs:session.settings.maxTabs,tabCount:targets.length};
 }
 /** The workspace browser a control token belongs to. Each running browser has its own token, compared in constant time. */
 private sessionForToken(header:string|undefined):LiveSession|undefined{
  const match=/^Bearer ([0-9a-f]{64})$/.exec(header??'');if(!match)return undefined;
  const given=Buffer.from(match[1],'hex');let found:LiveSession|undefined;
  for(const session of this.sessions.values())if(session.token&&timingSafeEqual(session.token,given))found=session;
  return found;
 }
 /** Server work behind one control request ends before the bridge stops waiting, so the bridge always gets an answer. */
 private serverWork<T>(operation:Promise<T>):Promise<T>{return withTimeout(operation,this.budgets.controlServerMs,()=>{throw new Error(t('serverError.unresponsive'));});}
 private async handleControl(request:IncomingMessage,response:ServerResponse):Promise<void>{
  const reply=(status:number,value:unknown)=>{if(response.destroyed)return;response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify(value));};
  try{
   const session=request.method==='POST'?this.sessionForToken(request.headers.authorization):undefined;
   if(!session){reply(401,{error:t('serverError.unauthorized')});return;}
   let body='';for await(const chunk of request){body+=chunk.toString();if(body.length>32768){reply(413,{error:t('serverError.requestTooLarge')});return;}}
   const input=JSON.parse(body) as ControlInput;
   // A token only works for its own workspace's browser.
   if(input.workspaceId!==session.workspaceId){reply(403,{error:t('serverError.forbidden')});return;}
   if(session.status!=='running'||session.stopping){reply(409,{error:t('serverError.notReady')});return;}
   if(!input.owner||typeof input.owner!=='string'||!Number.isInteger(input.pid)||input.pid!<=0){reply(400,{error:t('serverError.invalidOwner')});return;}
   this.purgeLeases(session);const route=request.url;
   if(route==='/read'){reply(200,await this.read(session.workspaceId,readPageInputSchema.parse({...input,workspaceId:session.workspaceId}),'agent'));return;}
   if(route==='/diagnostics'){reply(200,await this.diagnostics(session.workspaceId,'agent'));return;}
   if(route==='/dialog'){
    if(session.mode!=='agent')throw new Error(t('serverError.manualDialog'));
    if(typeof input.accept!=='boolean'||(input.promptText!==undefined&&(typeof input.promptText!=='string'||input.promptText.length>10000)))throw new Error(t('serverError.invalidDialog'));
    const pending=session.dialog;if(!pending)throw new Error(t('serverError.noDialog'));
    if(input.dialogId&&input.dialogId!==pending.id)throw new Error(t('serverError.dialogChanged'));
    reply(200,await this.handleDialog(session,pending.id,input.accept,input.promptText,'agent'));return;
   }
   if(route==='/acquire'){
    if(input.url!==undefined&&typeof input.url!=='string')throw new Error(t('navigation.invalidAddress'));
    // Agent navigation follows the panel's address rules; the bridge hands Playwright MCP only this normalized address.
    const url=input.url!==undefined?normalizeNavigationUrl(input.url):undefined;
    if(input.write&&session.mode!=='agent')throw new Error(t('serverError.manualWrite'));
    const sensitive=typeof input.toolName==='string'&&MANUAL_REFUSED_READS.has(input.toolName);
    if(sensitive&&session.mode!=='agent')throw new Error(MANUAL_READ());
    if(this.agentBusy(session)||session.manualOps>0)throw new Error(t('serverError.otherOperation'));
    session.controlPending=true;
    // A bridge that stopped waiting closes its request; it must not be left holding a lease it never received.
    let abandoned=false;response.once('close',()=>{abandoned=true;});
    const lease:Lease={id:randomUUID(),owner:input.owner,pid:input.pid!,write:Boolean(input.write),sensitive,targetId:null,epoch:session.epoch,activityId:'',activityTargetId:null,expiresAt:0};
    const failedActivity=()=>session.activity.finish(session.activity.start('agent',input.toolName,this.activityPage(session,lease.activityTargetId),input.tabAction),true);
    try{
     let view:Awaited<ReturnType<BrowserManager['leaseView']>>;
     try{
      view=await this.serverWork((async()=>{
       await this.syncPages(session);
       if(input.write&&session.mode!=='agent')throw new Error(t('serverError.manualStoppedWrite'));
       if(sensitive&&session.mode!=='agent')throw new Error(MANUAL_READ());
       if(input.createTab&&session.pages.size>=session.settings.maxTabs)throw new Error(t('serverError.maxTabsAgent',{count:session.settings.maxTabs}));
       const target=input.tabId?this.requirePage(session,input.tabId):this.activePage(session);
       if(input.closeTab&&input.tabId&&session.pageState.get(input.tabId)?.pinned)throw new Error(t('serverError.pinnedPanelClose'));
       lease.targetId=target?this.pageId(session,target):null;lease.activityTargetId=input.createTab?null:lease.targetId;lease.epoch=session.epoch;
       return this.leaseView(session,lease);
      })());
     }catch(error){failedActivity();throw error;}
     if(abandoned||response.destroyed){failedActivity();return;}
     lease.activityId=session.activity.start('agent',input.toolName,this.activityPage(session,lease.activityTargetId),input.tabAction);
     if(lease.write)this.endInputStream(session);
     lease.expiresAt=this.now()+this.budgets.leaseTtlMs;session.leases.set(lease.id,lease);
     response.once('close',()=>{if(!response.writableFinished)this.revokeLease(session,lease.id);});
     reply(200,{...view,...(url?{url}:{})});
    }finally{session.controlPending=false;}return;
   }
   if(route==='/validate'){
    const lease=input.leaseId?session.leases.get(input.leaseId):undefined;if(!lease||lease.owner!==input.owner)throw new Error(t('serverError.leaseExpired'));
    if(lease.write&&session.mode!=='agent')throw new Error(t('serverError.manualStoppedWrite'));
    if(lease.sensitive&&session.mode!=='agent')throw new Error(MANUAL_READ());
    const view=await this.serverWork(this.leaseView(session,lease));
    // Validation comes right before each Playwright MCP call, so it renews the lease for that call.
    lease.expiresAt=this.now()+this.budgets.leaseTtlMs;reply(200,view);return;
   }
   if(route==='/tabs'){
    const lease=input.leaseId?session.leases.get(input.leaseId):undefined;if(!lease||lease.owner!==input.owner)throw new Error(t('serverError.leaseExpired'));
    if(input.action!=='list'&&(!lease.write||session.mode!=='agent'))throw new Error(t('serverError.manualStoppedTabs'));
    if(lease.operation)throw new Error(t('serverError.operationRunning'));
    // The lease stays until the tab change itself has finished or timed out, even if the bridge stops waiting.
    const operation=this.changeTabs(session,lease,input);lease.operation=operation.then(()=>{},()=>{});
    try{reply(200,await operation);}finally{lease.operation=undefined;lease.expiresAt=this.now()+this.budgets.leaseTtlMs;}return;
   }
   if(route==='/release'){
    const lease=input.leaseId?session.leases.get(input.leaseId):undefined;
    if(lease?.owner===input.owner){
     if(lease.operation)await lease.operation;
     if(lease.write)this.endInputStream(session);
     let failed=input.failed===true;
     try{await this.serverWork((async()=>{
      await this.syncPages(session);
      const switching=input.tabId!==undefined||input.tabIndex!==undefined;
      if(switching&&(!lease.write||session.mode!=='agent'))throw new Error(t('serverError.agentSwitchOnly'));
      if(input.tabId){this.requirePage(session,input.tabId);session.activeId=input.tabId;}
      else if(Number.isInteger(input.tabIndex)){const page=session.context?.pages()[input.tabIndex!];if(!page)throw new Error(t('serverError.selectedTabClosed'));session.activeId=this.pageId(session,page);}
      session.lastFrame=undefined;await this.persist(session);
     })());}catch(error){failed=true;throw error;}finally{await this.finishActivity(session,lease.activityId,failed,lease.activityTargetId);session.leases.delete(lease.id);}
    }
    reply(200,{ok:true});return;
   }
   if(route==='/disconnect'){
    const owned=[...session.leases.values()].filter(lease=>lease.owner===input.owner);
    await Promise.all(owned.map(lease=>lease.operation));for(const lease of owned)this.revokeLease(session,lease.id);
    reply(200,{ok:true});return;
   }
   reply(404,{error:t('serverError.notFound')});
  }catch(error){reply(409,{error:safeFailure(error)});}
 }
 /** An Agent's browser_tabs action. A new tab's page gets the same navigation time limit as the bridge budget allows. */
 private async changeTabs(session:LiveSession,lease:Lease,input:ControlInput){
  await this.syncPages(session);
  session.activity.update(lease.activityId,this.activityPage(session,lease.activityTargetId),input.action);
  if(input.action==='new'){
   if(input.url!==undefined&&typeof input.url!=='string')throw new Error(t('navigation.invalidAddress'));
   const url=input.url!==undefined?normalizeNavigationUrl(input.url):null;
   if(session.pages.size>=session.settings.maxTabs)throw new Error(t('serverError.maxTabs',{count:session.settings.maxTabs}));
   const page=await session.context!.newPage();session.activeId=await this.trackPage(session,page);lease.activityTargetId=session.activeId;if(url)await page.goto(url,{waitUntil:'domcontentloaded',timeout:this.budgets.tabNavigationMs});else await page.setContent(demoHtml(),{waitUntil:'domcontentloaded'});
  }else if(input.action==='select'||input.action==='close'){
   const tabId=input.tabId??(input.action==='close'?lease.targetId:null);
   if(!tabId)throw new Error(t('serverError.tabIdRequired'));const page=this.requirePage(session,tabId);
   lease.activityTargetId=tabId;
   if(input.action==='select'){session.activeId=tabId;await page.bringToFront();}
   else{if(session.pageState.get(tabId)?.pinned)throw new Error(t('serverError.pinnedPanel'));await page.close();if(!session.pages.size){const created=await session.context!.newPage();session.activeId=await this.trackPage(session,created);await created.setContent(demoHtml(),{waitUntil:'domcontentloaded'});}}
  }else if(input.action!=='list')throw new Error(t('serverError.unsupportedTabAction'));
  if(lease.activityTargetId&&session.pages.has(lease.activityTargetId))session.activity.update(lease.activityId,this.activityPage(session,lease.activityTargetId),input.action);
  session.lastFrame=undefined;session.health=null;await this.persist(session);return {tabs:await this.targets(session),session:await this.state(session.workspaceId)};
 }
 private pageId(session:LiveSession,page:Page):string|null{for(const[id,item]of session.pages)if(item===page)return id;return null;}
 private requirePage(session:LiveSession,id:string):Page{const page=session.pages.get(id);if(!page||page.isClosed())throw new Error(t('serverError.tabMissing'));return page;}
 private activePage(session:LiveSession):Page|undefined{
  if(session.activeId){const page=session.pages.get(session.activeId);if(page&&!page.isClosed())return page;}
  return undefined;
 }
 private trackPage(session:LiveSession,page:Page):Promise<string>{
  const existing=this.pageId(session,page);if(existing)return Promise.resolve(existing);const pending=session.pendingPages.get(page);if(pending)return pending;
  const generation=session.generation,context=session.context;let trackedId:string|undefined;const earlyDialogs:PageDialog[]=[];let dialogOpened:()=>void=()=>{};const pendingDialog=new Promise<void>(resolve=>{dialogOpened=resolve;});
  // Register synchronously: a popup can open a dialog before its CDP target id has finished resolving.
  page.on('dialog',dialog=>{if(generation!==session.generation||session.stopping)return;if(trackedId)this.recordDialog(session,trackedId,dialog);else earlyDialogs.push(dialog);dialogOpened();});
  const operation=session.trackTail.then(async()=>{
   if(!context||context!==session.context||generation!==session.generation||page.isClosed()||session.stopping)throw new Error(t('serverError.pageExpired'));
   if(session.pages.size>=session.settings.maxTabs){await page.close().catch(()=>{});session.error=t('serverError.maxTabsPopup',{count:session.settings.maxTabs});throw new Error(session.error);}
   const cdp=await context.newCDPSession(page);let id:string;
   try{const result=await cdp.send<{targetInfo:{targetId:string}}>('Target.getTargetInfo');id=result.targetInfo.targetId;}catch(error){await cdp.detach().catch(()=>{});throw error;}
   if(!id||page.isClosed()||generation!==session.generation||session.stopping)throw new Error(t('serverError.pageExpired'));
   session.pageCdp.set(id,cdp);
   cdp.on?.('Page.javascriptDialogClosed',()=>{if(generation===session.generation)this.clearPageDialogs(session,id);});
   // Every new document in this tab, the page's own or a frame's (not a history API change), ends live input made before it,
   // so queued keys never reach a document (or another origin) they were not typed for; it also restarts a pending screenshot.
   cdp.on?.('Page.frameNavigated',(event:{frame?:{id?:string;parentId?:string;loaderId?:string}})=>{
    const state=session.pageState.get(id),frame=event.frame;if(generation!==session.generation||!state||!frame?.loaderId)return;
    if(frame.id)state.replaced.delete(frame.id);
    if(!frame.parentId){state.loaderId=frame.loaderId;state.mainFrameId=frame.id;for(const restart of [...state.commits])restart();}
    else if(frame.id){if(state.frames.get(frame.id)===frame.loaderId)return;state.frames.set(frame.id,frame.loaderId);}
    if(session.activeId===id)this.endInputStream(session);
   });
   cdp.on?.('Page.frameDetached',(event:{frameId?:string})=>{if(event.frameId)session.pageState.get(id)?.frames.delete(event.frameId);});
   const replaced=new Set<string>(),isMain=(frameId:string)=>frameId===session.pageState.get(id)?.mainFrameId;
   this.watchReplacedDocuments(session,id,generation,cdp,replaced,frameId=>{const state=session.pageState.get(id);return isMain(frameId)?state?.loaderId:state?.frames.get(frameId);},isMain);
   session.pages.set(id,page);session.pageState.set(id,{opened:0,frames:new Map(),replaced,remote:new Map(),remoteChecks:new Set(),commits:new Set(),url:page.url(),title:'',demo:page.url()==='about:blank',pinned:false,httpStatus:null,requestFailure:null});session.activeId=id;session.epoch++;this.endInputStream(session);
   page.on('close',()=>{if(generation!==session.generation)return;for(const remote of session.pageState.get(id)?.remote.values()??[])void remote.cdp.detach().catch(()=>{});session.pages.delete(id);session.pageState.delete(id);session.pageCdp.delete(id);void cdp.detach().catch(()=>{});this.clearPageDialogs(session,id);if(session.activeId===id)session.activeId=[...session.pages.keys()].at(-1)??null;session.epoch++;session.health=null;this.endInputStream(session);if(!session.stopping)this.schedulePersist(session);});
   trackedId=id;for(const dialog of earlyDialogs)this.recordDialog(session,id,dialog);earlyDialogs.length=0;
   // A frame in another renderer process (site isolation) is not part of this tab's CDP target; it is watched on its own.
   page.on('framenavigated',frame=>{if(generation!==session.generation)return;if(frame!==page.mainFrame()){this.watchRemoteFrame(session,id,frame,generation);return;}const state=session.pageState.get(id);if(state){state.documentKey=undefined;state.url=page.url();state.demo=state.url==='about:blank';if(state.demo){state.httpStatus=null;state.requestFailure=null;}}session.health=null;this.invalidateView(session);this.schedulePersist(session);});
   page.on('framedetached',frame=>{const state=session.pageState.get(id),remote=state?.remote.get(frame);if(!state||!remote)return;state.remote.delete(frame);void remote.cdp.detach().catch(()=>{});});
   page.on('response',response=>{try{if(generation!==session.generation||response.frame()!==page.mainFrame()||!response.request().isNavigationRequest())return;const state=session.pageState.get(id);if(state){state.httpStatus=response.status();state.requestFailure=null;}session.health=null;}catch{}});
   page.on('requestfailed',request=>{try{if(generation!==session.generation||request.frame()!==page.mainFrame()||!request.isNavigationRequest())return;const failure=request.failure()?.errorText;if(failure&&!/ERR_ABORTED/.test(failure)){const state=session.pageState.get(id);if(state)state.requestFailure=safeFailure(failure);session.health=null;}}catch{}});
   const prepare=(async()=>{await cdp.send('Page.enable');await cdp.send('Page.setLifecycleEventsEnabled',{enabled:true}).catch(()=>{});await applyDeviceEmulation(page,cdp,session.devicePreset,{width:session.deviceWidth,height:session.deviceHeight},!session.dialog,session.browserVersion);await this.refreshDocumentRevision(session,page).catch(()=>{});this.invalidateView(session);this.schedulePersist(session);})();
   // A popup's Page.enable/viewport call may wait for its initial dialog. Make the stable target visible immediately.
   void prepare.catch(()=>{});await Promise.race([prepare,pendingDialog]);return id;
  });
  session.trackTail=operation.then(()=>{},()=>{});session.pendingPages.set(page,operation);void operation.finally(()=>{if(session.pendingPages.get(page)===operation)session.pendingPages.delete(page);}).catch(()=>{});return operation;
 }
 /**
  * A document replaced in place keeps its frame's loader, so no frameNavigated comes. document.open() (also a write after the
  * page loaded) reports documentOpened; a javascript: URL that returns markup shows only as a new 'init' lifecycle event on the
  * current loader. Either ends live input as a new document does, and the main frame's also changes documentScope. A
  * navigation's 'init' carries its new loader and a frame seen for the first time has none yet, so neither counts here.
  */
 private watchReplacedDocuments(session:LiveSession,tabId:string,generation:number,cdp:BrowserCDPSession,replaced:Set<string>,loaderOf:(frameId:string)=>string|undefined,isMain:(frameId:string)=>boolean=()=>false):void{
  const replace=(frameId:string)=>{const state=session.pageState.get(tabId);if(!state)return;if(isMain(frameId))state.opened++;if(session.activeId===tabId)this.endInputStream(session);};
  cdp.on?.('Page.documentOpened',(event:{frame?:{id?:string}})=>{const frameId=event.frame?.id;if(generation!==session.generation||!frameId)return;replaced.add(frameId);replace(frameId);});
  cdp.on?.('Page.lifecycleEvent',(event:{frameId?:string;loaderId?:string;name?:string})=>{
   if(generation!==session.generation||event.name!=='init'||!event.frameId||!event.loaderId)return;
   if(replaced.delete(event.frameId)||loaderOf(event.frameId)!==event.loaderId)return;
   replace(event.frameId);
  });
 }
 /**
  * A frame in another renderer process (site isolation): its new documents, same-address reloads included, and in-place
  * replacements are reported only to a CDP session on its own target, kept while the frame stays there. newCDPSession throws
  * for a frame in the tab's own process (or in an ancestor frame's), whose events come with that session already, so the
  * default headless shell never keeps one. The check is registered: refreshDocumentRevision waits for it before admitting input.
  */
 private watchRemoteFrame(session:LiveSession,tabId:string,frame:BrowserFrame,generation:number):void{
  const state=session.pageState.get(tabId),context=session.context;if(!state||!context)return;
  const check=(async()=>{
   // A watched frame reports each new document itself; reading it again also notices a session that ended (the frame came back).
   const known=state.remote.get(frame);if(known&&await this.readRemoteFrames(session,tabId,state,frame,known))return;
   let cdp:BrowserCDPSession;try{cdp=await context.newCDPSession(frame);}catch{return;}
   if(generation!==session.generation||session.pageState.get(tabId)!==state||frame.isDetached?.()||state.remote.has(frame)){void cdp.detach().catch(()=>{});return;}
   const remote:RemoteFrame={cdp,frames:new Map(),replaced:new Set()};state.remote.set(frame,remote);
   cdp.on?.('Page.frameNavigated',(event:{frame?:{id?:string;loaderId?:string}})=>{
    const navigated=event.frame;if(generation!==session.generation||!navigated?.id||!navigated.loaderId)return;remote.replaced.delete(navigated.id);
    if(remote.frames.get(navigated.id)===navigated.loaderId)return;remote.frames.set(navigated.id,navigated.loaderId);if(session.activeId===tabId)this.endInputStream(session);
   });
   cdp.on?.('Page.frameDetached',(event:{frameId?:string})=>{if(event.frameId)remote.frames.delete(event.frameId);});
   this.watchReplacedDocuments(session,tabId,generation,cdp,remote.replaced,frameId=>remote.frames.get(frameId));
   try{
    await cdp.send('Page.enable');await cdp.send('Page.setLifecycleEventsEnabled',{enabled:true}).catch(()=>{});
    const tree=await withTimeout(cdp.send<{frameTree:FrameTree}>('Page.getFrameTree'),this.budgets.measureMs,()=>{throw new Error('frame tree timeout');});
    remote.frames=loadersIn([tree.frameTree]);
   }catch{if(state.remote.get(frame)===remote)state.remote.delete(frame);void cdp.detach().catch(()=>{});return;}
   // Its document arrived in the other process before this session existed: new to input made before it.
   if(session.activeId===tabId)this.endInputStream(session);
  })();
  state.remoteChecks.add(check);void check.finally(()=>state.remoteChecks.delete(check)).catch(()=>{});
 }
 /** Reads a remote frame's target again: a new loader in any of its frames ends live input. False once its session is gone. */
 private async readRemoteFrames(session:LiveSession,tabId:string,state:PageState,frame:BrowserFrame,remote:RemoteFrame):Promise<boolean>{
  let tree:{frameTree:FrameTree}|null;
  try{tree=await withTimeout(remote.cdp.send<{frameTree:FrameTree}>('Page.getFrameTree'),this.budgets.measureMs,()=>null);}
  catch{if(state.remote.get(frame)===remote){state.remote.delete(frame);void remote.cdp.detach().catch(()=>{});}return false;}
  // A frame too busy to answer cannot be committing a new document either; its own events still report one.
  if(!tree)return true;
  const frames=loadersIn([tree.frameTree]),changed=[...frames].some(([frameId,loaderId])=>remote.frames.get(frameId)!==loaderId);remote.frames=frames;
  if(changed&&session.activeId===tabId)this.endInputStream(session);
  return true;
 }
 private async syncPages(session:LiveSession):Promise<void>{if(!session.context||session.stopping)return;await Promise.allSettled(session.context.pages().filter(page=>!page.isClosed()).map(page=>this.trackPage(session,page)));}
 private async viewport(page:Page,session:LiveSession):Promise<{width:number;height:number}>{try{const size=await withTimeout(page.evaluate<{width:number;height:number}|null>('({width:window.innerWidth,height:window.innerHeight})'),this.budgets.viewportProbeMs,()=>null);if(size&&Number.isFinite(size.width)&&Number.isFinite(size.height)&&size.width>0&&size.height>0)return size;}catch{}return page.viewportSize()??{width:session.width,height:session.height};}
 /** Start Chromium and wait for its DevTools port. An exit before that is the caller's to handle, not a crash to recover from. */
 private async launchChromium(session:LiveSession,generation:number,launch:{executable:string;args:string[];environment:NodeJS.ProcessEnv;activePortFile:string},spawned:ChildProcess[]):Promise<{child:ChildProcess;port:number;browserPath:string}>{
  const stopped=()=>this.disposed||this.retired.has(session.workspaceId)||generation!==session.generation||session.stopping||!session.desiredRunning;
  if(stopped())throw new Error(t('runtime.startStopped'));
  await unlink(launch.activePortFile).catch(()=>{});
  // Filesystem preparation may outlive retirement. Never spawn after its final cancellation check.
  if(stopped())throw new Error(t('runtime.startStopped'));
  const child=spawn(launch.executable,launch.args,{stdio:['ignore','ignore','pipe'],env:launch.environment});session.child=child;spawned.push(child);
  let launchError:string|null=null,startupLog='',listening=false;
  child.stderr?.on('data',chunk=>{if(!listening)startupLog=(startupLog+chunk.toString()).slice(-3000);});
  child.on('error',error=>{launchError=safeFailure(error);});
  child.on('exit',()=>{if(!listening||session.child!==child||generation!==session.generation)return;const unexpectedly=!session.stopping&&!this.disposed;session.activity.failRunning();session.child=undefined;session.browser=undefined;session.context=undefined;session.pages.clear();session.pageState.clear();session.pageCdp.clear();session.pendingDialogs.clear();session.dialog=null;session.dialogHandle=undefined;session.pendingPages.clear();session.trackTail=Promise.resolve();session.activeId=null;session.lastFrame=undefined;session.leases.clear();session.health=null;session.uptimeStart=null;if(unexpectedly){session.status='error';session.lastFailure=launchError??t('runtime.processExited');session.error=session.lastFailure;void this.persist(session).catch(()=>{});if(!session.starting)this.scheduleRecovery(session);}});
  const deadline=Date.now()+20000;
  while(Date.now()<deadline){
   if(launchError)throw new Error(launchError);if(stopped())throw new Error(t('runtime.startStopped'));
   if(child.exitCode!==null||child.signalCode!==null)throw Object.assign(new Error(startupLog.includes('error while loading shared libraries')?t('runtime.librariesMissing'):t('runtime.startFailed')),{exitedEarly:true,startupLog});
   try{const [line,browserPath='']=(await readFile(launch.activePortFile,'utf8')).split('\n'),candidate=Number(line);if(Number.isInteger(candidate)&&candidate>0&&candidate<65536&&/^\/devtools\/browser\/[\w-]+$/.test(browserPath)){listening=true;return {child,port:candidate,browserPath};}}catch{}
   await sleep(100);
  }
  throw new Error(t('runtime.startTimeout'));
 }
 private async boot(session:LiveSession,recovery=false):Promise<void>{
  await this.ensureGate();if(this.disposed||this.retired.has(session.workspaceId)||!session.desiredRunning)return;session.status=recovery?'recovering':'starting';session.error=null;session.stopping=false;session.health=null;session.generation++;const generation=session.generation;
  const stopped=()=>this.disposed||this.retired.has(session.workspaceId)||generation!==session.generation||session.stopping||!session.desiredRunning;
  // Every directory the browser uses must be a real directory owned by the daemon user, set to 0700, before Chromium or runtime code starts.
  const directory=path.dirname(this.metadataPath(session.workspaceId)),profileDir=path.join(directory,'profile');
  await ensurePrivateDirectory(this.runtimeRoot,t('runtime.runtimeDirectory'));await ensurePrivateDirectory(directory,t('runtime.workspaceDirectory'));await ensurePrivateDirectory(profileDir,t('runtime.profileDirectory'));await ensurePrivateDirectory(this.artifactDir(session.workspaceId),t('runtime.artifactDirectory'));
  if(stopped())return;
  const savedTabs=session.savedTabs.length?session.savedTabs.slice(0,session.settings.maxTabs):[{url:'about:blank',demo:true,pinned:false,active:true}];
  const exists=(file:string)=>access(file).then(()=>true,()=>false),libDirectory=path.join(this.runtimeRoot,'lib'),fontsConf=path.join(this.runtimeRoot,'fonts.conf');
  const environment=chromiumEnvironment(process.env,{libDirectory:await exists(libDirectory)?libDirectory:undefined,fontsConf:await exists(fontsConf)?fontsConf:undefined});
  const proxy=browserProxy(),mode=browserSandboxMode(),executable=await this.executable(),activePortFile=path.join(profileDir,'DevToolsActivePort');
  if(stopped())return;
  // Automatic mode tries Chromium's sandbox first and, if Chromium exits before it starts listening, starts it once more without.
  const attempts=mode==='on'?[true]:mode==='off'||this.sandboxUnavailable?[false]:[true,false];
  const spawned:ChildProcess[]=[];
  try{
   let launched:{child:ChildProcess;port:number;browserPath:string}|undefined,sandboxed=false,fallbackReason:string|undefined;
   for(const [index,sandbox] of attempts.entries()){
    if(stopped())return;
    try{launched=await this.launchChromium(session,generation,{executable,args:chromiumArguments({profileDir,width:session.width,height:session.height,proxy,sandbox}),environment,activePortFile},spawned);sandboxed=sandbox;break;}
    catch(error){
     const failure=error as Error&{exitedEarly?:boolean;startupLog?:string};
     if(!(sandbox&&mode==='auto'&&failure.exitedEarly&&index<attempts.length-1))throw error;
     fallbackReason=sandboxFailure(failure.startupLog??'');
    }
   }
   if(!launched)throw new Error(t('runtime.startFailed'));
   if(stopped())return;
   if(fallbackReason)this.sandboxUnavailable=fallbackReason;
   session.sandbox={enabled:sandboxed,mode,...(!sandboxed&&mode==='auto'&&this.sandboxUnavailable?{fallbackReason:this.sandboxUnavailable}:{})};
   session.cdpEndpoint=`http://127.0.0.1:${launched.port}`;
   // Connect over the WebSocket from DevToolsActivePort: given the http:// endpoint, Playwright fetches /json/version through
   // http_proxy unless no_proxy lists 127.0.0.1, and with NODE_USE_ENV_PROXY=1 Node rejects that request outright.
   const browser=await this.playwright().chromium.connectOverCDP(`ws://127.0.0.1:${launched.port}${launched.browserPath}`,{timeout:15000});if(stopped()){await withTimeout(browser.close().catch(()=>{}),3000,()=>undefined);return;}session.browser=browser;session.browserVersion=typeof browser.version==='function'?browser.version():'';const context=browser.contexts()[0];if(!context)throw new Error(t('runtime.persistentSessionMissing'));session.context=context;context.setDefaultTimeout(15000);context.setDefaultNavigationTimeout(30000);
   context.on('page',page=>{if(generation===session.generation)void this.trackPage(session,page).catch(()=>{});});await this.syncPages(session);
   let activeId:string|null=null;
   for(let index=0;index<savedTabs.length;index++){
    if(stopped())return;
    const saved=savedTabs[index],page=index===0?(session.context.pages()[0]??await context.newPage()):await context.newPage();const id=await this.trackPage(session,page);const state=session.pageState.get(id)!;state.pinned=saved.pinned;
    if(saved.demo){await page.goto('about:blank');await page.setContent(demoHtml(),{waitUntil:'domcontentloaded'});state.demo=true;}
    else{const url=restorableUrl(saved.url);if(url){try{await page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});}catch(error){state.requestFailure=safeFailure(error);state.url=url;session.lastFailure=state.requestFailure;}}}
    if(saved.active)activeId=id;
   }
   if(stopped())return;
   if(activeId)session.activeId=activeId;session.status='running';session.uptimeStart=Date.now();session.epoch++;
   if(recovery){session.recoveryCount++;session.lastRecoveredAt=Date.now();}
   // A fresh control token for every start: the previous one stops working with the previous browser.
   session.token=randomBytes(32);
   await this.writeMetadata(session);
   if(stopped()){if(this.retired.has(session.workspaceId))await unlink(this.metadataPath(session.workspaceId)).catch(()=>{});return;}
   await this.persist(session);if(stopped())return;await this.cleanArtifacts(session);
  }catch(error){
   const kill=()=>{for(const child of spawned)child.kill('SIGTERM');};
   if(this.disposed||generation!==session.generation||!session.desiredRunning){kill();return;}
   session.lastFailure=safeFailure(error);session.error=session.lastFailure;session.status='error';session.stopping=true;kill();throw error;
  }
 }
 private scheduleRecovery(session:LiveSession):void{
  if(this.disposed||!session.desiredRunning||!session.settings.autoRecover||session.recoveryTimer||session.starting)return;
  session.recoveryAttempts=session.recoveryAttempts.filter(time=>Date.now()-time<300_000);
  if(session.recoveryAttempts.length>=3){session.status='error';session.error=t('runtime.recoveryLimit');void this.persist(session).catch(()=>{});return;}
  const delay=[1000,3000,8000][session.recoveryAttempts.length];session.recoveryAttempts.push(Date.now());session.status='recovering';void this.persist(session).catch(()=>{});
  session.recoveryTimer=setTimeout(()=>{session.recoveryTimer=undefined;if(this.disposed||!session.desiredRunning||!session.settings.autoRecover)return;session.starting=(async()=>{try{await this.stopSession(session,true);await this.boot(session,true);}catch(error){session.status='error';session.error=safeFailure(error);}})();void session.starting.finally(()=>{session.starting=undefined;if(session.status!=='running')this.scheduleRecovery(session);}).catch(()=>{});},delay);session.recoveryTimer.unref?.();
 }
 async restore(validWorkspaceIds:string[]):Promise<void>{
  if(this.disposed)return;if(this.restoring)return this.restoring;const allowed=new Set(validWorkspaceIds.filter(id=>/^[A-Za-z0-9_-]{1,120}$/.test(id)));
  this.restoring=(async()=>{let entries;try{entries=await readdir(this.dataRoot,{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
   const pending:LiveSession[]=[];
   for(const entry of entries){if(this.disposed)break;if(!entry.isDirectory()||entry.isSymbolicLink()||!allowed.has(entry.name)||this.retired.has(entry.name))continue;const session=this.session(entry.name);await this.load(session);
    // A session.json left by a crash, a kill or a reboot names ports anyone may hold now: it goes before an Agent bridge can
    // use it. Kept only while its recorded Chromium still runs (a killed plugin's orphan, stopped by archiving or orphan cleanup).
    const idle=()=>!session.child&&!session.starting&&!session.recoveryTimer&&session.status!=='running';
    if(idle()&&!await this.ownedProcessId(entry.name)&&idle())await unlink(this.metadataPath(entry.name)).catch(()=>{});
    if(!session.desiredRunning||session.status==='running'||session.starting||session.recoveryTimer)continue;
    session.recoveryAttempts=session.recoveryAttempts.filter(time=>Date.now()-time<300_000);if(session.recoveryAttempts.length>=3){session.status='error';session.error=t('runtime.recentRecoveryLimit');continue;}
    session.status='recovering';pending.push(session);
   }
   for(const session of pending){
    if(this.disposed)break;if(this.retired.has(session.workspaceId)||!session.desiredRunning||session.status==='running'||session.starting||session.recoveryTimer)continue;
    session.starting=this.boot(session,true);try{await session.starting;}catch(error){session.status='error';session.error=safeFailure(error);}finally{session.starting=undefined;}if((session.status as BrowserSession['status'])!=='running')this.scheduleRecovery(session);
   }
  })();try{await this.restoring;}finally{this.restoring=undefined;}
 }
 async start(workspaceId:string):Promise<BrowserSession>{
  const requireActive=()=>{if(this.disposed)throw new Error(t('serverError.pluginClosing'));if(this.retired.has(workspaceId))throw new Error(t('serverError.workspaceArchived'));};
  requireActive();const session=this.session(workspaceId);await this.load(session);requireActive();session.desiredRunning=true;
  if(session.recoveryTimer){clearTimeout(session.recoveryTimer);session.recoveryTimer=undefined;}
  if(session.starting)await session.starting;
  else if(session.status!=='running'){session.recoveryAttempts=[];session.starting=(async()=>{if(session.child)await this.stopSession(session,true);try{await this.boot(session);}catch(error){session.status='error';session.error=safeFailure(error);await this.persist(session);throw error;}})();try{await session.starting;}finally{session.starting=undefined;}}
  requireActive();await this.persist(session);return this.state(workspaceId);
 }
 private async refreshDocumentRevision(session:LiveSession,page:Page):Promise<void>{
  const tabId=this.pageId(session,page),info=tabId?session.pageState.get(tabId):undefined,cdp=tabId?session.pageCdp.get(tabId):undefined;if(!info||!cdp)return;
  // CDP clients receive navigation events independently. Read the browser's document identity before trusting a rendered target.
  const tree=await withTimeout(cdp.send<{frameTree:FrameTree}>('Page.getFrameTree'),this.budgets.measureMs,()=>{throw new Error(t('serverError.documentUnresponsive'));});
  const frame=tree.frameTree.frame,key=JSON.stringify([frame.loaderId,frame.url,frame.urlFragment]);if(info.documentKey!==undefined&&info.documentKey!==key)this.invalidateView(session);info.documentKey=key;info.loaderId=frame.loaderId;if(frame.id)info.mainFrameId=frame.id;
  // A child frame with a new document (an iframe that went to another page or origin) ends input made before it, as the page's own would.
  const frames=loadersIn(tree.frameTree.childFrames);
  const changed=[...frames].some(([frameId,loaderId])=>info.frames.get(frameId)!==loaderId);info.frames=frames;
  if(changed&&session.activeId===tabId)this.endInputStream(session);
  // Frames in other processes (none on the default headless shell): wait for sessions being set up, then read each again.
  if(info.remoteChecks.size)await Promise.allSettled([...info.remoteChecks]);
  if(info.remote.size)await Promise.all([...info.remote].map(([remoteFrame,remote])=>this.readRemoteFrames(session,tabId!,info,remoteFrame,remote)));
 }
 /** A new picture is needed before the next click: every input, navigation or other change spends the current one. */
 private invalidateView(session:LiveSession):void{session.viewRevision=randomUUID();session.lastFrame=undefined;}
 /** Live input queued against the page as it was must not continue after this change. */
 private endInputStream(session:LiveSession):void{session.inputEpoch++;this.invalidateView(session);}
 /**
  * The page context live input stays bound to: active tab, its document (a cross-document navigation ends it, the history
  * API does not), the configured viewport and device, who controls the browser, and inputEpoch. Null until the document is known.
  */
 private inputScope(session:LiveSession):string|null{
  const loader=session.activeId?session.pageState.get(session.activeId)?.loaderId:undefined;if(!session.activeId||!loader)return null;
  return contentRevision([session.activeId,loader,session.generation,session.inputEpoch,session.deviceWidth,session.deviceHeight,session.devicePreset,session.mode]);
 }
 /**
  * The page the viewer is looking at, whoever controls it: the active tab, its document and the device it is shown on. An
  * Agent step on the same document keeps it; a takeover confirmed on it runs only while it is unchanged.
  */
 private documentScope(session:LiveSession):string|null{
  const state=session.activeId?session.pageState.get(session.activeId):undefined,loader=state?.loaderId;if(!session.activeId||!state||!loader)return null;
  return contentRevision(['document',session.activeId,loader,state.opened,session.generation,session.deviceWidth,session.deviceHeight,session.devicePreset]);
 }
 setAgentAvailability(workspaceId:string,availability:BrowserSession['agentAvailability']):void{this.session(workspaceId).agentAvailability=availability;}
 private viewerCount(session:LiveSession):number{for(const [id,seen]of session.viewers)if(this.now()-seen>15000)session.viewers.delete(id);return session.viewers.size;}
 async state(workspaceId:string):Promise<BrowserSession>{
  const session=this.session(workspaceId);await this.load(session);await this.syncPages(session);const active=this.activePage(session);
  // Titles and the viewport are read in parallel, each with its own time limit, so a page stuck in a script cannot hold up polling.
  const [tabs,size]=await Promise.all([Promise.all([...session.pages.entries()].filter(([,page])=>!page.isClosed()).map(async([id,page])=>{const title=await this.pageTitle(session,id,page),saved=session.pageState.get(id);if(saved)saved.title=title;return {id,title,url:withoutCredentials(page.url()),active:id===session.activeId,pinned:saved?.pinned??false};})),active&&!session.dialog?this.viewport(active,session):null]);
  const selected=tabs.find(tab=>tab.active);if(size){session.width=size.width;session.height=size.height;}
  return {workspaceId,status:session.status,title:selected?.title??t('serverText.browserName'),url:selected?.url??'',mode:session.mode,activeTabId:session.activeId,viewRevision:session.viewRevision,inputScope:this.inputScope(session),documentScope:this.documentScope(session),inputSeqFloor:session.inputSeqFloor,devicePreset:session.devicePreset,viewerCount:this.viewerCount(session),dialog:session.dialog,agentAvailability:session.agentAvailability,width:session.width,height:session.height,tabs,agentId:session.agentId,error:session.error,agentBusy:this.agentBusy(session),settings:{...session.settings},runtime:{recoveryCount:session.recoveryCount,lastRecoveredAt:session.lastRecoveredAt,lastFailure:session.lastFailure,artifactBytes:session.artifactBytes,artifactCount:session.artifactCount,cleanedArtifacts:session.cleanedArtifacts,uptimeSeconds:session.uptimeStart?Math.max(0,Math.floor((Date.now()-session.uptimeStart)/1000)):0},health:session.health,activity:session.activity.snapshot()};
 }
 async frame(workspaceId:string,after?:string|null,quality:BrowserFrameQuality='balanced',options:FrameLimits&{sessionRevision?:string;viewerId?:string}={}):Promise<BrowserFrameResult>{
  const session=this.session(workspaceId);if(options.viewerId){session.viewers.set(options.viewerId,this.now());if(session.viewers.size>200)this.viewerCount(session);if(session.viewers.size>200)session.viewers.delete(session.viewers.keys().next().value!);}if(session.resizing)await session.resizing.catch(()=>{});await this.syncPages(session);const page=this.activePage(session);if(session.status!=='running'||!page||session.dialog)return this.frameResult(workspaceId,null,options.sessionRevision);await this.refreshDocumentRevision(session,page);
  const choice=FRAME_QUALITY[quality],limits={maxWidth:options.maxWidth,maxHeight:options.maxHeight},key=`${quality}:${frameScale({width:session.width,height:session.height},limits)}`;
  if(!session.frameTask){session.frameTask=(async()=>{if(session.lastFrame&&session.frameKey===key&&session.frameTabId===session.activeId&&session.lastFrame.viewRevision===session.viewRevision&&Date.now()-session.lastFrame.capturedAt<choice.cache)return session.lastFrame;
   const tabId=session.activeId!,commits=session.pageState.get(tabId)?.commits;let viewRevision=session.viewRevision,inputScope=this.inputScope(session),documentScope=this.documentScope(session);
   // A new document committed mid-capture restarts it; the picture then belongs to the page as it was when the last attempt began.
   const shot=await captureBrowserFrame(session.context!,page,choice.quality,limits,{onAttempt:()=>{viewRevision=session.viewRevision;inputScope=this.inputScope(session);documentScope=this.documentScope(session);},watchCommits:restart=>{commits?.add(restart);return()=>{commits?.delete(restart);};}}),size=shot.width>0&&shot.height>0?shot:await this.viewport(page,session),id=createHash('sha256').update(tabId).update(viewRevision).update(shot.bytes).digest('hex').slice(0,24);
   // Live input during the capture only spends the picture for clicks; it is still this page, so it is shown (typing stays visible).
   if(session.activeId!==tabId||(inputScope?this.inputScope(session)!==inputScope:session.viewRevision!==viewRevision)||page.isClosed())return null;
   const frame={id,tabId,viewRevision,...(inputScope?{inputScope}:{}),...(documentScope?{documentScope}:{}),dataUrl:`data:image/jpeg;base64,${shot.bytes.toString('base64')}`,width:size.width,height:size.height,capturedAt:Date.now(),...(shot.scale<1?{scale:shot.scale}:{})};session.lastFrame=frame;session.frameKey=key;session.frameTabId=tabId??undefined;return frame;})().finally(()=>{session.frameTask=undefined;});}
  try{const frame=await session.frameTask;return this.frameResult(workspaceId,frame?.id===after?null:frame,options.sessionRevision);}catch(error){if(page.isClosed()||session.status!=='running')return this.frameResult(workspaceId,null,options.sessionRevision);throw error;}
 }
 /** Frame polling re-sends the session only when it changed since the revision the viewer holds. */
 private async frameResult(workspaceId:string,frame:BrowserFrameResult['frame'],knownRevision?:string):Promise<BrowserFrameResult>{
  const session=await this.state(workspaceId),revision=sessionRevision(session);
  if(frame&&(frame.tabId!==session.activeTabId||(frame.inputScope?frame.inputScope!==session.inputScope:frame.viewRevision!==session.viewRevision)))frame=null;
  return knownRevision===revision?{sessionRevision:revision,frame}:{session,sessionRevision:revision,frame};
 }
 private async serialized<T>(session:LiveSession,operation:()=>Promise<T>):Promise<T>{const result=session.tail.then(operation,operation);session.tail=result.then(()=>{},()=>{});return result;}
 private async cleanArtifacts(session:LiveSession):Promise<void>{if(session.artifactTask)return session.artifactTask;session.artifactTask=(async()=>{const result=await maintainArtifacts(this.artifactDir(session.workspaceId),session.settings);session.artifactBytes=result.bytes;session.artifactCount=result.count;session.cleanedArtifacts+=result.cleaned;})().finally(()=>{session.artifactTask=undefined;});return session.artifactTask;}
 /** What a manual target is checked against: the exact picture for clicks, the page context for everything else. */
 private manualContext(session:LiveSession){return {activeId:session.activeId,viewRevision:session.viewRevision,inputScope:this.inputScope(session)};}
 async action(workspaceId:string,action:BrowserAction,target?:BrowserTarget):Promise<BrowserSession>{
  if(action.kind==='takeover')return this.takeover(workspaceId,action,target);
  // The panel's port entry is resolved to an address by the plugin entry (index.server.ts); a bare port opens nothing here.
  if(action.kind==='openPort')throw new Error(t('serverError.portNotListed',{port:action.port}));
  const session=this.session(workspaceId);await this.load(session);
  // Stopping or restarting ends the browser itself, so it never queues behind a page call that does not return.
  const lifecycle=action.kind==='stop'||action.kind==='restart'||action.kind==='handleDialog'||action.kind==='mode';
  const run=async()=>{
  if(action.kind==='settings'||action.kind==='cleanup'||action.kind==='handleDialog')return this.performAction(workspaceId,action);
  if(!lifecycle)await this.syncPages(session);
  if(needsManualTarget(action)){const viewed=this.activePage(session);if(viewed)await this.refreshDocumentRevision(session,viewed);assertManualTarget(target,this.manualContext(session),action.kind==='click');}
  const originalTarget='tabId'in action?action.tabId:action.kind==='newTab'?null:session.activeId;
  const activityId=session.activity.start('manual',action.kind,this.activityPage(session,originalTarget));
  try{const result=await this.performAction(workspaceId,action,originalTarget,target);await this.finishActivity(session,activityId,false,originalTarget??(action.kind==='newTab'?session.activeId:null));result.activity=session.activity.snapshot();return result;}
  catch(error){await this.finishActivity(session,activityId,true,originalTarget);throw error;}
  };
  if(lifecycle)return run();
  // A dialog suspends the underlying click/navigation. Return its state so the panel can answer it, while the queue remains held.
  let notify:()=>void=()=>{};const dialogOpened=new Promise<BrowserSession>((resolve,reject)=>{notify=()=>{void this.state(workspaceId).then(resolve,reject);};session.dialogWaiters.add(notify);});
  try{return await Promise.race([this.serialized(session,run),dialogOpened]);}finally{session.dialogWaiters.delete(notify);}
 }
 /**
  * Live input from one viewer: typing, keys, wheel scrolling and clicks, in order. Keys and text continue on the page
  * context the viewer saw (tab, document, viewport, control) without waiting for a new picture, so a burst of typing and
  * its Enter all arrive; a click still needs the exact picture it was made on. Another viewer's input, an Agent step, a
  * dialog, a tab change or a new document ends the stream: input queued for the old page is refused, never replayed.
  */
 async input(workspaceId:string,request:BrowserInputRequest):Promise<BrowserInputResult>{
  const session=this.session(workspaceId);await this.load(session);
  // dispatching: an event is with the page right now; a dialog that opens then holds that event (pending), not the rest.
  let applied=0,dispatching=false;
  const reply=async(status:BrowserInputResult['status'],continuation:string|null=null,pending=false):Promise<BrowserInputResult>=>({status,applied,continuation,pending,session:await this.state(workspaceId)});
  const run=async():Promise<BrowserInputResult>=>{
   const previous=session.inputStream,[first]=request.events,last=session.inputSeqs.get(request.viewerId);
   // Each viewer's batches only move forward, even after another viewer typed in between. A viewer no longer remembered must
   // send above every forgotten viewer's last batch (clients start above inputSeqFloor), so a forgotten batch never comes back.
   if(last!==undefined?request.seq<=last:request.seq<=session.inputSeqFloor)return reply('stale');
   if(session.status!=='running'||session.stopping||session.mode!=='manual')return reply('stale');
   if(session.dialog)return reply('blocked');
   if(this.agentBusy(session))return reply('busy');
   await this.syncPages(session);const page=this.activePage(session);
   if(!page||request.target.tabId!==session.activeId)return reply('stale');
   await this.refreshDocumentRevision(session,page);
   if(first.kind==='click'?request.target.viewRevision!==session.viewRevision:!request.target.inputScope||request.target.inputScope!==this.inputScope(session))return reply('stale');
   // The previous viewer's queued input was made for a page this viewer is now changing.
   if(previous&&previous.viewerId!==request.viewerId)session.inputEpoch++;
   session.inputStream={viewerId:request.viewerId,seq:request.seq};
   session.inputSeqs.delete(request.viewerId);session.inputSeqs.set(request.viewerId,request.seq);
   if(session.inputSeqs.size>64){const [forgotten,seq]=session.inputSeqs.entries().next().value!;session.inputSeqs.delete(forgotten);session.inputSeqFloor=Math.max(session.inputSeqFloor,seq);}
   const scope=this.inputScope(session),tabId=session.activeId!,generation=session.generation;
   const activityId=session.activity.continue('manual',first.kind,this.activityPage(session,tabId));
   session.manualOps++;
   try{
    for(const event of request.events){
     if(applied>0){
      // A later event runs only while the page context holds: an Enter that loaded a new document ends the batch.
      if(event.kind==='click'||session.generation!==generation||session.dialog||session.mode!=='manual'||session.activeId!==tabId||page.isClosed())break;
      await this.refreshDocumentRevision(session,page);if(this.inputScope(session)!==scope)break;
     }else if(event.kind==='click'){
      const size=await this.viewport(page,session);
      if(session.viewRevision!==request.target.viewRevision||session.activeId!==tabId)break;
      if(event.x<0||event.y<0||event.x>=size.width||event.y>=size.height)throw new Error(t('serverError.clickOutside'));
     }
     dispatching=true;try{await this.dispatchInput(page,event);}finally{dispatching=false;}applied++;
    }
   }catch(error){
    if(generation===session.generation&&!session.stopping)session.error=safeFailure(error);
    this.invalidateView(session);await this.finishActivity(session,activityId,true,tabId);throw error;
   }finally{session.manualOps--;}
   this.invalidateView(session);if(applied)session.error=null;await this.finishActivity(session,activityId,applied===0,tabId);
   const done=applied===request.events.length;
   return reply(done?'applied':'stale',done&&this.inputScope(session)===scope?scope:null);
  };
  // A dialog suspends the key or click that opened it (pending: it finishes once the dialog is answered); the rest of the
  // batch does not run. A dialog that was already open when the batch came ran nothing at all.
  let notify:()=>void=()=>{};const dialogOpened=new Promise<BrowserInputResult>((resolve,reject)=>{notify=()=>{void reply('blocked',null,dispatching).then(resolve,reject);};session.dialogWaiters.add(notify);});
  try{return await Promise.race([this.serialized(session,run),dialogOpened]);}finally{session.dialogWaiters.delete(notify);}
 }
 private async dispatchInput(page:Page,event:BrowserInputEvent):Promise<void>{
  if(event.kind==='click')await page.mouse.click(event.x,event.y);
  else if(event.kind==='scroll')await page.mouse.wheel(event.deltaX,event.deltaY);
  else if(event.kind==='text')await page.keyboard.insertText(event.text);
  else await page.keyboard.press(event.key);
 }
 /**
  * From Agent mode, one navigation the viewer confirmed: switch to manual (the bridge refuses the Agent's next write), let
  * the Agent's current step finish, then navigate only if the tab, document and viewport are still the ones confirmed on.
  */
 private async takeover(workspaceId:string,action:Extract<BrowserAction,{kind:'takeover'}>,target?:BrowserTarget):Promise<BrowserSession>{
  const session=this.session(workspaceId);await this.load(session);
  if(session.status!=='running'||session.stopping)throw new Error(t('serverError.startFirst'));
  await this.syncPages(session);const page=this.activePage(session);
  if(!page||!target||target.tabId!==session.activeId)throw new Error(STALE_CONFIRMATION());
  await this.refreshDocumentRevision(session,page);
  // The confirmation is for the page shown when the sheet opened. Another document there (or tab, or size) voids it before
  // anything changes; an Agent step on the same page does not. Older clients without documentScope need their exact context.
  const confirmed=target.documentScope?target.documentScope===this.documentScope(session):target.inputScope?target.inputScope===this.inputScope(session):target.viewRevision===session.viewRevision;
  if(!confirmed)throw new Error(STALE_CONFIRMATION());
  const place=()=>this.documentScope(session),expected=place();
  if(session.mode!=='manual'){this.endInputStream(session);session.mode='manual';await this.persist(session);}
  const deadline=Date.now()+this.budgets.takeoverWaitMs;
  while(this.agentBusy(session)){if(Date.now()>=deadline)throw new Error(t('serverError.takeoverBusy'));await sleep(100);}
  await this.syncPages(session);const current=this.activePage(session);if(current)await this.refreshDocumentRevision(session,current);
  if(!current||place()!==expected)throw new Error(t('serverError.takeoverPageChanged'));
  const context=this.manualContext(session);
  return this.action(workspaceId,action.then,{tabId:context.activeId!,viewRevision:context.viewRevision,...(context.inputScope?{inputScope:context.inputScope}:{})});
 }
 private async performAction(workspaceId:string,action:BrowserAction,originalTarget?:string|null,target?:BrowserTarget):Promise<BrowserSession>{
  const session=this.session(workspaceId);await this.load(session);
   if(action.kind==='mode'){if(session.mode!==action.mode)this.endInputStream(session);session.mode=action.mode;await this.persist(session);return this.state(workspaceId);}
   if(action.kind==='settings'){session.settings=browserSettingsSchema.parse({...session.settings,...action.settings});if(!session.settings.autoRecover&&session.recoveryTimer){clearTimeout(session.recoveryTimer);session.recoveryTimer=undefined;session.status='error';}await this.persist(session);return this.state(workspaceId);}
   if(action.kind==='cleanup'){await this.cleanArtifacts(session);return this.state(workspaceId);}
   if(action.kind==='handleDialog'){if(session.mode!=='manual')throw new Error(t('serverError.takeoverDialogFirst'));return this.handleDialog(session,action.dialogId,action.accept,action.promptText);}
   if(session.mode!=='manual')throw new Error(t('serverError.takeoverFirst'));if(this.agentBusy(session))throw new Error(t('serverError.agentFinishing'));
   session.manualOps++;const generation=session.generation;
   try{
   if(action.kind==='stop'){session.desiredRunning=false;await this.stopSession(session,false);return this.state(workspaceId);}
   if(action.kind==='restart'){session.desiredRunning=true;await this.stopSession(session,true);await this.start(workspaceId);return this.state(workspaceId);}
   if(session.status!=='running')throw new Error(t('serverError.startFirst'));await this.syncPages(session);const page=originalTarget?this.requirePage(session,originalTarget):this.activePage(session);if(!page&&action.kind!=='newTab')throw new Error(t('serverError.noPage'));
   if(needsManualTarget(action)){assertManualTarget(target,this.manualContext(session),action.kind==='click');this.invalidateView(session);}
   const executionRevision=session.viewRevision;
   try{switch(action.kind){
    case 'navigate':session.health=null;await page!.goto(normalizeNavigationUrl(action.url),{waitUntil:'domcontentloaded'});break;
    case 'back':session.health=null;await page!.goBack({waitUntil:'domcontentloaded'});break;
    case 'forward':session.health=null;await page!.goForward({waitUntil:'domcontentloaded'});break;
    case 'reload':session.health=null;await page!.reload({waitUntil:'domcontentloaded'});break;
    case 'demo':await page!.goto('about:blank');await page!.setContent(demoHtml(),{waitUntil:'domcontentloaded'});break;
    case 'click':{const size=await this.viewport(page!,session);assertManualTarget({tabId:originalTarget!,viewRevision:executionRevision},session);if(action.x<0||action.y<0||action.x>=size.width||action.y>=size.height)throw new Error(t('serverError.clickOutside'));await page!.mouse.click(action.x,action.y);break;}
    case 'scroll':await page!.mouse.wheel(action.deltaX,action.deltaY);break;
    case 'text':await page!.keyboard.insertText(action.text);break;
    case 'key':await page!.keyboard.press(action.key);break;
    case 'viewport':
    case 'devicePreset':{
     session.resizing=(async()=>{
      await session.frameTask?.catch(()=>{});
      const preset=action.kind==='devicePreset'?action.preset:'custom',size=action.kind==='devicePreset'?DEVICE_PRESETS[action.preset]:action;
      await Promise.all([...session.pages.entries()].filter(([,p])=>!p.isClosed()).map(([id,p])=>applyDeviceEmulation(p,session.pageCdp.get(id)!,preset,{width:size.width,height:size.height},true,session.browserVersion)));
      session.devicePreset=preset;session.deviceWidth=size.width;session.deviceHeight=size.height;session.width=size.width;session.height=size.height;
      // A size or device change ends live input, so a later change back to the same values cannot revive it.
      this.endInputStream(session);
     })();
     try{await session.resizing;}finally{session.resizing=undefined;}
     break;
    }
    case 'fitWidth':{
     let remaining=false;
     session.resizing=(async()=>{
      await session.frameTask?.catch(()=>{});
      const fitted=await fitPageWidth(page!,2560,this.budgets.measureMs);
      session.width=fitted.width;session.height=fitted.height;session.deviceWidth=fitted.width;session.deviceHeight=fitted.height;session.devicePreset='custom';this.endInputStream(session);await applyDeviceEmulation(page!,session.pageCdp.get(session.activeId!)!,'custom',fitted,true,session.browserVersion);remaining=fitted.limitReached;
     })();
     try{await session.resizing;}finally{session.resizing=undefined;session.lastFrame=undefined;}
     if(remaining)throw new Error(t('serverError.widthRemaining'));
     break;
    }
    case 'newTab':{if(session.pages.size>=session.settings.maxTabs)throw new Error(t('serverError.maxTabs',{count:session.settings.maxTabs}));const url=action.url!==undefined?normalizeNavigationUrl(action.url):null;const created=await session.context!.newPage();await this.trackPage(session,created);if(url){session.health=null;await created.goto(url,{waitUntil:'domcontentloaded'});}else await created.setContent(demoHtml(),{waitUntil:'domcontentloaded'});break;}
    // Switching away ends live input for the old tab for good: coming back (A → B → A) starts a new context, never the old one.
    case 'tab':{const target=this.requirePage(session,action.tabId);if(session.activeId!==action.tabId){session.activeId=action.tabId;this.endInputStream(session);}session.health=null;await target.bringToFront();break;}
    case 'pin':this.requirePage(session,action.tabId);session.pageState.get(action.tabId)!.pinned=action.pinned;break;
    case 'closeTab':{const target=this.requirePage(session,action.tabId);if(session.pageState.get(action.tabId)?.pinned)throw new Error(t('serverError.pinnedClose'));await target.close();if(!session.pages.size){const created=await session.context!.newPage();await this.trackPage(session,created);await created.setContent(demoHtml(),{waitUntil:'domcontentloaded'});}break;}
   }}catch(error){
    // A call cut short by stopping or restarting the browser is not this browser's error.
    if(generation===session.generation&&!session.stopping){if(['navigate','back','forward','reload'].includes(action.kind)||(action.kind==='newTab'&&action.url)){const state=session.activeId?session.pageState.get(session.activeId):undefined;if(state)state.requestFailure=safeFailure(error);session.health=null;}session.error=safeFailure(error);await this.persist(session);}
    if(needsManualTarget(action))this.invalidateView(session);throw error;}
   if(needsManualTarget(action))this.invalidateView(session);session.error=null;await this.persist(session);return this.state(workspaceId);
   }finally{session.manualOps--;}
 }
 async read(workspaceId:string,input:Omit<BrowserReadInput,'workspaceId'>,source:BrowserActivity['source']='manual'):Promise<BrowserReading>{
  const session=this.session(workspaceId),tabId=input.tabId??session.activeId,activityId=session.activity.start(source,'browser_read_page',this.activityPage(session,tabId));
  try{const result=await this.performRead(workspaceId,input);await this.finishActivity(session,activityId,false,tabId);return result;}
  catch(error){await this.finishActivity(session,activityId,true,tabId);throw error;}
 }
 private async performRead(workspaceId:string,input:Omit<BrowserReadInput,'workspaceId'>):Promise<BrowserReading>{
  const session=this.session(workspaceId);if(session.status!=='running')throw new Error(t('serverError.startFirst'));await this.syncPages(session);const parsed=readPageInputSchema.parse({...input,workspaceId});const page=parsed.tabId?this.requirePage(session,parsed.tabId):this.activePage(session);if(!page)throw new Error(t('serverError.noReadableTab'));const id=this.pageId(session,page)!;return readPageContent(page,id,parsed,this.runtimeRoot,this.budgets.pageReadMs);
 }
 async diagnostics(workspaceId:string,source:BrowserActivity['source']='manual'):Promise<BrowserDiagnostics>{
  const session=this.session(workspaceId),tabId=session.activeId,activityId=session.activity.start(source,'browser_diagnostics',this.activityPage(session,tabId));
  try{const result=await this.performDiagnostics(workspaceId);await this.finishActivity(session,activityId,false,tabId);result.session.activity=session.activity.snapshot();return result;}
  catch(error){await this.finishActivity(session,activityId,true,tabId);throw error;}
 }
 private async performDiagnostics(workspaceId:string):Promise<BrowserDiagnostics>{
  const session=this.session(workspaceId);await this.load(session);await this.syncPages(session);const page=this.activePage(session),info=session.activeId?session.pageState.get(session.activeId):undefined;
  const checks:BrowserDiagnostics['checks']=[];let cdpOk=false;
  if(page&&session.context&&session.status==='running'){
   let cdp:Awaited<ReturnType<BrowserContext['newCDPSession']>>|undefined;
   let timer:ReturnType<typeof setTimeout>|undefined;
   try{cdp=await session.context.newCDPSession(page);await Promise.race([cdp.send('Target.getTargetInfo'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('CDP timeout')),5000);})]);cdpOk=true;}catch{}finally{if(timer)clearTimeout(timer);await cdp?.detach().catch(()=>{});}
  }
  checks.push({name:t('diagnostics.browserCdp'),status:cdpOk?'ok':'error',detail:cdpOk?t('diagnostics.cdpReady'):t('diagnostics.cdpNotReady')});
  checks.push(this.sandboxCheck(session));
  const profile=path.join(path.dirname(this.metadataPath(workspaceId)),'profile');const writable=await access(profile,constants.W_OK).then(()=>true,()=>false);checks.push({name:t('diagnostics.profile'),status:writable?'ok':'warning',detail:writable?t('diagnostics.profileWritable'):t('diagnostics.profileNotWritable')});
  // Optional runtime extras: lib/ joins LD_LIBRARY_PATH and fonts.conf becomes FONTCONFIG_FILE; otherwise the system's own are used.
  const exists=(file:string)=>access(file).then(()=>true,()=>false),fonts=await exists(path.join(this.runtimeRoot,'fonts.conf')),libs=await exists(path.join(this.runtimeRoot,'lib'));
  checks.push({name:t('diagnostics.fontsLibraries'),status:cdpOk?'ok':'warning',detail:t('diagnostics.fontsSummary',{browser:cdpOk?t('diagnostics.chromiumRunning'):t('diagnostics.chromiumStopped'),fonts:fonts?t('diagnostics.runtimeFonts'):t('diagnostics.systemFonts'),libraries:libs?t('diagnostics.runtimeLibraries'):t('diagnostics.systemLibraries')})});
  const agentTools=await exists(path.join(this.runtimeRoot,'node_modules/@playwright/mcp/cli.js'));
  checks.push({name:t('diagnostics.agentTools'),status:agentTools?'ok':'warning',detail:agentTools?t('diagnostics.agentToolsReady'):t('diagnostics.agentToolsMissing')});
  try{checks.push({name:t('diagnostics.networkProxy'),status:'ok',detail:browserProxy()?t('diagnostics.browserProxy'):['HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy','ALL_PROXY','all_proxy'].some(key=>process.env[key])?t('diagnostics.daemonProxy'):t('diagnostics.noProxy')});}
  catch(error){checks.push({name:t('diagnostics.networkProxy'),status:'error',detail:safeFailure(error)});}
  let origin='';try{origin=page?new URL(page.url()).origin:'';if(origin==='null')origin=t('serverText.localDemo');}catch{}
  let state:BrowserHealth['state']='unknown',summary=t('diagnostics.unknownPage');let signals:{password:boolean;loginForm:boolean;hasContent:boolean}|null=null;
  if(page&&session.status==='running'&&cdpOk){
   // i18n-ignore: site login labels matched as data by the diagnostic probe.
   try{signals=await withTimeout(page.evaluate<{password:boolean;loginForm:boolean;hasContent:boolean}|null>(`(()=>{const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'};const password=[...document.querySelectorAll('input[type=password]')].some(visible);const forms=[...document.querySelectorAll('form')].filter(visible);const loginForm=forms.some(f=>f.querySelector('input')&&/登录|登入|sign[ -]?in|log[ -]?in/i.test(f.innerText.slice(0,1500)));return{password,loginForm,hasContent:!!document.body?.innerText.trim()}})()`),this.budgets.diagnosticsScriptMs,()=>null);}catch{}
   if(info?.requestFailure){state='network_error';summary=info.requestFailure;}
   else if(info?.httpStatus===401){state='login_required';summary=t('diagnostics.httpUnauthorized');}
   else if(info?.httpStatus===403){state='unknown';summary=t('diagnostics.httpForbidden');}
   else if(signals?.password||signals?.loginForm){state='login_required';summary=t('diagnostics.loginForm');}
   else if(signals?.hasContent){state='accessible';summary=t('diagnostics.accessible');}
   else{summary=t('diagnostics.emptyPage');}
  }
  // A failed navigation can replace the document while the read-only CDP probe runs.
  // Preserve its known failure instead of obscuring it with a transient probe result.
  if(session.status==='running'&&info?.requestFailure){state='network_error';summary=info.requestFailure;}
  const health:BrowserHealth={state,summary,checkedAt:Date.now(),httpStatus:info?.httpStatus??null,origin};session.health=health;checks.push({name:t('diagnostics.pageLogin'),status:state==='accessible'?'ok':state==='network_error'?'error':'warning',detail:summary});return {session:await this.state(workspaceId),checks,health};
 }
 /** Page diagnostics: is Chromium's sandbox on for the running browser, or will it be for the next start. */
 private sandboxCheck(session:LiveSession):BrowserDiagnostics['checks'][number]{
  const name=t('diagnostics.sandbox'),running=session.status==='running'&&session.sandbox;
  const mode=running?session.sandbox!.mode:browserSandboxMode(),fallback=running?session.sandbox!.fallbackReason:mode==='auto'?this.sandboxUnavailable??undefined:undefined;
  if(running&&session.sandbox!.enabled)return {name,status:'ok',detail:t('diagnostics.sandboxEnabled')};
  if(mode==='off')return {name,status:'warning',detail:t('diagnostics.sandboxDisabled')};
  if(fallback)return {name,status:'warning',detail:t('diagnostics.sandboxFallback',{reason:fallback})};
  return {name,status:'ok',detail:mode==='on'?t('diagnostics.sandboxForced'):t('diagnostics.sandboxAuto')};
 }
 private recordDialog(session:LiveSession,tabId:string,handle:PageDialog):void{const snapshot:BrowserDialog={id:randomUUID(),tabId,type:handle.type(),message:handle.message().slice(0,10000),defaultValue:handle.defaultValue().slice(0,10000),openedAt:Date.now()};session.pendingDialogs.set(snapshot.id,{snapshot,handle});this.advanceDialog(session);this.endInputStream(session);for(const notify of session.dialogWaiters)notify();}
 private advanceDialog(session:LiveSession):void{const pending=session.pendingDialogs.values().next().value;session.dialog=pending?.snapshot??null;session.dialogHandle=pending?.handle;}
 private clearPageDialogs(session:LiveSession,tabId:string):void{for(const [id,pending]of session.pendingDialogs)if(pending.snapshot.tabId===tabId)session.pendingDialogs.delete(id);this.advanceDialog(session);this.endInputStream(session);}
 private async handleDialog(session:LiveSession,dialogId:string,accept:boolean,promptText?:string,source:BrowserActivity['source']='manual'):Promise<BrowserSession>{
  const pending=session.dialog,handle=session.dialogHandle;if(!pending||!handle||pending.id!==dialogId)throw new Error(t('serverError.dialogRefresh'));
  const activity=session.activity.start(source,'handleDialog',this.activityPage(session,pending.tabId));
  try{if(accept)await handle.accept(pending.type==='prompt'?promptText:undefined);else await handle.dismiss();session.pendingDialogs.delete(dialogId);this.advanceDialog(session);this.endInputStream(session);await this.finishActivity(session,activity,false,pending.tabId);return this.state(session.workspaceId);}
  catch(error){await this.finishActivity(session,activity,true,pending.tabId);throw error;}
 }
 async setAgentId(workspaceId:string,agentId:string|null):Promise<void>{const session=this.session(workspaceId);session.agentId=agentId;await this.atomicPrivate(path.join(path.dirname(this.metadataPath(workspaceId)),'agent.json'),JSON.stringify({agentId})+'\n');}
 async getAgentId(workspaceId:string):Promise<string|null>{const session=this.session(workspaceId);await this.load(session);return session.agentId;}
 private async stopSession(session:LiveSession,preserveDesired:boolean):Promise<void>{
  if(session.recoveryTimer){clearTimeout(session.recoveryTimer);session.recoveryTimer=undefined;}if(session.persistTimer){clearTimeout(session.persistTimer);session.persistTimer=undefined;}
  this.rememberTabs(session);session.stopping=true;if(!preserveDesired)session.desiredRunning=false;session.activity.failRunning(true);session.leases.clear();let persistenceError:unknown;try{await this.persist(session);}catch(error){persistenceError=error;}
  const child=session.child;session.generation++;this.endInputStream(session);session.token=null;session.viewers.clear();session.sandbox=null;
  // Disconnecting must not wait on a page that stopped answering; the process is ended below either way.
  if(session.browser)await withTimeout(session.browser.close().catch(()=>{}),3000,()=>undefined);
  if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([new Promise<void>(resolve=>child.once('exit',()=>resolve())),sleep(3000)]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
  session.browser=undefined;session.context=undefined;session.child=undefined;session.pages.clear();session.pageState.clear();session.pageCdp.clear();session.pendingDialogs.clear();session.dialog=null;session.dialogHandle=undefined;session.pendingPages.clear();session.trackTail=Promise.resolve();session.activeId=null;session.lastFrame=undefined;session.status='idle';session.error=null;session.health=null;session.uptimeStart=null;await unlink(this.metadataPath(session.workspaceId)).catch(()=>{});if(persistenceError)throw persistenceError;
 }
 /** Retire independently of manual/Agent mode: an archived workspace can no longer own a running browser. */
 async retireWorkspace(workspaceId:string):Promise<void>{
  safeId(workspaceId);const pending=this.retiring.get(workspaceId);if(pending)return pending;
  const session=this.session(workspaceId,true);this.retired.add(workspaceId);
  const operation=(async()=>{
   await this.load(session);const orphanPid=session.child?null:await this.ownedProcessId(workspaceId);
   session.desiredRunning=false;session.stopping=true;session.token=null;session.leases.clear();
   if(orphanPid)await this.stopOwnedProcess(workspaceId,orphanPid);
   await this.stopSession(session,false);
   await withTimeout(session.starting?.catch(()=>{})??Promise.resolve(),5000,()=>undefined);
   await session.artifactTask?.catch(()=>{});await session.persistTail;
   this.sessions.delete(workspaceId);this.workspaceDirectories.delete(workspaceId);
  })();this.retiring.set(workspaceId,operation);
  try{await operation;}finally{this.retiring.delete(workspaceId);}
 }
 /** A restored workspace keeps its id (the daemon unarchives the same record), so its browser may start again with its saved state and Profile. */
 async unretire(workspaceId:string):Promise<void>{safeId(workspaceId);await this.retiring.get(workspaceId)?.catch(()=>{});this.retired.delete(workspaceId);}
 /** Only an exact Profile argument from a private session.json may identify an old plugin-owned process. */
 private async ownedProcessId(workspaceId:string):Promise<number|null>{
  try{
   const metadata=await readPrivateJson(this.metadataPath(workspaceId),1_048_576) as {browserPid?:unknown};
   const pid=metadata.browserPid;if(typeof pid!=='number'||!Number.isInteger(pid)||pid<1)return null;
   const info=await lstat(`/proc/${pid}`);if(process.getuid&&info.uid!==process.getuid())return null;
   const command=await readFile(`/proc/${pid}/cmdline`,'utf8'),args=command.split('\0'),profile=`--user-data-dir=${path.join(path.dirname(this.metadataPath(workspaceId)),'profile')}`;
   // Chromium may rewrite argv to one space-separated process title; the full Profile value must still match.
   const has=(argument:string)=>args.includes(argument)||` ${command.replace(/\0/g,' ')} `.includes(` ${argument} `);
   return has(profile)&&has('--remote-debugging-address=127.0.0.1')?pid:null;
  }catch{return null;}
 }
 private async stopOwnedProcess(workspaceId:string,pid:number):Promise<void>{
  // PID reuse cannot authorize stopping an unrelated process.
  if(await this.ownedProcessId(workspaceId)!==pid)return;
  try{process.kill(pid,'SIGTERM');}catch{return;}
  for(let attempt=0;attempt<20;attempt++){await sleep(100);if(await this.ownedProcessId(workspaceId)!==pid)return;}
  if(await this.ownedProcessId(workspaceId)===pid)try{process.kill(pid,'SIGKILL');}catch{}
 }
 async listOrphans(validWorkspaceIds:string[]):Promise<BrowserOrphan[]>{
  const valid=new Set(validWorkspaceIds),ids=new Set(this.sessions.keys());
  for(const entry of await readdir(this.dataRoot,{withFileTypes:true}).catch(()=>[]))if(entry.isDirectory()&&!entry.isSymbolicLink()&&/^[A-Za-z0-9_-]{1,120}$/.test(entry.name))ids.add(entry.name);
  const items:BrowserOrphan[]=[];
  for(const workspaceId of ids){
   if(valid.has(workspaceId))continue;
   const live=this.sessions.get(workspaceId);if(live)await this.load(live);
   let desiredRunning=live?.desiredRunning??false;
   if(!live)try{desiredRunning=(await readPrivateJson(this.statePath(workspaceId),1_048_576) as {desiredRunning?:boolean}).desiredRunning===true;}catch{}
   const pid=live?.child?.pid??await this.ownedProcessId(workspaceId),data=await this.savedData(workspaceId);
   const details={label:data?.label??live?.label??null,profileBytes:data?.bytes??null,lastUsedAt:data?.lastUsedAt??null};
   if(desiredRunning||pid||live?.starting||live?.recoveryTimer)items.push({workspaceId,kind:'process',status:live?.status??(pid?'running':'idle'),pid:pid??null,desiredRunning,...details});
   else if(data)items.push({workspaceId,kind:'profile',status:'idle',pid:null,desiredRunning:false,...details});
  }
  return items;
 }
 /** Size and last use of what is kept for a workspace (Profile, state, files), without following links; null when nothing is left. */
 private async savedData(workspaceId:string):Promise<{bytes:number;lastUsedAt:number;label:string|null}|null>{
  const root=path.join(this.dataRoot,safeId(workspaceId)),info=await lstat(root).catch(()=>null);
  if(!info||!info.isDirectory()||info.isSymbolicLink())return null;
  let bytes=0,seen=0,lastUsedAt=info.mtimeMs,label:string|null=null;const pending=[root];
  while(pending.length&&seen<50_000){
   const directory=pending.pop()!,entries=await readdir(directory,{withFileTypes:true}).catch(()=>[]);
   for(const entry of entries){seen++;const file=path.join(directory,entry.name);if(entry.isDirectory())pending.push(file);else if(entry.isFile())bytes+=(await lstat(file).catch(()=>null))?.size??0;}
  }
  try{lastUsedAt=(await lstat(this.statePath(workspaceId))).mtimeMs;const saved=await readPrivateJson(this.statePath(workspaceId),1_048_576) as {label?:unknown};if(typeof saved.label==='string')label=saved.label.slice(0,160);}catch{}
  return {bytes,lastUsedAt:Math.round(lastUsedAt),label};
 }
 /** Deletes everything kept for a workspace that is gone: its Profile (logins, cookies, cache), saved tabs and files. Never for a current workspace. */
 async deleteOrphan(workspaceId:string,validWorkspaceIds:string[]):Promise<void>{
  safeId(workspaceId);if(validWorkspaceIds.includes(workspaceId))throw new Error(t('serverError.workspaceStillAvailable'));
  if(!(await this.listOrphans(validWorkspaceIds)).some(item=>item.workspaceId===workspaceId))return;
  await this.retireWorkspace(workspaceId);
  if(await this.ownedProcessId(workspaceId))throw new Error(t('serverError.browserStillRunning'));
  const root=path.join(this.dataRoot,workspaceId),info=await lstat(root).catch(()=>null);
  if(!info||!info.isDirectory()||info.isSymbolicLink())return;
  await rm(root,{recursive:true,force:true});
 }
 async stopOrphan(workspaceId:string,validWorkspaceIds:string[]):Promise<void>{
  if(validWorkspaceIds.includes(workspaceId))throw new Error(t('serverError.stopInPanel'));
  if(!(await this.listOrphans(validWorkspaceIds)).some(item=>item.workspaceId===workspaceId))return;
  await this.retireWorkspace(workspaceId);
 }
 async close():Promise<void>{this.disposed=true;this.stopText();if(this.maintenanceTimer)clearInterval(this.maintenanceTimer);await Promise.allSettled([...this.sessions.values()].map(async session=>{if(session.recoveryTimer)clearTimeout(session.recoveryTimer);session.stopping=true;await session.starting?.catch(()=>{});await this.stopSession(session,true);}));if(this.gate)await new Promise<void>(resolve=>{this.gate!.close(()=>resolve());this.gate!.closeAllConnections();});this.gate=undefined;this.gateEndpoint=undefined;}
}
