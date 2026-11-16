import { createLocaleService } from './server/i18n-server';
import { BUILTIN_CATALOGS } from './server/locales';
import { registerClientChunks } from "./server/ui-chunk";
import type { PluginServerContext, PluginHandlerContext } from '@getpaseo/plugin/server';
import { actionRpc, agentRpc, deleteOrphanRpc, diagnosticsRpc, frameRpc, inputRpc, optionsRpc, orphanRpc, overviewRpc, portsRpc, readPageRpc, servicesRpc, startRpc, stateRpc, stopOrphanRpc, type BrowserSession } from './shared/browser';
import { BrowserManager, withoutAddresses } from './server/browser-manager';
import { BrowserAgentDirectory, BrowserAgentService, WorkspaceDirectory, browserOptions, workspaceServices, type PaseoWorkspace } from './server/service';
import { BrowserOverviewService } from './server/overview';
import { AgentPortService } from './server/agent-ports';

type Paseo=PluginHandlerContext['paseo'];

export default function contribute(server:PluginServerContext,deps:{manager?:BrowserManager;directory?:WorkspaceDirectory;ports?:AgentPortService}={}){
 const locales=createLocaleService(server,{pluginId:'server-browser',builtins:BUILTIN_CATALOGS});
 registerClientChunks(server);
 const manager=deps.manager??new BrowserManager(),directory=deps.directory??new WorkspaceDirectory(),agentDirectory=new BrowserAgentDirectory(),agents=new BrowserAgentService(manager,agentDirectory),overview=new BrowserOverviewService(manager,paseo=>directory.list(paseo),agentDirectory);
 // Ports Agents opened: scanned only while a viewer polls (the services sheet is open, the app in front).
 const ports=deps.ports??new AgentPortService(paseo=>directory.list(paseo));
 let restoreTask:Promise<void>|undefined;
 // An RPC error reaches the client and the daemon log as its message. Playwright names the whole page address there (query,
 // fragment and redirect target too), so every message loses its page addresses, as the saved state does.
 // Paseo 0.16 overloads `handle` (RPCs and subscriptions); this wrapper only ever registers RPCs, typed as the RPC overload.
 type Handle=PluginServerContext['handle'];
 const handle=((contract:Parameters<Handle>[0],handler:Parameters<Handle>[1])=>server.handle(contract,async(input,context)=>{try{return await handler(input,context);}catch(error){throw new Error(withoutAddresses(error));}})) as Handle;
 // An archived workspace that comes back (restored, or its directory reopened) gets its browser back.
 directory.onRestore(workspaceId=>manager.unretire(workspaceId));
 // The Agent bridge accepts file uploads only from the workspace's own directory, as the daemon reports it; the name labels leftovers.
 const remember=(workspace:PaseoWorkspace)=>manager.setWorkspaceDirectory(workspace.id,workspace.workspaceDirectory??workspace.projectRootPath,[workspace.projectDisplayName,workspace.title??workspace.name].filter(Boolean).join(' / '));
 const restore=(paseo:Paseo)=>{
  if(!restoreTask)restoreTask=directory.list(paseo).then(workspaces=>{
   for(const workspace of workspaces)remember(workspace);
   // Restore in the background: a slow site must not stall every panel RPC or Agent startup.
   // i18n-ignore: daemon log only.
   void manager.restore(workspaces.map(item=>item.id)).catch(()=>console.warn('部分服务器浏览器未能恢复，请查看对应工作区的状态与诊断。'));
  }).catch(error=>{restoreTask=undefined;throw error;});
  return restoreTask;
 };
 // Lifecycle events only start restoration, so an Agent never waits on (or fails because of) the workspace listing; the
 // MCP bridge waits for a restoring browser itself. No before('agent.session_open') hook: from Paseo 0.14 every start,
 // stop or reload of a plugin with one makes each open Agent session reopen (provider process restarted) before its next prompt.
 // i18n-ignore: daemon log only.
 const restoreSoon=(paseo:Paseo)=>{void restore(paseo).catch(()=>console.warn('服务器浏览器暂时无法核对工作区，将在下次面板或 Agent 活动时重试恢复。'));};
 const validate=async(paseo:Paseo,workspaceId:string)=>{remember(await directory.require(paseo,workspaceId));await restore(paseo);};
 const linkedState=async(paseo:Paseo,session:BrowserSession)=>{
  const {availability}=await agentDirectory.inspect(paseo,session.workspaceId,session.agentId);
  manager.setAgentAvailability(session.workspaceId,availability);return {...session,agentAvailability:availability};
 };
 handle(optionsRpc,async(_input,{paseo})=>{await restore(paseo);return browserOptions(paseo,directory);});
 handle(overviewRpc,async({revision},{paseo})=>{await restore(paseo);const result=await overview.list(paseo);return revision&&revision===result.revision?{unchanged:true,revision,checkedAt:result.checkedAt}:result;});
 handle(startRpc,async({workspaceId},{paseo})=>{await validate(paseo,workspaceId);return linkedState(paseo,await manager.start(workspaceId));});
 handle(stateRpc,async({workspaceId},{paseo})=>{await validate(paseo,workspaceId);return linkedState(paseo,await manager.state(workspaceId));});
 handle(frameRpc,async({workspaceId,after,quality,maxWidth,maxHeight,sessionRevision,viewerId},{paseo})=>{await validate(paseo,workspaceId);const {availability}=await agentDirectory.inspect(paseo,workspaceId,await manager.getAgentId(workspaceId));manager.setAgentAvailability(workspaceId,availability);return manager.frame(workspaceId,after,quality,{maxWidth,maxHeight,sessionRevision,viewerId});});
 // openPort names a port of the latest listing; the server opens the address it found for it, as a manual new tab.
 handle(actionRpc,async({workspaceId,action,target},{paseo})=>{await validate(paseo,workspaceId);const run=action.kind==='openPort'?{kind:'newTab' as const,url:await ports.target(paseo,workspaceId,action.port)}:action;return linkedState(paseo,await manager.action(workspaceId,run,target));});
 handle(inputRpc,async(input,{paseo})=>{await validate(paseo,input.workspaceId);const result=await manager.input(input.workspaceId,input);return {...result,session:await linkedState(paseo,result.session)};});
 handle(servicesRpc,async({workspaceId},{paseo})=>{const workspace=await directory.current(paseo,workspaceId);remember(workspace);return {items:workspaceServices(workspace)};});
 handle(portsRpc,async({workspaceId,revision},{paseo})=>{await validate(paseo,workspaceId);const result=await ports.list(paseo,workspaceId);return revision&&revision===result.revision?{supported:result.supported,unchanged:true,revision,scannedAt:result.scannedAt}:result;});
 handle(agentRpc,async({workspaceId,profileId},{paseo})=>{await validate(paseo,workspaceId);const result=await agents.create(paseo,workspaceId,profileId);return {...result,session:await linkedState(paseo,result.session)};});
 handle(diagnosticsRpc,async({workspaceId},{paseo})=>{await validate(paseo,workspaceId);const result=await manager.diagnostics(workspaceId);return {...result,session:await linkedState(paseo,result.session)};});
 handle(readPageRpc,async(input,{paseo})=>{await validate(paseo,input.workspaceId);return manager.read(input.workspaceId,input);});
 server.on('agent.turn_started',({agent},{paseo})=>{ports.invalidateAgent(agent.id);restoreSoon(paseo);});
 // Orphan cleanup deliberately bypasses require(): an archived workspace has no normal panel entry.
 handle(orphanRpc,async(_input,{paseo})=>({items:await manager.listOrphans((await directory.list(paseo)).map(item=>item.id))}));
 // Stopping or deleting a leftover retires that workspace in the manager; the directory records it too, so that if the
 // daemon restores the workspace later (same id, no event) the next listing gives it its browser back, as after an archive.
 handle(stopOrphanRpc,async({workspaceId},{paseo})=>{directory.invalidate();await manager.stopOrphan(workspaceId,(await directory.list(paseo)).map(item=>item.id));directory.retire(workspaceId);return {stopped:true as const};});
 // Deleting logins needs a complete, fresh listing: a workspace that is still there is refused.
 handle(deleteOrphanRpc,async({workspaceId},{paseo})=>{directory.invalidate();await manager.deleteOrphan(workspaceId,(await directory.list(paseo)).map(item=>item.id));directory.retire(workspaceId);return {deleted:true as const};});
 const invalidateAgent=(agent:{id:string;workspaceId:string|null})=>{agentDirectory.invalidate(agent.workspaceId??undefined);overview.invalidate();ports.invalidateAgent(agent.id);};
 server.on('agent.archived',({agent})=>{invalidateAgent(agent);});
 server.on('agent.closed',({agent})=>{invalidateAgent(agent);});
 server.on('agent.created',({agent},{paseo})=>{invalidateAgent(agent);restoreSoon(paseo);});
 server.on('workspace.created',()=>{directory.invalidate();overview.invalidate();});
 server.on('workspace.archived',async({workspace})=>{directory.retire(workspace.id);agentDirectory.invalidate(workspace.id);overview.invalidate();await manager.retireWorkspace(workspace.id);});
 return async()=>{locales.dispose();await manager.close();};
}
