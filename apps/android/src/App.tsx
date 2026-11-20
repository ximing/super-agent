import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Alert, AppState, Image, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, TextInput, View} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';
import {StatusBar} from 'expo-status-bar';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import {api, authenticateOIDC, registerPush} from './native';
import {LoadedTaskTree,TaskRelations} from './TaskRelations';
import {DeliveryReview} from './DeliveryReview';
import {ToolTimeline} from './ToolTimeline';
import {Reconciliation} from './Reconciliation';
import {APIError} from './api';
import {SchedulesPanel, TaskArtifacts} from './Workflows';
import type {AgentTask, AuthConfig, Budget, CostBreakdown, CostPoint, CostSummary, Device, Engine, ExecutionSettings, Frame, List, Memory, MemorySettings, Message, Question, Run, Session} from './types';
import {consumeEventStream, eventCursorKey, EventStreamError, readEventStream, sleep, type StreamEvent} from './event-stream';
import {readOutboxFile, writeOutboxFile} from './outbox-file';
import {actionDraftLabel, actionRequestBody, asActionStatus, acceptEntityVersion, capabilitiesFrom, commitProjection, computerReceivedLine, countLabel, createPendingMessage, cursorAfterSnapshot, decideChat, devicePresence, dispatchSubmission, emptyOutbox, enqueueProjection, explicitCommand, failureKind, localRemoval, mergeActionReceipt, mergeActionReceipts, mergeByVersion, mergeCollection, messageRequestBody, pendingKey, phaseLabel, progressCue, projectionNeeds, pruneMatched, readRecord, reconnectVisible, removeMessage, reusableAction, reusableAnswer, runStageLabel, serverProcessingText, shareInflight, shouldResetCursor, shouldUseLegacyLoad, staleProgressText, submissionLabel, taskRequestBody, upsertAction, upsertAnswer, upsertMessage, visiblePending, type ActionDraft, type AnswerDraft, type ChatDecision, type ClientCapabilities, type OutboxFile, type PendingMessage, type ProjectionCursor, type TaskControlAction} from './interaction';
import {BUDGET_CATEGORIES, BUDGET_LIMITS, budgetDimension, categoryLimitsMerge, executionSettingsBody, memoryBindingBody, memoryGovernanceLine, memoryScopePayload, memorySettingsConflictMessage, moneyBudgetMerge, presentCostReservation, recoveryText, relationConflictMessage, storedBudgetValue, taskBudgetMerge, memoryRelationBody} from './payloads';

const colors = {ink: '#182B45', blue: '#315F9C', pale: '#EAF0F8', canvas: '#F4F6F9', surface: '#FFFFFF', muted: '#647488', line: '#DCE3EC', green: '#28735D', amber: '#91601A'};
const statuses: Record<string, string> = {blocked:'等待前置任务',queued:'排队中',running:'正在执行',waiting_input:'待你回答',waiting_device:'等待电脑',awaiting_approval:'待你确认',pausing:'正在暂停',paused:'已暂停',switching:'正在切换',awaiting_review:'待验收',succeeded:'已完成',failed:'失败',cancelled:'已取消',online:'在线',offline:'离线',busy:'忙碌',starting:'正在启动',dispatched:'已派发',result_unknown:'结果待核对',stopping:'正在停止',verified:'已验证',candidate:'待验证',stale:'待复核',revoked:'已撤销'};
const memoryTypes = [{value:'website',label:'网站档案'},{value:'procedure',label:'操作流程'},{value:'preference',label:'个人偏好'},{value:'project',label:'项目状态'},{value:'experience',label:'工作经验'}];
const sourceLabels: Record<string,string> = {supplier_reported:'供应商返回',estimated:'估算',unavailable:'不可核算'};
const sourceTitle = (source: string) => sourceLabels[source] ?? source;
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';
const time = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}); };
type Tab = '助理' | '任务' | '电脑' | '记忆' | '关注' | '成本';
type ChoiceOption = {value:string;label:string};

function Button({title,onPress,secondary=false,disabled=false,danger=false}: {title:string;onPress:()=>void;secondary?:boolean;disabled?:boolean;danger?:boolean}) {
  return <Pressable accessibilityRole="button" accessibilityState={{disabled}} onPress={onPress} disabled={disabled} style={({pressed})=>[styles.button,secondary&&styles.secondaryButton,danger&&styles.dangerButton,(disabled||pressed)&&{opacity:0.5}]}><Text style={[styles.buttonText,secondary&&{color:colors.blue},danger&&{color:colors.amber}]}>{title}</Text></Pressable>;
}
function Input(props: React.ComponentProps<typeof TextInput>) { return <TextInput placeholderTextColor="#8492A2" {...props} style={[styles.input,props.multiline&&{minHeight:105,textAlignVertical:'top'},props.style]} />; }
function StateBadge({value}:{value:string}) { const active=['online','succeeded','running','verified'].includes(value); return <Text style={[styles.badge,{color:active?colors.green:colors.muted,backgroundColor:active?'#EAF4EF':colors.canvas}]}>{statuses[value]??value}</Text>; }
function Empty({title,detail}:{title:string;detail:string}) { return <View style={styles.empty}><Text style={styles.emptyTitle}>{title}</Text><Text style={styles.emptyDetail}>{detail}</Text></View>; }
function Choice({label,value,options,onChange}: {label:string;value:string;options:ChoiceOption[];onChange:(value:string)=>void}) {
  const [open,setOpen]=useState(false);
  return <><Pressable accessibilityRole="button" style={styles.choice} onPress={()=>setOpen(true)}><Text style={styles.smallLabel}>{label}</Text><Text style={styles.choiceValue} numberOfLines={1}>{options.find(o=>o.value===value)?.label??'请选择'} ﹀</Text></Pressable><Modal visible={open} transparent animationType="fade" onRequestClose={()=>setOpen(false)}><View style={styles.scrim}><View style={styles.choiceSheet}><Text style={styles.sectionTitle}>{label}</Text><ScrollView>{options.map(o=><Pressable key={o.value} style={styles.option} onPress={()=>{onChange(o.value);setOpen(false);}}><Text style={[styles.body,o.value===value&&{color:colors.blue,fontWeight:'600'}]}>{o.label}</Text></Pressable>)}</ScrollView><Button title="取消" secondary onPress={()=>setOpen(false)}/></View></View></Modal></>;
}
function QuestionCard({question,onAnswer,pending=false,note}:{question:Question;onAnswer:(answer:string)=>Promise<void>;pending?:boolean;note?:string}) {
  const [text,setText]=useState('');
  return <View style={styles.question}><Text style={styles.smallLabel}>需要你的判断</Text><Text selectable style={styles.body}>{question.text}</Text>{note?<Text style={styles.caption}>{note}</Text>:null}<View style={styles.wrap}>{question.options.map(o=><Button key={o} title={o} secondary disabled={pending} onPress={()=>void onAnswer(o)}/>)}</View><Input value={text} onChangeText={setText} placeholder="补充回答"/><Button title="回答" disabled={pending||!text.trim()} onPress={()=>void onAnswer(text)}/></View>;
}
function PendingCard({record,onDelete,onRetry,onEdit}:{record:PendingMessage;onDelete:()=>void;onRetry:()=>void;onEdit:()=>void}) {
  const removal=localRemoval(record.phase);
  const role=record.kind==='task'?'直接派活':record.kind==='input'?'补充':'你';
  return <View style={[styles.message,styles.userMessage]}><View style={styles.row}><Text style={styles.messageRole}>{role}</Text><Text style={styles.caption}>{submissionLabel(record.phase)}</Text></View><Text selectable style={styles.messageBody}>{record.text}</Text><View style={styles.wrap}>{removal.allowed?<Button title={removal.title} secondary onPress={onDelete}/>:null}{record.phase==='result_unknown'?<Button title="重新检查" secondary onPress={onRetry}/>:null}{record.phase==='unsent'||record.phase==='rejected'||record.phase==='conflict'||record.phase==='result_unknown'?<Button title={record.phase==='result_unknown'||record.phase==='conflict'?'编辑为新消息':'改后再发'} secondary onPress={onEdit}/>:null}</View></View>;
}
function TaskProgressCard({title,phase,note,completed,total,at,now,connected,online,onCheck}:{title:string;phase:string|null;note:string|null;completed:number|null;total:number|null;at:number|null;now:number;connected:boolean;online:boolean|null;onCheck:()=>void}) {
  const cue=progressCue(at,now);
  const stage=note??phaseLabel(phase);
  const count=countLabel(completed,total);
  if(!stage&&!count&&!cue.check)return null;
  return <View style={cue.stale?styles.notice:styles.inboxHint}><Text style={styles.sectionTitle}>{title}</Text>{stage?<Text style={styles.body}>{stage}</Text>:null}{count?<Text style={styles.caption}>{count}</Text>:null}{cue.stale?<Text style={styles.body}>{staleProgressText(phase,connected,online)}</Text>:null}{cue.check?<Button title="检查进展" secondary onPress={onCheck}/>:null}</View>;
}

export default function App() { return <SafeAreaProvider><StatusBar style="dark"/><Workspace/></SafeAreaProvider>; }
function Workspace() {
  const [booting,setBooting]=useState(true); const [server,setServer]=useState('https://super-agent.aimo.plus'); const [session,setSession]=useState<Session|null>(null); const [config,setConfig]=useState<AuthConfig|null>(null);
  const [email,setEmail]=useState(''); const [name,setName]=useState(''); const [error,setError]=useState(''); const [tab,setTab]=useState<Tab>('助理');
  const [devices,setDevices]=useState<Device[]>([]); const [tasks,setTasks]=useState<AgentTask[]>([]); const [messages,setMessages]=useState<Message[]>([]); const [questions,setQuestions]=useState<Question[]>([]); const [memories,setMemories]=useState<Memory[]>([]); const [settings,setSettings]=useState<ExecutionSettings|null>(null);
  const [engine,setEngine]=useState<Engine>('codex'); const [device,setDevice]=useState(''); const [modelId,setModelId]=useState(''); const [project,setProject]=useState(''); const [sites,setSites]=useState(''); const [globalPreference,setGlobalPreference]=useState(false); const [scopeStatuses,setScopeStatuses]=useState('verified'); const [maxVersion,setMaxVersion]=useState(''); const [draft,setDraft]=useState(''); const [selectedTask,setSelectedTask]=useState<string|null>(null); const [account,setAccount]=useState(false); const [lastSync,setLastSync]=useState('');
  const [memorySettings,setMemorySettings]=useState<MemorySettings|null>(null);
  const [outbox,setOutbox]=useState<OutboxFile>(emptyOutbox());
  const [caps,setCaps]=useState<ClientCapabilities|null>(null);
  const [connection,setConnection]=useState<'connecting'|'open'|'reconnecting'|'auth'>('connecting');
  const [reconnectBanner,setReconnectBanner]=useState(false);
  const [syncing,setSyncing]=useState(false);
  const [syncNote,setSyncNote]=useState('');
  const [pendingKeys,setPendingKeys]=useState<string[]>([]);
  const [fastChoice,setFastChoice]=useState<Extract<ChatDecision,{type:'choose'}>|null>(null);
  const [statusTasks,setStatusTasks]=useState<{id:string;title:string;status:string}[]|null>(null);
  const [runNotes,setRunNotes]=useState<Record<string,{state:string;text:string}>>({});
  const [progressAt,setProgressAt]=useState<Record<string,number>>({});
  const [progressMeta,setProgressMeta]=useState<Record<string,{phase:string|null;completed:number|null;total:number|null;version:number|null}>>({});
  const [now,setNow]=useState(()=>Date.now());
  const [streamEpoch,setStreamEpoch]=useState(0);
  const appActive=useRef(true); const executionInitialized=useRef(false);
  const projectionRef=useRef<ProjectionCursor>({persisted:'0',dirty:[]});
  const outboxRef=useRef<OutboxFile>(emptyOutbox());
  const outboxBlocked=useRef(false);
  const processingVersions=useRef(new Map<string,number>());
  const flights=useRef(new Map<string,Promise<unknown>>());
  const writeChain=useRef(Promise.resolve());
  const composerLock=useRef<Promise<void>|null>(null);
  const authStopped=useRef(false);
  const sessionRef=useRef<Session|null>(null);
  sessionRef.current=session;
  const isPending=useCallback((key:string)=>pendingKeys.includes(key),[pendingKeys]);
  const scopeOf=useCallback(()=>({server:api.server,userId:api.session?.user.id??sessionRef.current?.user.id??''}),[]);
  const mutateOutbox=useCallback((mutate:(current:OutboxFile)=>OutboxFile)=>{
    const run=writeChain.current.then(async()=>{
      if(outboxBlocked.current)throw new Error('本地待发送记录无法读取');
      const next=mutate(outboxRef.current);
      outboxRef.current=next;
      setOutbox(next);
      const current=scopeOf();
      if(!current.server||!current.userId)return;
      await writeOutboxFile(current.server,current.userId,next);
    });
    writeChain.current=run.then(()=>undefined,()=>undefined);
    return run;
  },[scopeOf]);
  const refreshSettings=useCallback(async()=>{
    const [nextSettings,nextMemory]=await Promise.all([api.request<ExecutionSettings>('/settings/execution'),api.request<MemorySettings>('/settings/memory')]);
    setSettings(nextSettings);setMemorySettings(nextMemory);
    if(nextMemory.configured){const memoriesResult=await api.request<List<Memory>>('/memories');setMemories(memoriesResult.items);}else setMemories([]);
    if(!executionInitialized.current){setDevice(nextSettings.default_device_id??'');setEngine(nextSettings.default_engine);executionInitialized.current=true;}
  },[]);
  const load=useCallback(async()=>{
    const [deviceList,taskList,messageList,questionList]=await Promise.all([api.request<List<Device>>('/devices'),api.request<List<AgentTask>>('/tasks'),api.request<List<Message>>('/messages'),api.request<List<Question>>('/questions?status=open')]);
    setDevices(current=>mergeCollection(current,deviceList.items,'upsert'));
    setTasks(current=>mergeCollection(current,taskList.items,'upsert'));
    setMessages(current=>mergeCollection(current,messageList.items,'upsert'));
    setQuestions(current=>mergeCollection(current,questionList.items,'upsert'));
    setLastSync(new Date().toLocaleTimeString('zh-CN'));
    await refreshSettings();
    await mutateOutbox(current=>pruneMatched(current,messageList.items));
  },[mutateOutbox,refreshSettings]);
  const restoreWorkspace=useCallback(async()=>{
    setSyncing(true);
    try{
      try{const body=await api.request<ClientCapabilities>('/capabilities');setCaps(capabilitiesFrom(200,body));}
      catch(error){setCaps(capabilitiesFrom(error instanceof APIError?error.status:0,null));}
      try{
        const snap=await api.request<{as_of?:string;cursor?:string;tasks?:AgentTask[];messages?:Message[];questions?:Question[];devices?:Device[];actions?:unknown;processing?:{source_message_id?:string;status?:string|null;reason_code?:string|null;historical?:'handled'|'unknown'|null;phase?:string|null;version?:number|null}[]}>('/workspace/snapshot');
        const nextTasks=Array.isArray(snap.tasks)?snap.tasks:[];
        const nextMessages=Array.isArray(snap.messages)?snap.messages:[];
        const nextQuestions=Array.isArray(snap.questions)?snap.questions:[];
        const nextDevices=Array.isArray(snap.devices)?snap.devices:[];
        setDevices(current=>mergeCollection(current,nextDevices,'replace'));
        setTasks(current=>mergeCollection(current,nextTasks,'replace'));
        setQuestions(current=>mergeCollection(current,nextQuestions,'replace'));
        setMessages(current=>{
          const merged=mergeCollection(current,nextMessages,'replace');
          if(!Array.isArray(snap.processing))return merged;
          return merged.map(message=>{
            const processing=snap.processing?.find(item=>item.source_message_id===message.id);
            if(!processing)return message;
            const previous=processingVersions.current.get(message.id);
            if(previous!=null&&!acceptEntityVersion(processing.version,previous))return message;
            if(typeof processing.version==='number')processingVersions.current.set(message.id,processing.version);
            return {...message,processing_status:processing.status??message.processing_status??null,processing_phase:processing.phase??message.processing_phase??null,reason_code:processing.reason_code??message.reason_code??null,historical:processing.historical??message.historical??null};
          });
        });
        const nextCursor=cursorAfterSnapshot(projectionRef.current,typeof snap.cursor==='string'?snap.cursor:projectionRef.current.persisted);
        projectionRef.current=nextCursor;
        const current=scopeOf();
        if(current.server&&current.userId)await SecureStore.setItemAsync(eventCursorKey(current.server,current.userId),nextCursor.persisted);
        await mutateOutbox(currentFile=>mergeActionReceipts(pruneMatched(currentFile,nextMessages),snap.actions));
        await refreshSettings().catch(()=>undefined);
        setLastSync(new Date().toLocaleTimeString('zh-CN'));
        setSyncNote('');
      }catch(error){
        if(error instanceof APIError&&shouldUseLegacyLoad(error.status)){await load();setSyncNote('');}
        else throw error;
      }
    }catch{setSyncNote('同步失败，已保留当前内容');}
    finally{setSyncing(false);}
  },[load,mutateOutbox,refreshSettings,scopeOf]);
  const restoreRef=useRef(restoreWorkspace); restoreRef.current=restoreWorkspace;
  const transportFor=useCallback((record:PendingMessage)=>({
    async lookup(id:string){try{return{status:200,body:await api.request(`/messages/by-client-id/${encodeURIComponent(id)}`)};}catch(error){if(error instanceof APIError)return{status:error.status};throw error;}},
    async post(item:PendingMessage){try{
      if(item.kind==='task')return{status:200,body:await api.request('/tasks',{method:'POST',idempotencyKey:item.idempotency_key,body:taskRequestBody(item)})};
      if(item.kind==='input'){if(!item.task_id)throw new Error('缺少任务');return{status:200,body:await api.request(`/tasks/${encodeURIComponent(item.task_id)}/inputs`,{method:'POST',idempotencyKey:item.idempotency_key,body:{text:item.text}})};}
      return{status:200,body:await api.request('/messages',{method:'POST',idempotencyKey:item.idempotency_key,body:messageRequestBody(item)})};
    }catch(error){if(error instanceof APIError)return{status:error.status};throw error;}},
  }),[]);
  const deliver=useCallback(async(record:PendingMessage,mode:'send'|'recover')=>shareInflight(flights.current,pendingKey('message',record.client_message_id),async()=>{
    const result=await dispatchSubmission(record,transportFor(record),mode);
    await mutateOutbox(current=>upsertMessage(current,result.record));
    if(result.decision.type==='merge'){
      const body=readRecord(result.body);
      if(body&&typeof body.id==='string'&&typeof body.content==='string')setMessages(current=>mergeByVersion(current,body as unknown as Message));
      if(record.kind==='task'&&body&&typeof body.id==='string'&&typeof body.version==='number'){setTasks(current=>mergeByVersion(current,body as unknown as AgentTask));setTab('任务');}
    }else if(result.decision.type==='unknown')setError('发送结果待确认');
    else if(result.decision.type==='conflict')setError('请求冲突');
    else setError(result.decision.label);
    if(result.decision.type==='merge')void restoreRef.current();
  }),[mutateOutbox,transportFor]);
  const postControl=useCallback(async(draft:ActionDraft)=>shareInflight(flights.current,pendingKey('control',draft.action==='switch'?`${draft.task_id}:switch:${draft.target?.device_id??''}:${draft.target?.engine??''}`:`${draft.task_id}:${draft.action}`),async()=>{
    try{await mutateOutbox(current=>upsertAction(current,{...draft,phase:'inflight'}));}
    catch(error){setError(errorText(error));return;}
    try{
      const response=await api.request<{action_id?:string;status?:string;receipt?:{status?:string}|null}>(`/tasks/${encodeURIComponent(draft.task_id)}/actions`,{method:'POST',version:draft.task_version,idempotencyKey:draft.idempotency_key,body:actionRequestBody(draft)});
      await mutateOutbox(current=>upsertAction(current,{...draft,phase:'settled',action_id:typeof response.action_id==='string'?response.action_id:draft.action_id,receipt_status:asActionStatus(response.receipt?.status)}));
      void restoreRef.current();
    }catch(error){
      const kind=failureKind(error instanceof APIError?{status:error.status,name:error.name}:error instanceof Error?{name:error.name}:null);
      if(kind==='timeout'){await mutateOutbox(current=>upsertAction(current,{...draft,phase:'result_unknown'}));setError('结果待核对');return;}
      if(kind==='conflict'){await mutateOutbox(current=>upsertAction(current,{...draft,phase:'conflict'}));setError('请求冲突');return;}
      await mutateOutbox(current=>upsertAction(current,{...draft,phase:'conflict'}));
      setError(errorText(error));
    }
  }),[mutateOutbox]);
  const runControl=useCallback(async(task:AgentTask,action:TaskControlAction,version:number,target:ActionDraft['target'])=>{
    const existing=outboxRef.current.actions.find(item=>item.task_id===task.id&&reusableAction(item,{action,task_version:version,target}));
    const draft:ActionDraft=existing??{idempotency_key:Crypto.randomUUID(),task_id:task.id,action,task_version:version,target,action_id:null,receipt_status:null,phase:'unsent'};
    await postControl({...draft,action,task_version:version,target});
  },[postControl]);
  const postAnswer=useCallback(async(draft:AnswerDraft)=>shareInflight(flights.current,pendingKey('answer',draft.question_id),async()=>{
    try{await mutateOutbox(current=>upsertAnswer(current,{...draft,phase:'inflight'}));}
    catch(error){setError(errorText(error));return;}
    try{
      await api.request(`/questions/${encodeURIComponent(draft.question_id)}/answers`,{method:'POST',version:draft.version,idempotencyKey:draft.idempotency_key,body:{answer:draft.answer,version:draft.version}});
      await mutateOutbox(current=>upsertAnswer(current,{...draft,phase:'settled'}));
      void restoreRef.current();
    }catch(error){
      const kind=failureKind(error instanceof APIError?{status:error.status,name:error.name}:error instanceof Error?{name:error.name}:null);
      if(kind==='timeout'){await mutateOutbox(current=>upsertAnswer(current,{...draft,phase:'result_unknown'}));setError('发送结果待确认');return;}
      await mutateOutbox(current=>upsertAnswer(current,{...draft,phase:'conflict'}));
      setError(kind==='conflict'?'请求冲突':errorText(error));
    }
  }),[mutateOutbox]);
  const runAnswer=useCallback(async(question:Question,answer:string)=>{
    const existing=outboxRef.current.answers.find(item=>item.question_id===question.id&&reusableAnswer(item,question.version));
    const draft:AnswerDraft=existing??{question_id:question.id,idempotency_key:Crypto.randomUUID(),answer,version:question.version,phase:'inflight'};
    await postAnswer({...draft,answer,version:question.version});
  },[postAnswer]);
  const runInput=useCallback((task:AgentTask,text:string)=>shareInflight(flights.current,pendingKey('input',task.id),async()=>{
    const record=createPendingMessage({client_message_id:Crypto.randomUUID(),idempotency_key:Crypto.randomUUID(),text,task_id:task.id,execution_preference:null,memory_scope:null,kind:'input',created_at:new Date().toISOString()});
    setOutbox(current=>{const next=upsertMessage(current,{...record,phase:'inflight'});outboxRef.current=next;return next;});
    try{await mutateOutbox(current=>upsertMessage(current,{...record,phase:'inflight'}));}
    catch{setOutbox(current=>{const next=removeMessage(current,record.client_message_id);outboxRef.current=next;return next;});setError('本地保存失败，尚未发送');throw new Error('本地保存失败，尚未发送');}
    void deliver({...record,phase:'inflight'},'send');
  }),[deliver,mutateOutbox]);
  const projectDirty=useCallback(async()=>{
    let guard=0;
    while(projectionRef.current.dirty.length&&guard++<3){
      const batch=projectionRef.current.dirty.slice();
      const failedTasks=new Set<string>();
      for(const id of [...new Set(batch.flatMap(event=>projectionNeeds(event).task&&event.taskId?[event.taskId]:[]))]){
        try{const task=await api.request<AgentTask>(`/tasks/${encodeURIComponent(id)}`);setTasks(current=>mergeByVersion(current,task));}
        catch{failedTasks.add(id);}
      }
      let devicesOk=true,questionsOk=true,messagesOk=true;
      if(batch.some(event=>projectionNeeds(event).devices)){try{const list=await api.request<List<Device>>('/devices');setDevices(current=>mergeCollection(current,list.items,'upsert'));}catch{devicesOk=false;}}
      if(batch.some(event=>projectionNeeds(event).questions)){try{const list=await api.request<List<Question>>('/questions?status=open');setQuestions(current=>mergeCollection(current,list.items,'upsert'));}catch{questionsOk=false;}}
      if(batch.some(event=>projectionNeeds(event).messages)){try{const list=await api.request<List<Message>>('/messages');setMessages(current=>mergeCollection(current,list.items,'upsert'));await mutateOutbox(current=>pruneMatched(current,list.items));}catch{messagesOk=false;}}
      const results=batch.map(event=>{const need=projectionNeeds(event);const ok=(!need.task||!event.taskId||!failedTasks.has(event.taskId))&&(!need.devices||devicesOk)&&(!need.questions||questionsOk)&&(!need.messages||messagesOk);return{streamSeq:event.streamSeq,ok};});
      const next=commitProjection(projectionRef.current,results);
      const advanced=next.persisted!==projectionRef.current.persisted;
      projectionRef.current=next;
      if(advanced){const current=scopeOf();if(current.server&&current.userId)await SecureStore.setItemAsync(eventCursorKey(current.server,current.userId),next.persisted).catch(()=>undefined);}
      if(results.some(item=>!item.ok))break;
    }
  },[mutateOutbox,scopeOf]);
  const projectRef=useRef(projectDirty); projectRef.current=projectDirty;
  const perform=useCallback((action:()=>Promise<void>,key?:string)=>{
    const id=key??`once:${Crypto.randomUUID()}`;
    return shareInflight(flights.current,id,async()=>{
      setPendingKeys(keys=>keys.includes(id)?keys:[...keys,id]);
      try{await action();return true;}
      catch(error){setError(errorText(error));Alert.alert('操作未完成',errorText(error));if(!api.session)setSession(null);return false;}
      finally{setPendingKeys(keys=>keys.filter(item=>item!==id));}
    });
  },[]);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),5000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{setProgressAt(prev=>{let changed=false;const next={...prev};for(const task of tasks){if(!['running','pausing','switching','waiting_device'].includes(task.status)||next[task.id]!=null)continue;next[task.id]=Date.now();changed=true;}return changed?next:prev;});},[tasks]);
  useEffect(()=>{let active=true;void(async()=>{try{const saved=await SecureStore.getItemAsync('superagent.server');if(saved){await api.configure(saved);if(active){setServer(saved);setSession(api.session);}}}catch(error){if(active)setError(errorText(error));}finally{if(active)setBooting(false);}})();return()=>{active=false;};},[]);
  useEffect(()=>{if(!session)return;let cancelled=false;void(async()=>{let file:OutboxFile;try{file=await readOutboxFile(api.server,session.user.id);}catch{if(!cancelled){outboxBlocked.current=true;setSyncNote('本地待发送记录无法读取');}return;}if(cancelled)return;outboxBlocked.current=false;outboxRef.current=file;setOutbox(file);try{for(const item of file.messages){if(cancelled)return;if(item.phase==='accepted'||item.phase==='rejected'||item.phase==='conflict')continue;await deliver(item,'recover');}for(const action of file.actions){if(cancelled)return;if(action.phase!=='inflight'&&action.phase!=='result_unknown'&&action.phase!=='unsent')continue;await postControl(action);}for(const answer of file.answers){if(cancelled)return;if(answer.phase!=='inflight'&&answer.phase!=='result_unknown')continue;await postAnswer(answer);}}catch{if(!cancelled)setSyncNote('同步失败，已保留当前内容');}})();return()=>{cancelled=true;};},[session,deliver,postControl,postAnswer]);
  useEffect(()=>{
    if(!session)return;
    let stopped=false;
    const userId=session.user.id;
    const life=new AbortController();
    const request={current:new AbortController()};
    let delay=0; const seen=new Set<string>(); let remainder=''; let failureSince:number|null=null; let bannerTimer:ReturnType<typeof setTimeout>|undefined;
    const clearBanner=()=>{if(bannerTimer)clearTimeout(bannerTimer);bannerTimer=undefined;failureSince=null;setReconnectBanner(false);};
    const noteFailure=()=>{if(failureSince==null)failureSince=Date.now();const wait=Math.max(0,5000-(Date.now()-failureSince));if(bannerTimer)clearTimeout(bannerTimer);bannerTimer=setTimeout(()=>{if(!stopped)setReconnectBanner(reconnectVisible(failureSince,Date.now()));},wait);setConnection('reconnecting');};
    const remember=(events:StreamEvent[])=>{
      for(const event of events){
        const label=runStageLabel(event.type,event.runState??null);
        const taskId=event.taskId;
        if(label&&taskId)setRunNotes(prev=>({...prev,[taskId]:{state:event.runState??'dispatched',text:label}}));
        if(taskId&&event.type!=='cursor'&&event.type!=='device.changed'&&!event.type.includes('heartbeat'))setProgressAt(prev=>({...prev,[taskId]:Date.now()}));
        if(event.type==='task.progress.changed'&&event.taskId){
          const taskId=event.taskId;
          setProgressMeta(prev=>{
            const current=prev[taskId];
            if(current?.version!=null&&!acceptEntityVersion(event.version,current.version))return prev;
            return {...prev,[taskId]:{phase:event.phase??current?.phase??null,completed:typeof event.completedCount==='number'?event.completedCount:current?.completed??null,total:typeof event.totalCount==='number'?event.totalCount:current?.total??null,version:event.version??current?.version??null}};
          });
        }
        if(event.type==='message.processing.changed'&&event.sourceMessageId){
          const sourceId=event.sourceMessageId;
          const previous=processingVersions.current.get(sourceId);
          if(!(previous!=null&&!acceptEntityVersion(event.version,previous))){
            if(event.version!=null)processingVersions.current.set(sourceId,event.version);
            setMessages(list=>list.map(message=>message.id===sourceId||message.client_message_id===sourceId?{...message,processing_status:event.payloadStatus??message.processing_status,processing_phase:event.phase??message.processing_phase,reason_code:event.reasonCode??message.reason_code}:message));
          }
        }
        if(event.type==='action.changed'&&event.actionId&&event.taskId&&event.actionName&&event.payloadStatus){
          const actionId=event.actionId;
          const taskId=event.taskId;
          const actionName=event.actionName;
          const payloadStatus=event.payloadStatus;
          void mutateOutbox(file=>mergeActionReceipt(file,{action_id:actionId,task_id:taskId,action:actionName,status:payloadStatus,version:event.version??null})).catch(()=>undefined);
        }
      }
      projectionRef.current=enqueueProjection(projectionRef.current,events.map(event=>({streamSeq:event.streamSeq,eventId:event.eventId,type:event.type,taskId:event.taskId})));
      void projectRef.current();
    };
    const subscription=AppState.addEventListener('change',state=>{
      appActive.current=state==='active';
      if(state!=='active'||authStopped.current)return;
      delay=0; setSyncNote(''); void restoreRef.current();
      request.current.abort(); request.current=new AbortController();
    });
    const slow=setInterval(()=>{if(!stopped&&appActive.current&&!authStopped.current)void restoreRef.current();},45_000);
    void(async()=>{
      try{const saved=await SecureStore.getItemAsync(eventCursorKey(api.server,userId));if(!stopped&&saved&&/^\d{1,20}$/.test(saved))projectionRef.current={...projectionRef.current,persisted:saved};}catch{/* keep the last cursor */}
      if(!stopped)void restoreRef.current();
      while(!stopped){
        if(life.signal.aborted||authStopped.current)return;
        if(!appActive.current){await sleep(1000,life.signal);continue;}
        if(delay>0)await sleep(delay,request.current.signal);
        if(stopped||life.signal.aborted||authStopped.current)return;
        const token=api.session?.access_token;
        if(!token||!api.server){delay=1000;continue;}
        const signal=request.current.signal;
        try{
          await readEventStream({url:`${api.server}/v1/events/stream?after=${encodeURIComponent(projectionRef.current.persisted)}`,token,signal,onOpen:()=>{if(!stopped){clearBanner();setConnection('open');}},onText:text=>{
            const result=consumeEventStream(text,projectionRef.current.persisted,seen,remainder);
            remainder=result.remainder; for(const item of result.seen)seen.add(item); if(result.applied.length)remember(result.applied);
          }});
          if(remainder){const result=consumeEventStream('\n',projectionRef.current.persisted,seen,remainder);remainder=result.remainder;for(const item of result.seen)seen.add(item);if(result.applied.length)remember(result.applied);}
          delay=0; clearBanner(); if(!stopped)setConnection('open');
        }catch(error){
          if(stopped||life.signal.aborted)return;
          if(signal.aborted){delay=0;continue;}
          if(error instanceof EventStreamError&&error.status===401){authStopped.current=true;clearBanner();setConnection('auth');setError('登录已失效，请重新登录');return;}
          if(error instanceof EventStreamError&&shouldResetCursor(error.status)&&projectionRef.current.persisted!=='0'){
            projectionRef.current={persisted:'0',dirty:[]}; seen.clear(); remainder=''; delay=0;
            const current=scopeOf(); if(current.server&&current.userId)void SecureStore.setItemAsync(eventCursorKey(current.server,current.userId),'0').catch(()=>undefined);
            continue;
          }
          noteFailure(); delay=delay===0?1000:Math.min(delay*2,30_000);
        }
      }
    })();
    return()=>{stopped=true;life.abort();request.current.abort();clearInterval(slow);if(bannerTimer)clearTimeout(bannerTimer);subscription.remove();};
  },[session,streamEpoch,scopeOf,mutateOutbox]);
  useEffect(()=>{const subscription=Notifications.addNotificationResponseReceivedListener(response=>{const id=response.notification.request.content.data?.task_id;if(typeof id==='string'){setSelectedTask(id);setTab('任务');}});return()=>subscription.remove();},[]);
  async function checkServer(){await perform(async()=>{await api.configure(server);await SecureStore.setItemAsync('superagent.server',api.server);setConfig(await api.authConfig());},'auth');}
  async function signIn(){await perform(async()=>{await api.configure(server);const auth=config??await api.authConfig();const next=auth.mode==='development'?await api.loginDevelopment(email,name):await authenticateOIDC(auth);authStopped.current=false;setSession(next);},'auth');}
  async function signOut(){await perform(async()=>{try{await api.signOut();}finally{setSession(null);setTasks([]);setDevices([]);setMessages([]);setMemories([]);setQuestions([]);setSettings(null);setMemorySettings(null);setSelectedTask(null);setAccount(false);setDevice('');setModelId('');setEngine('codex');setProject('');setSites('');setGlobalPreference(false);setScopeStatuses('verified');setMaxVersion('');executionInitialized.current=false;outboxRef.current=emptyOutbox();setOutbox(emptyOutbox());projectionRef.current={persisted:'0',dirty:[]};setCaps(null);setRunNotes({});setFastChoice(null);setStatusTasks(null);}},'auth');}
  async function beginSend(direct:boolean,text:string){
    let memory_scope; try{memory_scope=memoryScopePayload({project,sites,globalPreference,statuses:scopeStatuses,maxVersion});}catch(error){setError(errorText(error));return;}
    if(direct){if(!device){setError('先选择执行电脑');return;}if(devices.find(item=>item.id===device)?.revoked){setError('此电脑已撤销，请手动选择其他电脑');return;}}
    const record=createPendingMessage({client_message_id:Crypto.randomUUID(),idempotency_key:Crypto.randomUUID(),text,task_id:null,execution_preference:device?{engine,device_id:device,selection_mode:'pinned',model_id:modelId||null}:null,memory_scope,kind:direct?'task':'message',created_at:new Date().toISOString()});
    setOutbox(current=>{const next=upsertMessage(current,record);outboxRef.current=next;return next;});
    setDraft('');
    try{await mutateOutbox(current=>upsertMessage(current,{...record,phase:'inflight'}));}
    catch{setDraft(text);setOutbox(current=>{const next=removeMessage(current,record.client_message_id);outboxRef.current=next;return next;});setError('本地保存失败，尚未发送');return;}
    void deliver({...record,phase:'inflight'},'send');
  }
  async function submit(direct:boolean){
    const text=draft.trim(); if(!text)return;
    if(!direct){
      const decision=decideChat(text,tasks.map(task=>({id:task.id,title:task.title,status:task.status})));
      if(decision.type==='choose'){setFastChoice(decision);setStatusTasks(null);return;}
    }
    if(composerLock.current)return composerLock.current;
    const job=beginSend(direct,text); composerLock.current=job; try{await job;}finally{composerLock.current=null;}
  }
  async function chooseFast(taskRef:{id:string;title:string;status:string}){
    const choice=fastChoice; setFastChoice(null); if(!choice)return;
    await beginSend(false,explicitCommand(choice.action,taskRef.id));
  }
  function editPending(record:PendingMessage){setDraft(record.text);if(localRemoval(record.phase).allowed)void mutateOutbox(current=>removeMessage(current,record.client_message_id));}
  const authBusy=isPending('auth');
  const online=devicePresence(devices);
  const serviceConnected=connection==='open'&&!reconnectBanner;
  function refreshWorkspace(){return perform(()=>restoreWorkspace(),pendingKey('refresh'));}
  function reconnect(){authStopped.current=false;setConnection('connecting');setError('');setStreamEpoch(value=>value+1);}
  async function raiseBudget(task:AgentTask,amount:string){
    const id=`budget:${task.id}`;
    setPendingKeys(keys=>keys.includes(id)?keys:[...keys,id]);
    try{await shareInflight(flights.current,id,async()=>{
      const updated=await api.request<AgentTask>(`/tasks/${encodeURIComponent(task.id)}/budget`,{method:'PUT',version:task.version,body:taskBudgetMerge(task.reason_code,Number(amount))});
      setTasks(current=>mergeByVersion(current,updated));
      await runControl(updated,'retry',updated.version,null);
    });}
    finally{setPendingKeys(keys=>keys.filter(item=>item!==id));}
  }
  const connectionText=syncing?'正在同步':reconnectBanner?'正在重连':connection==='open'?'已连接服务':connection==='auth'?'登录已失效':'正在连接';
  const deviceText=online===true?`${devices.filter(item=>!item.revoked&&item.status!=='offline').length} 台执行电脑在线`:online===false?'执行电脑离线':'执行电脑状态未知';
  const pendingRows=visiblePending(outbox.messages,messages);
  const deviceOptions=[{value:'',label:'选择电脑'},...devices.filter(d=>!d.revoked).map(d=>({value:d.id,label:`${d.name}（${statuses[d.status]??d.status}）`}))];
  const modelOptions=[{value:'',label:'本机默认'},...(devices.find(d=>d.id===device&&!d.revoked)?.capabilities.engines.find(e=>e.engine===engine)?.models??[]).map(m=>({value:m,label:m}))];
  const selection=<View style={{gap:8}}><View style={styles.selection}><Choice label="引擎" value={engine} options={[{value:'codex',label:'Codex'},{value:'grok',label:'Grok'}]} onChange={v=>{setEngine(v as Engine);setModelId('');}}/><Choice label="执行电脑" value={device} options={deviceOptions} onChange={v=>{setDevice(v);setModelId('');}}/><Choice label="模型" value={modelId} options={modelOptions} onChange={setModelId}/></View><Input value={project} onChangeText={setProject} placeholder="记忆项目（可选）" autoCapitalize="none"/><Input value={sites} onChangeText={setSites} placeholder="可读取的网站，逗号或空格分隔；留空提交 []" autoCapitalize="none"/><Input value={scopeStatuses} onChangeText={setScopeStatuses} placeholder="记忆状态，默认 verified" autoCapitalize="none"/><Input value={maxVersion} onChangeText={setMaxVersion} placeholder="记忆最大版本（可选）" keyboardType="number-pad"/><View style={styles.row}><Text style={[styles.caption,{flex:1}]}>读取不限定网站的全局偏好</Text><Switch value={globalPreference} onValueChange={setGlobalPreference}/></View><Text style={styles.caption}>直接派活和发给助理都会带上这份记忆范围。网站留空不是全部记忆；关闭全局偏好会发送 false。</Text></View>;
  if(booting)return <SafeAreaView style={styles.root}><ActivityIndicator style={{marginTop:100}} color={colors.blue}/></SafeAreaView>;
  if(!session)return <SafeAreaView style={styles.root}><KeyboardAvoidingView behavior={Platform.OS==='ios'?'padding':undefined} style={{flex:1}}><ScrollView contentContainerStyle={styles.login} keyboardShouldPersistTaps="handled"><Text style={styles.brand}>助理工作台</Text><Text style={styles.loginTitle}>工作继续，{`\n`}你随时掌握。</Text><Text style={styles.subtitle}>连接自己的电脑，交办工作、查看过程，让经验持续积累。</Text><View style={styles.loginForm}><Text style={styles.sectionTitle}>连接你的助理</Text><Input value={server} onChangeText={v=>{setServer(v);setConfig(null);}} placeholder="https://agent.example.com" autoCapitalize="none" keyboardType="url"/><Button title="读取登录配置" secondary onPress={()=>void checkServer()} disabled={!server.trim()||authBusy}/>{config?.mode==='development'?<><Text style={styles.caption}>服务器已显式启用本地开发登录</Text><Input value={email} onChangeText={setEmail} placeholder="邮箱" keyboardType="email-address" autoCapitalize="none"/><Input value={name} onChangeText={setName} placeholder="称呼（可选）"/></>:<Text style={styles.caption}>使用系统浏览器登录。模型账号保留在你自己的执行电脑上。</Text>}<Button title={authBusy?'正在连接…':config?.mode==='development'?'登录开发环境':'打开安全登录'} onPress={()=>void signIn()} disabled={authBusy||!config||(config.mode==='development'&&!email.includes('@'))}/>{error?<Text accessibilityRole="alert" style={styles.error}>{error}</Text>:null}</View></ScrollView></KeyboardAvoidingView></SafeAreaView>;
  return <SafeAreaView style={styles.root} edges={['top','left','right']}><KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==='ios'?'padding':undefined}>
    <View style={styles.header}><View><Text style={styles.headerTitle}>{tab}</Text><Text style={styles.caption}>{session.user.name}</Text><Text style={styles.caption}>{connectionText}</Text><Text style={styles.caption}>{deviceText}</Text></View><Pressable accessibilityRole="button" onPress={()=>setAccount(true)}><Text style={styles.link}>账户</Text></Pressable></View>
    {error?<Pressable accessibilityRole="alert" style={styles.errorBanner} onPress={()=>setError('')}><Text style={styles.error}>{error}</Text><Text style={styles.caption}>轻触收起</Text></Pressable>:null}
    {syncNote?<Pressable accessibilityRole="alert" style={styles.errorBanner} onPress={()=>setSyncNote('')}><Text style={styles.error}>{syncNote}</Text><Text style={styles.caption}>当前内容仍保留。轻触收起</Text></Pressable>:null}
    {connection==='auth'?<View style={styles.errorBanner}><Text style={styles.error}>登录已失效，自动重连已停止</Text><Button title="重新连接" secondary onPress={reconnect}/></View>:null}
    {tab==='助理'?<><ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={isPending(pendingKey('refresh'))} onRefresh={()=>void refreshWorkspace()}/>} keyboardShouldPersistTaps="handled">{fastChoice?<View style={styles.question}><Text style={styles.sectionTitle}>{fastChoice.action==='status'?'要查看哪一项':'有多个任务符合，请先选择'}</Text>{fastChoice.choices.map(item=><Button key={item.id} title={`${item.title} · ${statuses[item.status]??item.status}`} secondary onPress={()=>void chooseFast(item)}/>)}<Button title="取消" secondary onPress={()=>setFastChoice(null)}/></View>:null}{statusTasks?<View style={styles.question}><Text style={styles.sectionTitle}>任务状态</Text>{statusTasks.length?statusTasks.map(item=><Text key={item.id} style={styles.body}>{item.title} · {statuses[item.status]??item.status}</Text>):<Text style={styles.body}>没有进行中的任务</Text>}<Button title="收起" secondary onPress={()=>setStatusTasks(null)}/></View>:null}{questions.length?<Pressable style={styles.inboxHint} onPress={()=>setTab('任务')}><Text style={styles.link}>{questions.length} 件事需要你的判断</Text></Pressable>:null}{tasks.map(task=><TaskProgressCard key={task.id} title={task.title} phase={progressMeta[task.id]?.phase??null} note={runNotes[task.id]?.text??null} completed={progressMeta[task.id]?.completed??null} total={progressMeta[task.id]?.total??null} at={progressAt[task.id]??null} now={now} connected={serviceConnected} online={online} onCheck={()=>void refreshWorkspace()}/>)}{pendingRows.map(record=><PendingCard key={record.client_message_id} record={record} onDelete={()=>{if(localRemoval(record.phase).allowed)void mutateOutbox(current=>removeMessage(current,record.client_message_id));}} onRetry={()=>void deliver(record,'recover')} onEdit={()=>editPending(record)}/>)}{!messages.length&&!pendingRows.length?<Empty title="从一件具体的工作开始" detail="告诉助理目标，它会在授权范围内自主推进。所有电脑离线时，消息会等待上线。"/>:messages.map(m=>{const processing=serverProcessingText({caps,status:m.processing_status,reason:m.reason_code,historical:m.historical,hasProcessingRecord:m.processing_status!=null||m.historical!=null||m.processing_phase!=null});const phase=phaseLabel(m.processing_phase??null);const received=computerReceivedLine(caps,m.processing_phase??null,m.task_id?runNotes[m.task_id]?.state??null:null);return <View key={m.id} style={[styles.message,m.role==='user'&&styles.userMessage]}><View style={styles.row}><Text style={styles.messageRole}>{m.role==='user'?'你':'助理'}</Text><Text style={styles.caption}>{time(m.created_at)}</Text></View><Text selectable style={styles.messageBody}>{m.content}</Text>{processing?<Text style={styles.caption}>{processing}</Text>:null}{phase&&phase!==processing?<Text style={styles.caption}>{phase}</Text>:null}{received?<Text style={styles.caption}>{received}</Text>:null}</View>;})}</ScrollView><View style={styles.composer}>{selection}<Input multiline value={draft} onChangeText={setDraft} placeholder="描述目标、交付物或补充要求…"/><View style={styles.row}><Button title="直接派活" secondary onPress={()=>void submit(true)} disabled={!draft.trim()||!device}/><Button title="发送给助理" onPress={()=>void submit(false)} disabled={!draft.trim()}/></View></View></>:null}
    {tab==='任务'?<ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={isPending(pendingKey('refresh'))} onRefresh={()=>void refreshWorkspace()}/>}>{!tasks.length?<Empty title="还没有任务" detail="从助理页面交办一件具体工作。"/>:<LoadedTaskTree tasks={tasks} onSelect={setSelectedTask}/>}</ScrollView>:null}
    {tab==='电脑'?<DevicesPanel devices={devices} settings={settings} isPending={isPending} perform={perform} reload={()=>restoreWorkspace()}/>:null}
    {tab==='记忆'?<MemoryPanel memories={memories} memorySettings={memorySettings} isPending={isPending} perform={perform} reload={()=>restoreWorkspace()}/>:null}
    {tab==='成本'?<CostPanel perform={perform} isPending={isPending}/>:null}
    {tab==='关注'?<SchedulesPanel devices={devices} perform={perform}/>:null}
    <View style={styles.navigation}>{(['助理','任务','电脑','记忆','关注','成本'] as Tab[]).map(item=><Pressable key={item} accessibilityRole="tab" accessibilityState={{selected:tab===item}} style={[styles.navItem,tab===item&&styles.navSelected]} onPress={()=>setTab(item)}><Text style={[styles.navText,tab===item&&{color:colors.blue,fontWeight:'700'}]}>{item}</Text></Pressable>)}</View>
    <Modal visible={!!selectedTask} animationType="slide" onRequestClose={()=>setSelectedTask(null)}><SafeAreaView style={styles.root}><TaskPanel key={selectedTask??'none'} tasks={tasks} onSelectTask={setSelectedTask} task={tasks.find(t=>t.id===selectedTask)} devices={devices} questions={questions.filter(q=>q.task_id===selectedTask)} perform={perform} reload={()=>restoreWorkspace()} onClose={()=>setSelectedTask(null)} runControl={runControl} runAnswer={runAnswer} runInput={runInput} raiseBudget={raiseBudget} actions={outbox.actions} answers={outbox.answers} pending={pendingRows} isPending={isPending} progress={progressMeta} progressAt={progressAt} runNotes={runNotes} now={now} connected={serviceConnected} online={online} onCheck={()=>void refreshWorkspace()} onRetryPending={record=>void deliver(record,'recover')} onEditPending={editPending} onDeletePending={record=>{if(localRemoval(record.phase).allowed)void mutateOutbox(current=>removeMessage(current,record.client_message_id));}}/></SafeAreaView></Modal>
    <Modal visible={account} animationType="slide" onRequestClose={()=>setAccount(false)}><SafeAreaView style={styles.root}><View style={styles.header}><Text style={styles.headerTitle}>账户与连接</Text><Button title="完成" secondary onPress={()=>setAccount(false)}/></View><View style={styles.content}><Text style={styles.sectionTitle}>{session.user.name}</Text><Text style={styles.body}>{session.user.email}</Text><Text selectable style={styles.caption}>{api.server}</Text><Text style={styles.caption}>最近同步：{lastSync||'等待同步'}</Text><Text style={styles.caption}>设备、任务、记忆和费用仅属于当前账户。</Text><Button title="启用远程通知" secondary onPress={()=>void perform(async()=>{await registerPush(process.env.EXPO_PUBLIC_EAS_PROJECT_ID??'');Alert.alert('通知已登记','推送服务配置正确时，将提醒待处理事项。');})}/><Text style={styles.caption}>远程通知需独立配置 Expo/厂商推送凭据；未配置时可在应用内查看待处理事项。</Text><Button title="退出登录" danger secondary onPress={()=>void signOut()}/></View></SafeAreaView></Modal>
  </KeyboardAvoidingView></SafeAreaView>;
}

type Operation=(action:()=>Promise<void>,key?:string)=>Promise<boolean>;
function DevicesPanel({devices,settings,isPending,perform,reload}:{devices:Device[];settings:ExecutionSettings|null;isPending:(key:string)=>boolean;perform:Operation;reload:()=>Promise<void>}) {
  const [code,setCode]=useState('');const [engine,setEngine]=useState<Engine>('codex');const [device,setDevice]=useState('');const [assistant,setAssistant]=useState('');const [globalRead,setGlobalRead]=useState(false);
  useEffect(()=>{if(settings){setEngine(settings.default_engine);setDevice(settings.default_device_id??'');setAssistant(settings.assistant_device_id??'');setGlobalRead(settings.memory_global_read===true);}},[settings]);
  const revoking=useRef(false);
  function revokeDevice(selected:Device){const key=`devices:revoke:${selected.id}`;if(isPending(key)||revoking.current)return;Alert.alert(`撤销“${selected.name}”？`,'将撤销这台电脑的云端执行权限。在途任务可能需要核对结果，重新连接需要重新配对。',[{text:'返回',style:'cancel'},{text:'撤销电脑',style:'destructive',onPress:()=>{if(revoking.current)return;revoking.current=true;void perform(async()=>{await api.revokeDevice(selected.id);await reload();},key).finally(()=>{revoking.current=false;});}}]);}
  const options=[{value:'',label:'未设置'},...devices.filter(d=>!d.revoked).map(d=>({value:d.id,label:d.name}))];
  return <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"><Text style={styles.sectionTitle}>连接自己的电脑</Text><Text style={styles.caption}>模型账号和浏览器登录态分别留在各台电脑，云端记忆可按需共享。</Text><Input value={code} onChangeText={setCode} placeholder="输入节点显示的配对码" autoCapitalize="characters"/><Button title="认领电脑" disabled={!code.trim()||isPending('devices:claim')} onPress={()=>void perform(async()=>{await api.request('/device-pairings/claim',{method:'POST',body:{code:code.trim()}});setCode('');await reload();},'devices:claim')}/>{!devices.length?<Empty title="还没有连接电脑" detail="先在 Mac 安装节点，再输入配对码认领。"/>:devices.map(d=><View key={d.id} style={styles.deviceRow}><View style={styles.row}><Text style={[styles.sectionTitle,{flex:1}]}>{d.name}</Text><StateBadge value={d.revoked?'revoked':d.status}/></View>{d.capabilities.engines.map(e=><View key={e.engine}><Text style={styles.body}>{e.engine==='codex'?'Codex':'Grok'} · {e.ready?'已配置':'尚未就绪'}</Text><Text style={styles.caption}>{e.ready?e.models.join('、'):e.reason??'请在该电脑检查配置'}</Text></View>)}<Text style={styles.caption}>{d.revoked?'云端执行权限已撤销；重新连接需要重新配对。':`工具：${d.capabilities.tools.join('、')}`}</Text>{!d.revoked?<Button title="撤销电脑" secondary danger disabled={isPending(`devices:revoke:${d.id}`)} onPress={()=>revokeDevice(d)}/>:null}</View>)}<Text style={styles.sectionTitle}>默认执行方式</Text><Choice label="默认引擎" value={engine} options={[{value:'codex',label:'Codex'},{value:'grok',label:'Grok'}]} onChange={v=>setEngine(v as Engine)}/><Choice label="默认执行电脑" value={device} options={options} onChange={setDevice}/><Choice label="主助理电脑" value={assistant} options={options} onChange={setAssistant}/><Text style={styles.caption}>主助理负责理解、拆解和汇报；执行任务可以使用你的其他电脑。</Text><View style={styles.row}><Text style={[styles.body,{flex:1}]}>允许助理读取全局偏好</Text><Switch value={globalRead} onValueChange={setGlobalRead}/></View><Text style={styles.caption}>当前{settings?.memory_global_read===true?'开启':'关闭'}。关闭会明确保存为 false，不会省略。这是账号设置，不代替单个任务的记忆范围。</Text><Button title="保存默认设置" disabled={isPending('devices:settings')} onPress={()=>void perform(async()=>{await api.request('/settings/execution',{method:'PUT',version:settings?.version,body:executionSettingsBody({engine,device,assistant,memoryGlobalRead:globalRead})});await reload();},'devices:settings')}/></ScrollView>;
}
function MemoryPanel({memories,memorySettings,isPending,perform,reload}:{memories:Memory[];memorySettings:MemorySettings|null;isPending:(key:string)=>boolean;perform:Operation;reload:()=>Promise<void>}) {
  const [search,setSearch]=useState('');const [editor,setEditor]=useState<{id?:string;version?:number;status?:string;title:string;content:string;type:string;site:string}|null>(null);
  const filtered=memories.filter(m=>`${m.title} ${m.content}`.toLowerCase().includes(search.toLowerCase()));
  const [recallURL,setRecallURL]=useState(memorySettings?.url??'');const [recallToken,setRecallToken]=useState('');const [recallProject,setRecallProject]=useState(memorySettings?.project??'');
  useEffect(()=>{setRecallURL(memorySettings?.url??'');setRecallProject(memorySettings?.project??'');},[memorySettings?.url,memorySettings?.project]);
  const binding=<View style={styles.deviceRow}><View style={styles.row}><Text style={[styles.sectionTitle,{flex:1}]}>自己的记忆库</Text><Text style={styles.caption}>{memorySettings?.configured?'已连接':'尚未连接'}</Text></View><Input value={recallURL} onChangeText={setRecallURL} placeholder="agent-recall HTTPS 地址" autoCapitalize="none" keyboardType="url"/><Input value={recallToken} onChangeText={setRecallToken} placeholder="你的访问令牌" secureTextEntry autoCapitalize="none" autoCorrect={false}/><Input value={recallProject} onChangeText={setRecallProject} placeholder="Recall 项目（留空则清除）" autoCapitalize="none" autoCorrect={false}/><Text style={styles.caption}>已保存的项目：{memorySettings?.project?.trim()?memorySettings.project:'未限定'}。更改或清除项目会改变任务之后能看到哪些记忆，不会修改记忆正文。</Text><Button title={memorySettings?.configured?'更新连接':'连接记忆库'} disabled={isPending('memory:bind')||!recallURL||!recallToken} onPress={()=>void perform(async()=>{const url=new URL(recallURL);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('记忆服务需要有效的 HTTPS 地址');try{await api.request('/settings/memory',{method:'PUT',version:memorySettings?.version,body:memoryBindingBody({url:recallURL,token:recallToken,project:recallProject})});}catch(error){const message=error instanceof APIError?memorySettingsConflictMessage(error.status,error.code):null;if(message){await reload().catch(()=>{});throw new Error(message);}throw error;}setRecallToken('');await reload();},'memory:bind')}/><Text style={styles.caption}>使用你自己的 agent-recall 账号。访问令牌不会回显，其他用户无法访问你的记忆。</Text></View>;
  async function saveMemory(publish=false){if(!editor)return;const success=await perform(async()=>{const saved=await api.request<Memory>(editor.id?`/memories/${editor.id}`:'/memories',{method:editor.id?'PATCH':'POST',version:editor.version,body:{title:editor.title,content:editor.content,type:editor.type,site:editor.site||null,...(publish?{status:'verified'}:{})}});setEditor({...saved,site:saved.site??''});await reload();},`memory:save:${editor.id??'new'}`);if(success)setEditor(null);}
  function remove(memory:Memory){Alert.alert('删除记忆？','新任务将不再检索这条记录。',[{text:'取消',style:'cancel'},{text:'删除',style:'destructive',onPress:()=>void perform(async()=>{await api.request(`/memories/${memory.id}`,{method:'DELETE',version:memory.version});await reload();},`memory:delete:${memory.id}`)}]);}
  return <><ScrollView contentContainerStyle={styles.content}>{binding}<View style={styles.row}><Text style={[styles.sectionTitle,{flex:1}]}>助理记忆</Text><Button title="添加" disabled={!memorySettings?.configured} onPress={()=>setEditor({title:'',content:'',type:'website',site:''})}/></View><Input value={search} onChangeText={setSearch} placeholder="搜索网站、流程或经验"/>{!filtered.length?<Empty title={memorySettings?.configured?"把经验交给助理":"先连接自己的记忆库"} detail="添加网站用途、工作流程和你的偏好。探索形成的知识会注明验证状态。"/>:filtered.map(m=><MemoryCard key={m.id} memory={m} isPending={isPending} perform={perform} reload={reload} onEdit={()=>setEditor({...m,site:m.site??''})} onRemove={()=>remove(m)}/>)}</ScrollView><Modal visible={!!editor} animationType="slide" onRequestClose={()=>setEditor(null)}><SafeAreaView style={styles.root}><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"><View style={styles.row}><Text style={[styles.headerTitle,{flex:1}]}>{editor?.status==='candidate'?'审核候选记忆':editor?.id?'修正记忆':'教助理一件事'}</Text><Button title="取消" secondary onPress={()=>setEditor(null)}/></View><Input value={editor?.title??''} onChangeText={title=>setEditor(e=>e?{...e,title}:e)} placeholder="标题"/><Choice label="类型" value={editor?.type??'website'} options={memoryTypes} onChange={type=>setEditor(e=>e?{...e,type}:e)}/><Input value={editor?.site??''} onChangeText={site=>setEditor(e=>e?{...e,site}:e)} placeholder="网站地址（可选）" autoCapitalize="none"/><Input multiline value={editor?.content??''} onChangeText={content=>setEditor(e=>e?{...e,content}:e)} placeholder="描述网站用途、操作流程或你的偏好" style={{minHeight:230}}/><Text style={styles.caption}>请勿把密码、Cookie 或 API Key 写进记忆。</Text>{editor?.status==='candidate'?<><Text style={styles.caption}>请核对并修正以上内容。审核发布后，后续任务可以检索和使用这条经验。</Text><Button title="审核并发布" disabled={isPending(`memory:save:${editor.id??'new'}`)||!editor.title.trim()||!editor.content.trim()} onPress={()=>void saveMemory(true)}/></>:null}<Button title={editor?.status==='candidate'?'保存待审核':'保存记忆'} secondary={editor?.status==='candidate'} disabled={isPending(`memory:save:${editor?.id??'new'}`)||!editor?.title.trim()||!editor?.content.trim()} onPress={()=>void saveMemory()}/></ScrollView></SafeAreaView></Modal></>;
}
function MemoryCard({memory,isPending,perform,reload,onEdit,onRemove}:{memory:Memory;isPending:(key:string)=>boolean;perform:Operation;reload:()=>Promise<void>;onEdit:()=>void;onRemove:()=>void}) {
  const [otherId,setOtherId]=useState('');const [validUntil,setValidUntil]=useState('');
  const facts=memoryGovernanceLine(memory);
  async function relate(relation:'conflicts'|'supersedes'|'expires'){await perform(async()=>{try{await api.request(`/memories/${memory.id}/relations`,{method:'POST',version:memory.version,body:memoryRelationBody({relation,otherId,validUntil,governanceVersion:memory.governance?.version??0,operationKey:`relation:${relation}:${Crypto.randomUUID()}`})});}catch(error){if(error instanceof APIError){const message=relationConflictMessage(error.status,error.code);if(message){await reload();throw new Error(message);}}throw error;}await reload();},`memory:relate:${memory.id}:${relation}`);}
  return <View style={styles.memoryRow}><View style={styles.row}><Text style={[styles.sectionTitle,{flex:1}]}>{memory.title}</Text><StateBadge value={memory.status}/></View><Text selectable style={styles.body}>{memory.content}</Text><Text style={styles.caption}>{memoryTypes.find(t=>t.value===memory.type)?.label??memory.type} · v{memory.version}{memory.site?` · ${memory.site}`:''}{memory.governance?.verification?` · ${memory.governance.verification==='verified'?'已核验':memory.governance.verification==='conflict'?'有冲突':memory.governance.verification==='expired'?'已过期':memory.governance.verification==='superseded'?'已被替代':memory.governance.claim==='inference'?'模型推断':'待核验'}`:''}</Text>{facts?<Text selectable style={styles.caption}>{facts}</Text>:null}<View style={styles.row}><Button title={memory.status==='candidate'?'审核发布':'修正'} secondary onPress={onEdit}/><Button title="删除" secondary danger onPress={onRemove}/></View><Input value={otherId} onChangeText={setOtherId} placeholder="另一条记忆的标识（冲突或替代）" autoCapitalize="none"/><Input value={validUntil} onChangeText={setValidUntil} placeholder="过期时间，如 2026-12-01T00:00:00+08:00" autoCapitalize="none"/><Text style={styles.caption}>关系使用记忆版本 {memory.version}、治理版本 {memory.governance?.version??0}。冲突不会发布，也不会改正文。</Text><View style={styles.wrap}><Button title="标记冲突" secondary disabled={isPending(`memory:relate:${memory.id}:conflicts`)} onPress={()=>void relate('conflicts')}/><Button title="标记替代" secondary disabled={isPending(`memory:relate:${memory.id}:supersedes`)} onPress={()=>void relate('supersedes')}/><Button title="设置过期" secondary disabled={isPending(`memory:relate:${memory.id}:expires`)} onPress={()=>void relate('expires')}/></View></View>;
}
function CostPanel({perform,isPending}:{perform:Operation;isPending:(key:string)=>boolean}) {
  const [summary,setSummary]=useState<CostSummary|null>(null);const [series,setSeries]=useState<CostPoint[]>([]);const [breakdown,setBreakdown]=useState<CostBreakdown[]>([]);const [budget,setBudget]=useState<Budget|null>(null);const [group,setGroup]=useState('device');const [period,setPeriod]=useState('month');const [monthly,setMonthly]=useState('');const [taskLimit,setTaskLimit]=useState('');const [categoryDraft,setCategoryDraft]=useState<Record<string,Record<string,string>>>({});
  const load=useCallback(async()=>{const now=new Date();const from=new Date(now);if(period==='today')from.setHours(0,0,0,0);else if(period==='week')from.setDate(from.getDate()-7);else if(period==='year')from.setDate(from.getDate()-365);else{from.setDate(1);from.setHours(0,0,0,0);}const query=`?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(now.toISOString())}`;const [a,b,c,d]=await Promise.all([api.request<CostSummary>('/costs/summary'+query),api.request<List<CostPoint>>('/costs/series'+query),api.request<List<CostBreakdown>>(`/costs/breakdown${query}&group_by=${group}`),api.request<Budget>('/budgets')]);setSummary(a);setSeries(b.items);setBreakdown(c.items);setBudget(d);setMonthly(d.monthly_limit_usd??'');setTaskLimit(d.task_limit_usd??'');const next:Record<string,Record<string,string>>={};for(const category of BUDGET_CATEGORIES){next[category.id]={};for(const limit of BUDGET_LIMITS){const value=d.category_limits?.[category.id]?.[limit.key];next[category.id]![limit.key]=value==null?'':String(value);}}setCategoryDraft(next);},[group,period]);
  useEffect(()=>{void perform(load,`cost:${period}:${group}`);},[perform,load,period,group]);
  const max=Math.max(0,...series.map(p=>Number(p.amount)));
  const reservation=summary?presentCostReservation(summary):null;
  return <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={isPending(`cost:${period}:${group}`)} onRefresh={()=>void perform(load,`cost:${period}:${group}`)}/>} keyboardShouldPersistTaps="handled"><Text style={styles.sectionTitle}>每一项工作的成本</Text><Text style={styles.caption}>仅统计本产品观测到的使用情况；未知费用不视为零。</Text><Choice label="时间范围" value={period} options={[{value:'today',label:'今日'},{value:'week',label:'近7天'},{value:'month',label:'本月'},{value:'year',label:'近一年'}]} onChange={setPeriod}/>{summary&&reservation?<><View style={styles.costHero}><Text style={styles.smallLabel}>已取得金额</Text>{summary.totals.length?summary.totals.map((t,i)=><View key={i}><Text style={styles.money}>{t.currency} {t.amount}</Text><Text style={styles.caption}>{sourceTitle(t.source)}</Text></View>):<Text style={styles.emptyTitle}>暂无可核算金额</Text>}<Text style={styles.caption}>{summary.request_count} 次请求 · 费用覆盖率 {Math.round(summary.coverage*100)}%</Text></View><View style={styles.stats}><View><Text style={styles.caption}>输入 Token</Text><Text style={styles.statValue}>{summary.input_tokens}</Text></View><View><Text style={styles.caption}>输出 Token</Text><Text style={styles.statValue}>{summary.output_tokens}</Text></View></View>{summary.unknown_count>0?<Text style={styles.notice}>{reservation.unknown_label}，包括不可逐次核算的订阅用量。未知金额不会当成 0。</Text>:null}<Text style={styles.notice}>{reservation.hold_label}。预留不是已经发生的费用。</Text><Text style={styles.notice}>{reservation.reserved_unknown_label}</Text></>:null}{series.length?<><Text style={styles.sectionTitle}>费用趋势</Text>{series.map((p,i)=><View key={i} style={styles.trendRow}><Text style={[styles.caption,{width:80}]}>{p.date.slice(5,10)}</Text><View style={{flex:1,backgroundColor:colors.canvas,height:12,borderRadius:3}}><View style={{height:12,width:`${max>0?Number(p.amount)/max*100:0}%`,backgroundColor:p.source==='estimated'?'#B78A49':colors.blue,borderRadius:3}}/></View><Text style={[styles.caption,{width:90,textAlign:'right'}]}>{p.currency} {p.amount}</Text></View>)}</>:null}<View style={styles.divider}/><Choice label="费用分布" value={group} options={[{value:'device',label:'按电脑'},{value:'engine',label:'按引擎'},{value:'task',label:'按任务'},{value:'category',label:'按活动'}]} onChange={setGroup}/>{breakdown.length?breakdown.map((b,i)=><View key={i} style={styles.breakdownRow}><Text style={[styles.body,{flex:1}]}>{b.label}</Text><View><Text style={styles.body}>{b.currency} {b.amount}</Text><Text style={styles.caption}>{b.request_count} 次{b.unknown_count==null?' · 未知次数尚未取得':b.unknown_count>0?` · ${b.unknown_count} 次未知`:''}</Text></View></View>):<Text style={styles.caption}>任务产生用量后，会显示费用明细。</Text>}<View style={styles.divider}/><Text style={styles.sectionTitle}>预算提醒</Text><Input value={monthly} onChangeText={setMonthly} placeholder="月预算 USD（留空不限制）" keyboardType="decimal-pad"/><Input value={taskLimit} onChangeText={setTaskLimit} placeholder="单任务 USD（留空不限制）" keyboardType="decimal-pad"/><Button title="保存预算" disabled={isPending('cost:budget')} onPress={()=>void perform(async()=>{for(const value of [monthly,taskLimit])if(value&&!/^\d+(\.\d{1,10})?$/.test(value))throw new Error('预算请输入非负金额');await api.request('/budgets',{method:'PUT',version:budget?.version,body:moneyBudgetMerge(monthly,taskLimit)});await load();},'cost:budget')}/><View style={styles.divider}/><Text style={styles.sectionTitle}>账号活动上限</Text><Text style={styles.caption}>这是账号默认。任务上的预算是这一项任务自己的覆盖。留空保持已保存的值。保存活动上限不会改月预算和单任务金额。</Text>{BUDGET_CATEGORIES.map(category=><View key={category.id} style={styles.deviceRow}><Text style={styles.body}>{category.label}</Text>{BUDGET_LIMITS.map(limit=>{const stored=budget?.category_limits?.[category.id]?.[limit.key];return <View key={limit.key}><Text style={styles.caption}>{limit.label} · 已保存 {stored==null?'未设置':stored} · 产品上限 {limit.ceiling}</Text><Input value={categoryDraft[category.id]?.[limit.key]??''} onChangeText={value=>setCategoryDraft(prev=>({...prev,[category.id]:{...prev[category.id],[limit.key]:value}}))} placeholder="留空保持当前值" keyboardType="number-pad"/></View>;})}</View>)}<Button title="保存活动上限" disabled={isPending('cost:limits')} onPress={()=>void perform(async()=>{await api.request('/budgets',{method:'PUT',version:budget?.version,body:categoryLimitsMerge(categoryDraft)});await load();},'cost:limits')}/><Text style={styles.caption}>{budget?.explanation??'本月金额是账号上限。每个任务另外计算自己的用量；新的一次运行只使用剩下的额度。运行时长按这一次活动计算。'}</Text><Text style={styles.caption}>已取得金额、未知金额和预留分开显示。预算只阻止下一次新的模型调用，已经发出的请求仍可能产生费用。</Text></ScrollView>;
}
function BudgetRecovery({task,allowance,setAllowance,raiseBudget,pending}:{task:AgentTask;allowance:string;setAllowance:(value:string)=>void;raiseBudget:(task:AgentTask,amount:string)=>Promise<void>;pending:boolean}) {
  const spec=budgetDimension(task.reason_code);
  if(!spec) return task.reason_code?<Text style={styles.notice}>{recoveryText(task.reason_code)}</Text>:null;
  const current=storedBudgetValue(task.budget,spec.key);
  return <View style={styles.question}><Text style={styles.notice}>{spec.recovery}</Text><Text style={styles.caption}>当前任务覆盖：{current==null?'未设置（沿用账号活动默认）':current} · 产品上限 {spec.ceiling}{spec.key==='max_runtime_ms'?' 毫秒（8 小时）':''}</Text><Input value={allowance} onChangeText={setAllowance} placeholder={spec.placeholder} keyboardType="number-pad"/><Button title="提高上限并重试" disabled={pending||!allowance.trim()} onPress={()=>void raiseBudget(task,allowance).then(()=>setAllowance('')).catch(error=>Alert.alert('操作未完成',errorText(error)))}/></View>;
}
function TaskPanel({task,tasks,onSelectTask,devices,questions,perform,reload,onClose,runControl,runAnswer,runInput,raiseBudget,actions,answers,pending,isPending,progress,progressAt,runNotes,now,connected,online,onCheck,onRetryPending,onEditPending,onDeletePending}:{task:AgentTask|undefined;tasks:AgentTask[];onSelectTask:(id:string)=>void;devices:Device[];questions:Question[];perform:Operation;reload:()=>Promise<void>;onClose:()=>void;runControl:(task:AgentTask,action:TaskControlAction,version:number,target:ActionDraft['target'])=>Promise<void>;runAnswer:(question:Question,answer:string)=>Promise<void>;runInput:(task:AgentTask,text:string)=>Promise<void>;raiseBudget:(task:AgentTask,amount:string)=>Promise<void>;actions:ActionDraft[];answers:AnswerDraft[];pending:PendingMessage[];isPending:(key:string)=>boolean;progress:Record<string,{phase:string|null;completed:number|null;total:number|null}>;progressAt:Record<string,number>;runNotes:Record<string,{state:string;text:string}>;now:number;connected:boolean;online:boolean|null;onCheck:()=>void;onRetryPending:(record:PendingMessage)=>void;onEditPending:(record:PendingMessage)=>void;onDeletePending:(record:PendingMessage)=>void}) {
  const [runs,setRuns]=useState<Run[]>([]);const [input,setInput]=useState('');const [switching,setSwitching]=useState(false);const [engine,setEngine]=useState<Engine>(task?.engine??'codex');const [device,setDevice]=useState(task?.device_id??'');const [allowance,setAllowance]=useState('');
  useEffect(()=>{if(task)void api.request<List<Run>>(`/tasks/${task.id}/runs`).then(r=>setRuns(r.items)).catch(()=>{});},[task?.id,task?.updated_at]);
  async function control(next:TaskControlAction){if(!task)return;if(next==='switch'&&devices.find(item=>item.id===device)?.revoked){Alert.alert('操作未完成','此电脑已撤销，请手动选择其他电脑');return;}await runControl(task,next,task.version,next==='switch'?{engine,device_id:device}:null);if(next==='switch')setSwitching(false);}
  if(!task)return <><View style={styles.header}><Text style={styles.headerTitle}>任务</Text><Button title="关闭" secondary onPress={onClose}/></View><Empty title="任务尚未取得" detail="返回任务列表刷新后重试。"/></>;
  return <><View style={styles.header}><Text style={styles.headerTitle}>任务详情</Text><Button title="关闭" secondary onPress={onClose}/></View><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"><Text style={styles.taskTitle}>{task.title}</Text><StateBadge value={task.status}/><Text selectable style={styles.body}>{task.goal}</Text><Text style={styles.caption}>{task.engine==='codex'?'Codex':'Grok'} · {devices.find(d=>d.id===task.device_id)?.name??'等待电脑'}{task.model_id?` · ${task.model_id}`:''}</Text>{task.memory_scope?<Text style={styles.caption}>记忆范围：项目 {task.memory_scope.project||'未指定'} · 网站 {task.memory_scope.sites?.length?task.memory_scope.sites.join('、'):'无'} · 全局偏好 {task.memory_scope.global_preference?'开':'关'} · 状态 {task.memory_scope.statuses?.join('、')||'verified'} · 最大版本 {task.memory_scope.max_version??'不限'}</Text>:null}<BudgetRecovery task={task} allowance={allowance} setAllowance={setAllowance} raiseBudget={raiseBudget} pending={isPending(`budget:${task.id}`)}/><TaskProgressCard title={task.title} phase={progress[task.id]?.phase??null} note={runNotes[task.id]?.text??null} completed={progress[task.id]?.completed??null} total={progress[task.id]?.total??null} at={progressAt[task.id]??null} now={now} connected={connected} online={online} onCheck={onCheck}/>{(()=>{const latest=actions.filter(item=>item.task_id===task.id).at(-1);return latest?<Text style={styles.notice}>{actionDraftLabel(latest)}</Text>:null;})()}<View style={styles.wrap}><Button title="暂停" secondary onPress={()=>void control('pause')}/><Button title="继续" onPress={()=>void control('resume')}/><Button title="切换执行" secondary onPress={()=>setSwitching(!switching)}/><Button title="重试" secondary onPress={()=>void control('retry')}/><Button title="取消" secondary danger onPress={()=>Alert.alert('取消任务？','将停止后续受管执行，已提交的业务操作不会自动撤回。',[{text:'返回',style:'cancel'},{text:'取消任务',style:'destructive',onPress:()=>void control('cancel')}])}/></View>{switching?<View style={styles.question}><Choice label="新引擎" value={engine} options={[{value:'codex',label:'Codex'},{value:'grok',label:'Grok'}]} onChange={v=>setEngine(v as Engine)}/><Choice label="新执行电脑" value={device} options={devices.filter(d=>!d.revoked).map(d=>({value:d.id,label:d.name}))} onChange={setDevice}/><Text style={styles.caption}>先停止旧 Worker，保存检查点，再继续未完成的工作。</Text><Button title="切换并继续" disabled={!device} onPress={()=>void control('switch')}/></View>:null}{pending.filter(record=>record.task_id===task.id).map(record=><PendingCard key={record.client_message_id} record={record} onDelete={()=>onDeletePending(record)} onRetry={()=>onRetryPending(record)} onEdit={()=>onEditPending(record)}/>)}{questions.map(q=>{const answer=answers.find(item=>item.question_id===q.id&&item.phase!=='settled');const note=answer?.phase==='result_unknown'?'发送结果待确认':answer?.phase==='conflict'?'请求冲突':answer?'发送中':undefined;return <QuestionCard key={q.id} question={q} pending={isPending(pendingKey('answer',q.id))} note={note} onAnswer={text=>runAnswer(q,text)}/>;})}<TaskRelations task={task} tasks={tasks} onSelect={onSelectTask}/>{task.status==='awaiting_review'?<DeliveryReview key={task.id} taskId={task.id} reload={reload}/>:null}<View style={styles.divider}/><Text style={styles.sectionTitle}>运行记录</Text>{runs.length?runs.map(r=><View key={r.id} style={styles.runRow}><View style={styles.row}><Text style={styles.body}>{r.engine==='codex'?'Codex':'Grok'}</Text><StateBadge value={r.state}/></View><Text selectable style={styles.body}>{r.result_text||r.summary||r.model_id}</Text><Text style={styles.caption}>{time(r.created_at)}</Text><ToolTimeline runId={r.id} state={r.state}/></View>):<Text style={styles.caption}>任务尚未开始执行。</Text>}{(task.reason_code?.includes('unknown')||runs.some(r=>r.state==='result_unknown'))?<Reconciliation taskId={task.id} version={task.version} perform={perform} reload={reload}/>:null}{task.current_run_id?<FramePanel runId={task.current_run_id}/>:null}<TaskArtifacts taskId={task.id}/><View style={styles.divider}/><Text style={styles.sectionTitle}>补充要求</Text><Input multiline value={input} onChangeText={setInput} placeholder="补充目标、说明或约束"/><Button title="发送补充" disabled={!input.trim()||isPending(pendingKey('input',task.id))} onPress={()=>void runInput(task,input).then(()=>setInput('')).catch(()=>undefined)}/></ScrollView></>;
}
function FramePanel({runId}:{runId:string}) {
  const [viewId,setViewId]=useState('');const [frame,setFrame]=useState<Frame|null>(null);const [controlling,setControlling]=useState(false);const [status,setStatus]=useState('打开后才会连续采集画面');const [text,setText]=useState('');const [display,setDisplay]=useState({width:0,height:0});
  useEffect(()=>{if(!viewId)return;let active=true;let fetching=false;async function tick(){if(fetching)return;fetching=true;try{const result=await api.request<Frame>(`/runs/${runId}/frame`);if(active){setFrame(result);setStatus('画面按需刷新');}}catch(e){if(active)setStatus(e instanceof APIError&&e.status===404?'等待执行电脑的画面':`画面连接中断：${errorText(e)}`);}finally{fetching=false;}}void tick();const timer=setInterval(()=>void tick(),1500);return()=>{active=false;clearInterval(timer);void api.request(`/views/${viewId}`,{method:'DELETE'}).catch(()=>{});};},[viewId,runId]);
  async function start(){try{const result=await api.request<{id:string}>(`/runs/${runId}/views`,{method:'POST',body:{}});setViewId(result.id);}catch(e){setStatus(errorText(e));}}
  async function control(release:boolean){try{await api.request(`/views/${viewId}/control`,{method:release?'DELETE':'POST',body:release?undefined:{}});setControlling(!release);setStatus(release?'接管已结束，任务保持暂停':'接管请求已接受，输入仅在任务静止后放行');}catch(e){setStatus(errorText(e));}}
  async function send(payload:Record<string,unknown>){if(!frame)return;try{await api.request(`/views/${viewId}/inputs`,{method:'POST',body:{frame_id:frame.frame_id,viewport_version:frame.viewport_version,...payload}});}catch(e){setStatus(errorText(e));}}
  return <View style={styles.framePanel}><View style={styles.row}><Text style={[styles.sectionTitle,{flex:1}]}>浏览器画面</Text><Button title={viewId?'关闭':'查看'} secondary onPress={()=>{if(viewId){setViewId('');setFrame(null);setControlling(false);setStatus('连续采集已关闭');}else void start();}}/></View><Text style={styles.caption}>{status}</Text>{frame?<Pressable disabled={!controlling} onLayout={e=>setDisplay(e.nativeEvent.layout)} onPress={e=>{if(display.width&&display.height)void send({type:'click',x:e.nativeEvent.locationX/display.width*frame.width,y:e.nativeEvent.locationY/display.height*frame.height});}}><Image accessibilityLabel="执行电脑当前网页" source={{uri:`data:image/jpeg;base64,${frame.image_base64}`}} style={{width:'100%',aspectRatio:frame.width/Math.max(frame.height,1),backgroundColor:colors.canvas}} resizeMode="contain"/></Pressable>:null}{frame?<Text style={styles.caption}>采集于 {time(frame.captured_at)}</Text>:null}{viewId?<Button title={controlling?'结束接管':'暂停并接管'} secondary onPress={()=>void control(controlling)}/>:null}{controlling?<><Input value={text} onChangeText={setText} placeholder="输入到页面"/><View style={styles.row}><Button title="输入" onPress={()=>{void send({type:'text',text});setText('');}}/><Button title="Enter" secondary onPress={()=>void send({type:'keys',keys:'Enter'})}/></View><Text style={styles.caption}>结束接管后任务保持暂停，请通过任务操作继续。</Text></>:null}</View>;
}

const styles=StyleSheet.create({
  root:{flex:1,backgroundColor:colors.canvas},header:{paddingHorizontal:22,paddingVertical:18,borderBottomWidth:StyleSheet.hairlineWidth,borderBottomColor:colors.line,flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:12,backgroundColor:colors.surface},headerTitle:{fontSize:24,fontWeight:'700',color:colors.ink},brand:{fontSize:17,fontWeight:'700',color:colors.blue,marginBottom:35},login:{padding:28,paddingTop:48,gap:18,maxWidth:560,width:'100%',alignSelf:'center'},loginTitle:{fontSize:35,fontWeight:'700',lineHeight:46,color:colors.ink},subtitle:{fontSize:16,lineHeight:26,color:colors.muted},loginForm:{marginTop:20,gap:16,padding:22,backgroundColor:colors.surface,borderRadius:16,borderWidth:StyleSheet.hairlineWidth,borderColor:colors.line},content:{padding:22,gap:17,paddingBottom:40},body:{fontSize:15,lineHeight:24,color:colors.ink},caption:{fontSize:12,lineHeight:19,color:colors.muted},smallLabel:{fontSize:12,fontWeight:'500',color:colors.muted},sectionTitle:{fontSize:17,fontWeight:'600',color:colors.ink},taskTitle:{fontSize:24,fontWeight:'700',lineHeight:33,color:colors.ink},link:{fontSize:14,fontWeight:'600',color:colors.blue},input:{fontSize:15,lineHeight:22,color:colors.ink,backgroundColor:colors.surface,borderWidth:1,borderColor:colors.line,borderRadius:9,paddingHorizontal:13,paddingVertical:12},button:{paddingVertical:11,paddingHorizontal:17,borderRadius:8,backgroundColor:colors.blue,alignItems:'center',justifyContent:'center',minHeight:43},secondaryButton:{backgroundColor:colors.pale},dangerButton:{backgroundColor:'#F7EEE1'},buttonText:{fontSize:14,fontWeight:'600',color:'#FFFFFF'},row:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:12},wrap:{flexDirection:'row',flexWrap:'wrap',gap:8},choice:{padding:10,gap:5,borderWidth:1,borderColor:colors.line,borderRadius:8,backgroundColor:colors.surface,flex:1,minWidth:90},choiceValue:{fontSize:13,fontWeight:'500',color:colors.ink},selection:{flexDirection:'row',gap:8},scrim:{flex:1,backgroundColor:'rgba(24,43,69,0.35)',justifyContent:'center',padding:24},choiceSheet:{backgroundColor:colors.surface,borderRadius:16,padding:24,gap:20,maxHeight:'75%'},option:{paddingVertical:15,borderBottomWidth:StyleSheet.hairlineWidth,borderColor:colors.line},error:{fontSize:13,lineHeight:21,color:colors.amber},errorBanner:{padding:14,backgroundColor:'#FBF1E2',gap:4},empty:{paddingVertical:45,paddingHorizontal:16,gap:12,alignItems:'center'},emptyTitle:{fontSize:20,fontWeight:'600',color:colors.ink},emptyDetail:{fontSize:14,lineHeight:24,color:colors.muted,textAlign:'center',maxWidth:340},navigation:{flexDirection:'row',backgroundColor:colors.surface,paddingTop:10,paddingHorizontal:10,paddingBottom:Platform.OS==='android'?22:25,borderTopWidth:StyleSheet.hairlineWidth,borderColor:colors.line},navItem:{flex:1,alignItems:'center',paddingVertical:12,borderRadius:8},navSelected:{backgroundColor:colors.pale},navText:{fontSize:13,color:colors.muted},composer:{paddingHorizontal:18,paddingVertical:15,gap:12,backgroundColor:colors.surface,borderTopWidth:StyleSheet.hairlineWidth,borderColor:colors.line},message:{paddingVertical:13,gap:9},userMessage:{padding:16,backgroundColor:colors.pale,borderRadius:12},messageRole:{fontSize:13,fontWeight:'600',color:colors.ink},messageBody:{fontSize:15,lineHeight:26,color:colors.ink},inboxHint:{padding:14,borderRadius:8,backgroundColor:colors.pale},taskRow:{paddingVertical:19,borderBottomWidth:StyleSheet.hairlineWidth,borderColor:colors.line,gap:11},badge:{fontSize:11,paddingHorizontal:8,paddingVertical:4,borderRadius:6},question:{padding:18,gap:14,backgroundColor:'#EAF0F8',borderRadius:12},deviceRow:{padding:18,gap:14,backgroundColor:colors.surface,borderRadius:12,borderWidth:StyleSheet.hairlineWidth,borderColor:colors.line},memoryRow:{padding:18,gap:14,backgroundColor:colors.surface,borderRadius:10,borderWidth:StyleSheet.hairlineWidth,borderColor:colors.line},divider:{height:StyleSheet.hairlineWidth,backgroundColor:colors.line,marginVertical:5},costHero:{paddingVertical:22,gap:13,borderTopWidth:2,borderColor:colors.blue},money:{fontSize:31,fontWeight:'700',color:colors.ink},stats:{flexDirection:'row',justifyContent:'space-between',gap:20},statValue:{fontSize:23,fontWeight:'600',color:colors.ink,marginTop:6},notice:{fontSize:13,lineHeight:22,color:colors.amber,backgroundColor:'#F8F0E4',padding:13,borderRadius:8},trendRow:{flexDirection:'row',alignItems:'center',gap:8,minHeight:26},breakdownRow:{flexDirection:'row',justifyContent:'space-between',gap:12,paddingVertical:10,borderBottomWidth:StyleSheet.hairlineWidth,borderColor:colors.line},runRow:{paddingVertical:13,gap:8,borderBottomWidth:StyleSheet.hairlineWidth,borderColor:colors.line},framePanel:{gap:14,padding:15,backgroundColor:colors.surface,borderRadius:10}
});
