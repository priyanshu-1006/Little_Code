// Owned-fixture service probe. Credentials stay inside native SecretStorage.
// Proposal cases reject every review and verify unchanged bytes; no edits/commands apply.
import { mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import path from 'node:path';
import { projectRoot, packagedRoot, packagedExecutable } from './desktop-paths.mjs';

const ownedRoot = path.join(projectRoot, 'desktop', 'profile', `groq-live-probe-${Date.now()}-${process.pid}`);
const extensionRoot = path.join(ownedRoot, 'extension');
const workspaceRoot = path.join(ownedRoot, 'workspace');
const resultPath = path.join(projectRoot, 'desktop', 'logs', 'groq-live-probe.json');
const selectedCase = process.argv.find(value => value.startsWith('--case='))?.slice(7);
const allowedCases = ['plain','minimal-strict',
  'runtime-read','runtime-agent','runtime-agent-full','runtime-greeting','runtime-models','runtime-notebooks',
  'runtime-file-notebook','runtime-file-docx','runtime-file-pdf','runtime-file-notebook-edit','runtime-file-delete-slide'];
if (selectedCase && !allowedCases.includes(selectedCase)) throw new Error('Unknown owned Groq probe case.');
const probeId = path.basename(ownedRoot);
await mkdir(extensionRoot, { recursive: true });
await mkdir(workspaceRoot, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(path.join(workspaceRoot, 'README.md'), '# Owned probe fixture\nVerification phrase: amber-orbit-42\nNo user project content is used.\n');
if (selectedCase === 'runtime-notebooks' || selectedCase?.startsWith('runtime-file-notebook')) {
  await writeFile(path.join(workspaceRoot, 'lesson.ipynb'), JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
    { cell_type: 'markdown', metadata: {}, source: ['# Notebook classification lesson\n', 'Predict a binary target from two numerical features.\n', 'Verification phrase: amber-orbit-42\n'] },
    { cell_type: 'code', metadata: {}, execution_count: null, outputs: [{ output_type: 'stream', name: 'stdout', text: 'EXCLUDED_OUTPUT_SENTINEL' }], source: [
      'from sklearn.preprocessing import StandardScaler\n', 'from sklearn.model_selection import train_test_split\n',
      'X = [[1, 2], [3, 4], [5, 6], [7, 8]]\n', 'y = [0, 0, 1, 1]\n',
      'scaled = StandardScaler().fit_transform(X)\n', 'X_train, X_test, y_train, y_test = train_test_split(scaled, y, test_size=0.5, random_state=7)\n'] },
  ] }));
  await writeFile(path.join(workspaceRoot, 'support.py'), 'def normalize(values):\n    total = sum(values)\n    return [value / total for value in values]\n');
}
await writeFile(path.join(extensionRoot, 'package.json'), JSON.stringify({ name: 'little-code', publisher: 'priyanshu-chaurasia',
  version: '0.1.0', engines: { vscode: '^1.96.0' }, main: './probe.cjs', activationEvents: ['*'] }));
const source = `
import * as vscode from 'vscode';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { GroqProvider, GROQ_SECRET_KEY } from './src/little/providers/groq';
import { groqRequestId, groqLimits } from './src/little/providers/groq-errors';
import { RequestBudget, quotaWait } from './src/little/context/request-budget';
import { createReadOnlyTools } from './src/little/tools/read-only-tools';
import { createNotebookTools } from './src/little/tools/notebook-tools';
import { createDocumentReadTools } from './src/little/tools/document-tools';
import { createDocx, createPptx } from './src/little/tools/document-ooxml';
import { generatePdf } from './src/little/tools/document-pdf';
import * as path from 'node:path';
import { collectContext } from './src/little/context/collect-context';
import { createRepositoryTools } from './src/little/tools/repository-tools';
import { createGitTools } from './src/little/tools/git-tools';
import { RepositoryIndex } from './src/little/context/repository-index';
import { WorkspaceService } from './src/little/tools/workspace-service';
import { AgentRuntime } from './src/little/agent/runtime';
import { redactSecrets } from './src/little/context/redact-secrets';
import { createEditTools } from './src/little/tools/edit-tools';
import { createNotebookEditTools } from './src/little/tools/notebook-edit-tools';
import { EditProposalService } from './src/little/tools/edit-proposals';
import { createCommandTools } from './src/little/tools/command-tools';
const destination = ${JSON.stringify(resultPath)};
const extensionPath = ${JSON.stringify(extensionRoot)};
const fixturePath = ${JSON.stringify(workspaceRoot)};
const codes = new Set(['invalid_request_error','json_validate_failed','structured_generation_failed','tool_use_failed','invalid_api_key','rate_limit_exceeded','model_not_found']);
const fingerprints = [
 ['schema_generation', /generated json|json.*(?:validation|validate).*failed|schema.*generation.*fail/i],
 ['schema_input', /invalid (?:json )?schema|schema.*invalid|schema.*not supported/i],
 ['schema_complexity', /too complex|too large|complexity|grammar.*(?:size|limit|compile)/i],
 ['any_of', /anyOf/i], ['empty_object', /empty object|empty properties|properties.*empty/i],
 ['nullable', /nullable|type.*null|unsupported.*null/i], ['required', /required/i],
 ['additional_properties', /additionalProperties/i], ['strict', /strict/i], ['grammar', /grammar|constrained/i],
 ['reasoning', /reasoning/i], ['unsupported_parameter', /unsupported parameter|not supported|not permitted|not allowed/i],
 ['schema_description', /description/i],
];
function metadata(status: number, headers: Headers, value: any) {
 const e = value?.error ?? {};
 const text = typeof e.message === 'string' ? e.message.slice(0,8192) : '';
 const parameter = ['response_format','reasoning_effort','include_reasoning','max_completion_tokens','messages','model'].find(p =>
   typeof e.param === 'string' && (e.param === p || e.param.startsWith(p+'.') || e.param.startsWith(p+'[')));
 const schemaKeys = new Set(['properties','decision','anyOf','arguments','kind','answer','name','path','query','caseSensitive','limit','startLine','endLine','required','additionalProperties','type','enum','items']);
 const context = text.match(/In context=(\\([^)]{0,400}\\))/i)?.[1];
 const tokens = context ? [...context.matchAll(/['"]([^'"]+)['"]|\\b(\\d{1,3})\\b/g)].map(match=>match[1] ?? Number(match[2])) : undefined;
 const schemaPath = tokens?.every(token=>typeof token==='number' ? token<128 : schemaKeys.has(token)) ? tokens : undefined;
 const missing = text.match(/missing(?: required)?(?: (?:property|key))? ['"]([^'"]+)['"]/i)?.[1];
 const extra = text.match(/extra required key ['"]([^'"]+)['"]/i)?.[1];
 const vocabulary = new Set('invalid schema response format anyof required properties property fields field keys key must should have has be is not no all every each same different identical unique consistent sets set branches branch type object string null nullable array empty missing extra additional additionalproperties supported unsupported allowed disallowed error because root nested schemas union discriminated discriminator cannot can only one at least more than multiple include includes including contain contains context name arguments answer decision'.split(' '));
 const validationWords = (text.toLowerCase().match(/[a-z_]+/g) ?? []).filter(word=>vocabulary.has(word)).slice(0,100);
 return { status, ...(codes.has(e.code) ? { providerCode: e.code } : {}),
  ...(e.type === 'invalid_request_error' || e.type === 'server_error' ? { providerType: e.type } : {}),
  ...(parameter ? { parameter } : {}), ...(schemaPath ? {schemaPath} : {}),
  ...(missing && schemaKeys.has(missing) ? {missingRequiredProperty:missing} : {}), ...(extra && schemaKeys.has(extra) ? {extraRequiredProperty:extra} : {}),
  requiredAllProperties: /required.*(?:including|every|all).*properties/i.test(text),
  validationWords,
  reasonFingerprints: fingerprints.filter(([,regex]) => (regex as RegExp).test(text)).map(([name]) => name),
  requestId: groqRequestId(headers.get('x-request-id')) ?? groqRequestId(value?.x_groq?.id), limits: groqLimits(headers) };
}
export async function activate(context: vscode.ExtensionContext) {
 if(context.extensionMode !== vscode.ExtensionMode.Development || context.extension.id !== 'priyanshu-chaurasia.little-code' ||
   context.extensionPath.toLowerCase() !== extensionPath.toLowerCase() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath.toLowerCase() !== fixturePath.toLowerCase()) return;
 const report: any = { probeId: ${JSON.stringify(probeId)}, startedAt: new Date().toISOString(), credentialMechanism: 'native SecretStorage in extension host',
  noUserProjectContent: true, configured: false, probes: [], ownedExtensionHostPid:process.pid, closedOwnedWindow: false };
 try {
  const key = await context.secrets.get(GROQ_SECRET_KEY);
  report.configured = !!key?.trim();
  if(key?.trim()) {
   const editor = { snapshot: () => ({ openFiles: [], diagnostics: [] }) };
   const workspace = new WorkspaceService(fixturePath);
   const selected = ${JSON.stringify(selectedCase)};
   if (selected === 'runtime-file-docx') await writeFile(path.join(fixturePath, 'report.docx'), createDocx('Owned document fixture\\nVerification phrase: amber-orbit-42'));
   if (selected === 'runtime-file-pdf') await writeFile(path.join(fixturePath, 'report.pdf'), await generatePdf('Owned PDF fixture\\nVerification phrase: amber-orbit-42'));
   if (selected === 'runtime-file-delete-slide') await writeFile(path.join(fixturePath, 'slides.pptx'), createPptx('Owned slide fixture\\nVerification phrase: amber-orbit-42'));
   const tools = [...createReadOnlyTools(workspace,editor), ...createNotebookTools(workspace), ...createDocumentReadTools(workspace), ...createGitTools(workspace), ...createRepositoryTools(editor,new RepositoryIndex(workspace))];
   const model = 'openai/gpt-oss-120b';
   if(selected === 'runtime-models') {
    const provider = new GroqProvider(context.secrets);
    const models = await provider.listModels(AbortSignal.timeout(45000));
    const supported = ['openai/gpt-oss-120b','openai/gpt-oss-20b'].map(id=>({id,discovered:models.some(value=>value.id===id),tools:models.find(value=>value.id===id)?.capabilities.tools}));
    report.probes.push({name:selected,discoveredCount:models.length,supported,passed:supported.every(value=>value.discovered && value.tools===true)});
   } else if(selected === 'runtime-read' || selected === 'runtime-agent' || selected === 'runtime-agent-full' || selected === 'runtime-greeting' || selected === 'runtime-notebooks' || selected?.startsWith('runtime-file-')) {
    const requests: any[] = [];
    const provider = new GroqProvider(context.secrets, async (url, init) => {
     const body = JSON.parse(String(init?.body));
     const response = await fetch(url, init);
     let wireDecision: any;
     if (response.ok && body.response_format) {
      const envelope: any = await response.clone().json().catch(()=>undefined);
      let value: any; try { value = JSON.parse(envelope?.choices?.[0]?.message?.content); } catch {}
      wireDecision = { finishReason:envelope?.choices?.[0]?.finish_reason,
       keys:value && typeof value === 'object' ? Object.keys(value).filter(key=>['kind','answer','arguments_json','payload','decision'].includes(key)) : [],
       kind:['answer',...(body.response_format.json_schema.schema.properties?.kind?.enum ?? [])].includes(value?.kind) ? value.kind : 'unknown',
       argumentsCharacters:typeof value?.arguments_json === 'string' ? value.arguments_json.length : undefined,
       answerCharacters:typeof value?.answer === 'string' ? value.answer.length : undefined,
       payloadCharacters:typeof value?.payload === 'string' ? value.payload.length : undefined };
     }
     requests.push({ status:response.status, requestId:groqRequestId(response.headers.get('x-request-id')),wireDecision,
      structured:body.response_format?.json_schema?.strict === true, stream:body.stream,
      offeredTools:body.tools?.length ?? 0, offeredNames:(body.tools ?? []).map((tool: any)=>tool.function?.name).filter((name: unknown)=>typeof name==='string'), parallelToolCalls:body.parallel_tool_calls,
      sourceContainsFixturePhrase:(body.messages ?? []).some((message: any)=>message.role==='tool' && typeof message.content==='string' && message.content.includes('amber-orbit-42')),
      estimatedTokens:Math.ceil(Buffer.byteLength(JSON.stringify(body),'utf8')/3)+64+body.max_completion_tokens,
      limits:groqLimits(response.headers) });
     return response;
    });
    let collected = 0;
    const safeOnly = () => { throw new Error('The owned live probe cannot review or execute a mutation.'); };
    const rejectedReviews: any[] = [];
    const mutationFile = selected === 'runtime-file-delete-slide' ? 'slides.pptx' : 'lesson.ipynb';
    const notebookOriginal = ['runtime-file-notebook-edit','runtime-file-delete-slide'].includes(selected) ? await readFile(path.join(fixturePath,mutationFile)) : undefined;
    if(notebookOriginal) await mkdir(path.join(extensionPath,'private-checkpoints'),{recursive:true});
    const rejectReview = async (proposal: any)=>{
      rejectedReviews.push({status:'rejected',files:proposal.changes.map((change: any)=>({path:change.path,kind:change.kind}))});
      return {status:'rejected' as const};
    };
    const offered = selected === 'runtime-file-notebook-edit' ? [...tools,...createNotebookEditTools(workspace,
      new EditProposalService(workspace,path.join(extensionPath,'private-checkpoints')),rejectReview,()=>{})]
      : selected === 'runtime-file-delete-slide' ? [...tools,...createEditTools(new EditProposalService(workspace,path.join(extensionPath,'private-checkpoints')),rejectReview,()=>{})]
      : selected === 'runtime-agent-full' ? [...tools,...createEditTools({} as any,async()=>safeOnly(),safeOnly),...createCommandTools({} as any,async()=>safeOnly())] : tools;
    const targetFile = selected.startsWith('runtime-file-notebook') ? 'lesson.ipynb' : selected === 'runtime-file-docx' ? 'report.docx' : selected === 'runtime-file-pdf' ? 'report.pdf' : selected === 'runtime-file-delete-slide' ? 'slides.pptx' : 'README.md';
    const runtime = new AgentRuntime(provider,offered,async(signal)=>{ collected++; return selected === 'runtime-notebooks'
      ? collectContext(workspace,editor,signal,{query:'analyse the notebooks and codebase for me',index:new RepositoryIndex(workspace)})
      : {text:'Owned fixture contains '+targetFile+'. Its contents have not been collected; use a file reader for current evidence.',items:[]}; },
     {maxIterations:6,maxUsageTokens:16000,timeoutMs:150000,workspaceRoot:fixturePath});
    const result: any = { name:selected, requests, toolStarts:[], toolCompletions:[], completed:false, answerHasFixturePhrase:false, answerCharacters:0, usage:{input:0,output:0} };
    runtime.events.subscribe(event=>{
     if(event.type==='tool.started') {
      result.toolStarts.push(event.call.name);
      (result.ownedFixtureCalls ??= []).push({name:event.call.name,arguments:redactSecrets(event.call.arguments).slice(0,12000)});
     }
     if(event.type==='tool.completed') result.toolCompletions.push(event.name);
     if(event.type==='tool.failed') {
      result.toolFailure=event.code;
      (result.toolFailures ??= []).push({name:event.name,code:event.code,message:redactSecrets(event.message).slice(0,1000)});
     }
     if(event.type==='agent.text.delta') { result.answerCharacters+=event.text.length;
      result.ownedFixtureAnswer=redactSecrets((result.ownedFixtureAnswer ?? '')+event.text).slice(0,8000);
      result.answerHasExactFixturePhrase=result.ownedFixtureAnswer.includes('amber-orbit-42');
      result.answerHasFixturePhrase=result.ownedFixtureAnswer.replace(/[\u2010-\u2015]/g,'-').includes('amber-orbit-42');
      result.answerReasons=[['file_access_refusal',/cannot|can't|unable|no access|don't have access/i],['human_input_requested',/paste|provide|upload|share/i]].filter(([,pattern])=>(pattern as RegExp).test(event.text)).map(([name])=>name); }
     if(event.type==='agent.usage') { result.usage.input+=event.inputTokens; result.usage.output+=event.outputTokens; }
     if(event.type==='agent.completed') result.completed=true;
     if(event.type==='agent.failed') result.failure={code:event.code,diagnostic:event.diagnostic};
    });
    const filePrompt = selected==='runtime-file-delete-slide' ? 'Delete slides.pptx.' : selected==='runtime-file-notebook-edit'
      ? 'Read lesson.ipynb using read_notebook. Use propose_notebook_edits to edit cell 1: uniquely replace amber-orbit-42 with amber-orbit-43. The host will reject review; respect that rejection, report that nothing changed, and do not resubmit.'
      : 'Read '+targetFile+' using '+(selected==='runtime-file-notebook'?'read_notebook':'read_document')+', then copy its verification phrase in inline code without changing characters and cite the '+(selected==='runtime-file-notebook'?'cell':selected==='runtime-file-docx'?'paragraph':'page')+'. Do not answer before reading the file.';
    await runtime.run({model,mode:notebookOriginal?'edit':selected.includes('runtime-agent')?'agent':'ask',prompt:selected==='runtime-notebooks'?'analyse the notebooks and codebase for me':selected==='runtime-greeting'?'Hi':selected.startsWith('runtime-file-')?filePrompt:'Read README.md using read_file, then report its verification phrase exactly and cite README.md. Do not answer before reading the file.'});
    result.contextCollections=collected;
    if(notebookOriginal) {
      result.rejectedReviews=rejectedReviews;
      result.fixtureUnchanged=notebookOriginal.equals(await readFile(path.join(fixturePath,mutationFile)));
    }
    // Verify source-grounded analysis and protocol completion; finding every possible defect is model-quality acceptance, not a transport invariant.
    result.passed=result.completed && !result.failure && (selected==='runtime-notebooks' ? /lesson\.ipynb/.test(result.ownedFixtureAnswer ?? '') && /support\.py/.test(result.ownedFixtureAnswer ?? '') && /cell/i.test(result.ownedFixtureAnswer ?? '') && /StandardScaler/.test(result.ownedFixtureAnswer ?? '') && /train_test_split/.test(result.ownedFixtureAnswer ?? '') && /normalize/.test(result.ownedFixtureAnswer ?? '') && !/EXCLUDED_OUTPUT_SENTINEL/.test(result.ownedFixtureAnswer ?? '') : selected==='runtime-greeting' ? collected===0 && result.toolStarts.length===0 && result.answerCharacters>0 : selected.startsWith('runtime-file-') ? result.toolCompletions.includes(selected==='runtime-file-notebook'?'read_notebook':'read_document') && result.answerHasFixturePhrase && result.ownedFixtureAnswer.includes(targetFile) : result.toolCompletions.includes('read_file') && result.answerHasFixturePhrase);
    if(notebookOriginal) result.passed=result.completed && !result.failure &&
      result.toolCompletions.includes(selected==='runtime-file-delete-slide'?'inspect_file':'read_notebook') &&
      result.toolCompletions.includes(selected==='runtime-file-delete-slide'?'propose_file_edits':'propose_notebook_edits') &&
      rejectedReviews.length===1 && result.fixtureUnchanged && /reject|declin|not (?:applied|changed)|no (?:files?|changes?)/i.test(result.ownedFixtureAnswer ?? '');
    else if(selected?.startsWith('runtime-file-')) result.passed=result.passed && requests.some(request=>request.sourceContainsFixturePhrase);
    report.probes.push(result);
   } else {
   const budget = new RequestBudget('groq',model,'ask','You are Little Code. Answer briefly; use read tools only when needed.','Hi', {text:'Owned probe fixture.',items:[]},tools);
   const messages = [{role:'user',content:'Say hello in one short sentence.'}];
   const cases = [
    { name:'plain', body:{model,messages,stream:false,include_reasoning:false,reasoning_effort:'low',max_completion_tokens:512} },
    { name:'minimal-strict', body:{model,messages:[{role:'user',content:'Return JSON with an answer saying hello.'}],stream:false,include_reasoning:false,reasoning_effort:'low',max_completion_tokens:1024,
      response_format:{type:'json_schema',json_schema:{name:'little_probe',strict:true,schema:{type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false}}}} },
   ];
   let limits: any;
   let totalEstimated = 0;
   for(const item of cases.filter(item=>!selected || item.name===selected)) {
    const cost = Math.ceil(Buffer.byteLength(JSON.stringify(item.body),'utf8')/3)+64+item.body.max_completion_tokens;
    totalEstimated += cost;
    if(totalEstimated > 7500) { report.probes.push({name:item.name,skipped:'bounded-total-budget'}); break; }
    const wait = quotaWait(limits,cost);
    if(wait && wait > 60000) { report.probes.push({name:item.name,skipped:'observed-cooldown'}); break; }
    if(wait) await new Promise(resolve=>setTimeout(resolve,wait));
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+key.trim(),'Content-Type':'application/json'},
      body:JSON.stringify(item.body),redirect:'error',signal:AbortSignal.timeout(45000)});
    const reader = response.body?.getReader();
    let body = '', size = 0;
    if(reader) try { for(;;) { const next = await reader.read(); if(next.done) break; size+=next.value.length; if(size>65536) break; body+=new TextDecoder().decode(next.value); } }
     finally { await reader.cancel().catch(()=>undefined); reader.releaseLock(); }
    let value: any; try { value=JSON.parse(body); } catch {}
    const safe = metadata(response.status,response.headers,value);
    limits=safe.limits;
    report.probes.push({ name:item.name, estimatedTokens:cost, ...safe, ...(response.ok ? { finishReason:value?.choices?.[0]?.finish_reason,
      usage:value?.usage ? {input:value.usage.prompt_tokens,output:value.usage.completion_tokens} : undefined } : {}) });
    if(response.status===401 || response.status===403 || response.status===429 || response.status>=500) break;
   }
   }
  }
 } catch { report.probeError='The bounded native live probe did not complete.'; }
 finally {
  report.completedAt=new Date().toISOString();
  report.closeOwnedWindowRequested=true;
  await writeFile(destination,JSON.stringify(report,null,2));
  // This verified development context owns only the new fixture window.
  await vscode.commands.executeCommand('workbench.action.closeWindow');
 }
}
`;
await build({ stdin: { contents: source, resolveDir: projectRoot, sourcefile: 'owned-groq-live-probe.ts', loader: 'ts' },
  outfile: path.join(extensionRoot, 'probe.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], sourcemap: false });
// The owned development host uses the same local parser worker/assets as the production bundle.
await cp(path.join(projectRoot, 'dist', 'document-pdf-worker.cjs'), path.join(extensionRoot, 'document-pdf-worker.cjs'));
await cp(path.join(projectRoot, 'dist', 'pdf'), path.join(extensionRoot, 'pdf'), { recursive: true });
const environment = { ...process.env };
for (const name of Object.keys(environment)) if (/(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)|^(?:ELECTRON_RUN_AS_NODE|VSCODE_DEV|NODE_OPTIONS|NODE_PATH)$/i.test(name)) delete environment[name];
// The existing profile provides SecretStorage through its API. Never copy or inspect its database.
const child = spawn(packagedExecutable,['--new-window',`--extensionDevelopmentPath=${extensionRoot}`,'--disable-extensions','--skip-release-notes',workspaceRoot],
 {cwd:packagedRoot,env:environment,windowsHide:true,stdio:'ignore'});
child.on('error',()=>{});
const deadline = Date.now()+180000;
let report;
while(Date.now()<deadline) {
 try { const next=JSON.parse(await readFile(resultPath,'utf8')); if(next.probeId===probeId) { report=next; break; } } catch {}
 await delay(250);
}
if(!report) throw new Error('Owned native probe did not return a result. No process tree was terminated.');
// Observe termination of this verified window's extension host; never terminate
// the application or any other window, and never treat a close request as proof.
if (Number.isSafeInteger(report.ownedExtensionHostPid) && report.ownedExtensionHostPid > 0) {
  const closeDeadline = Date.now()+5000;
  while(Date.now()<closeDeadline) {
    try { process.kill(report.ownedExtensionHostPid,0); } catch(error) {
      if(error.code==='ESRCH') report.closedOwnedWindow=true;
      break;
    }
    await delay(250);
  }
  await writeFile(resultPath,JSON.stringify(report,null,2));
}
if (selectedCase?.startsWith('runtime-') && !report.probes[0]?.passed) process.exitCode=1;
console.log(JSON.stringify(report,null,2));
