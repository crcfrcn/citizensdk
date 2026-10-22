import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'dart:isolate';

import 'package:flutter/services.dart' hide Size;

import '../api/citizen_sdk_error.dart';
import 'bind.dart' as c;
import 'citizen_sdk_flutter_codec.dart';
import 'citizen_sdk_platform.dart';
import 'result.dart';

/// 业务直接调用同一C ABI；平台消息只承担资源、认证、相机和必要UI。
final class FfiCitizenSdkPlatform implements CitizenSdkPlatform {
 FfiCitizenSdkPlatform({MethodChannel? methodChannel,EventChannel? eventChannel,c.Bindings? bindings}):_methods=methodChannel??const MethodChannel('citizen/sdk/core/v2'),_nativeEvents=eventChannel??const EventChannel('citizen/sdk/events/v2'),_provided=bindings;
 final MethodChannel _methods;final EventChannel _nativeEvents;final c.Bindings? _provided;
 final _codec=const CitizenSdkFlutterCodec();final _sessions=<String,_Session>{};final _events=StreamController<Object?>.broadcast(sync:true);StreamSubscription<Object?>? _subscription;
 late final c.Bindings _api=_provided??c.Bindings.fromLookup(<T extends NativeType>(String symbol){final lib=Platform.isIOS||Platform.isMacOS?DynamicLibrary.process():DynamicLibrary.open(Platform.isWindows?'citizensdk.dll':'libcitizensdk.so');if((symbol.startsWith('citizensdk_qr_image_')||symbol.startsWith('citizensdk_dart_'))&&Platform.isAndroid)return DynamicLibrary.open('libcitizensdk_jni.so').lookup<T>(symbol);if(symbol.startsWith('citizensdk_qr_image_')||symbol.startsWith('citizensdk_dart_')){if(Platform.isLinux)return DynamicLibrary.open('libcitizensdk_host.so').lookup<T>(symbol);if(Platform.isWindows)return DynamicLibrary.open('citizensdk_host.dll').lookup<T>(symbol);}return lib.lookup<T>(symbol);});
 static const ui={'close','readDiagnostics','openPrivateKey','revealPrivateKey','closePrivateKey','openQrCapture','closeQrCapture','pauseQrCapture','resumeQrCapture','setQrCaptureTorch','qrDecodeImage','respondCredential','cancelCredential'};
 @override Stream<Object?> get events { _subscription??=_nativeEvents.receiveBroadcastStream(const <Object?>[2]).listen((raw){if(raw is! List<Object?>||raw.length!=5||raw[1] is! String)return;final session=_sessions[raw[1]];if(session==null)return;final type=raw[3];if(type is! String||(!type.startsWith('qrCapture')&&type!='privateKeyClosed'&&!type.startsWith('credential')))return;session.emit(type,raw[4]! as List<Object?>);},onError:_events.addError);return _events.stream;}
 Future<Object?> _ui(String method,List<Object?> args)async{try{return await _methods.invokeMethod<Object?>(method,args);}on PlatformException catch(e){throw _codec.decodePlatformException(e,expectedMethod:method);}on MissingPluginException{throw failure(4,'CitizenSDK platform resources are unavailable');}}
 @override Future<Object?> invoke(String method,List<Object?> args) async {
  if(method=='open'){
   final raw=await _ui(method,args);if(raw is! List<Object?>||raw.length!=4||raw[1] is! String)throw failure(16);
   final id=raw[1]! as String;_Session? session;
   try{if(raw[0]!=2||raw[2]!=0||raw[3] is! List<Object?>||_sessions.containsKey(id))throw failure(16);final value=raw[3]! as List<Object?>;if(value.length!=3||value[2] is! String)throw failure(16);
    session=_Session(_api,u64(value[2]),id,(type,payload,sequence)=>_events.add([2,id,sequence,type,payload]),(row)async{try{await _ui('diagnose',[2,id,row]);}catch(_){/* 诊断IO失败不能改变业务结果。 */}});
    session.attach();_sessions[id]=session;session.emit('lifecycleChanged',[session.lifecycle()]);session.emit('capabilitiesChanged',[session.withMemory((p)=>p.capabilities(session!.handle))]);return[2,id,0,value.sublist(0,2)];
   }catch(_){_sessions.remove(id);if(session!=null){final code=_api.citizensdk_detach(session.handle);if(code==0)session.port?.close();}await _ui('close',[2,id,1]);session?.port?.close();rethrow;}
  }
  if(method=='verifySignature'||method=='encodeSigningPayload'){
   final m=Memory();try{if(method=='verifySignature'){if(args.length!=4)throw failure(1);final out=m.alloc<Uint8>(1);check(_api.citizensdk_verify_signature(m.account(args[1]),m.view(args[2],64),m.view(args[3]),out));return[2,out.value==1];}
    if(args.length!=4||args[1] is! int)throw failure(1);return[2,m.copy((p,cap,n)=>_api.citizensdk_encode_signing_payload(args[1]! as int,m.view(args[2],4096),m.view(args[3]),p,cap,n),16777216)];
   }finally{m.dispose();}
  }
  if(args.length<3||args[0]!=2||args[1] is! String||args[2] is! int)throw failure(1);final id=args[1]! as String,sequence=args[2]! as int;final session=_sessions[id];if(session==null)throw failure(7);if(session.closed)throw failure(3);final fields=args.sublist(3);
  if(method=='cancelOperation'&&session.uiOperations.contains(u64(fields[0])))return _ui(method,args);
  if(ui.contains(method)){
   if(method=='close'){session.closing=true;await session.drain();session.releaseResources();final value=await _ui(method,args);session.closed=true;session.port?.close();_sessions.remove(id);return value;}
   session.uiOperations.add(sequence);try{return await _ui(method,args);}finally{session.uiOperations.remove(sequence);}
  }
  check(_api.citizensdk_accept_request_sequence(session.handle,sequence));_codec.encodeRequest(method:method,sessionId:id,requestSequence:sequence,fields:fields);
  final value=await session.invoke(method,fields,sequence);_codec.validateResponseValue(method,value);return[2,id,sequence,value];
 }
}
final class _Resource { _Resource(this.kind,this.value);final String kind;final int value;bool claimed=false; }
final class _Pending { _Pending(this.method,this.fields,this.sequence);final String method;final List<Object?> fields;final int sequence;final done=Completer<List<Object?>>();int request=0; }
final class _Session {
 _Session(this.api,this.handle,this.id,this.send,this.trace);final c.Bindings api;final int handle;final String id;final void Function(String,List<Object?>,int) send;final Future<void> Function(List<Object?>) trace;
 final uiOperations=<int>{};final pending=<int,_Pending>{},operations=<int,int>{};final resources=<String,_Resource>{};int _next=1,_event=1;bool closed=false,closing=false;ReceivePort? port;
 T withMemory<T>(T Function(Projection) body){final m=Memory();try{return body(Projection(api,m));}finally{m.dispose();}}
 void attach(){if(api.citizensdk_dart_api_major()!=NativeApi.majorVersion)throw failure(4);if(api.citizensdk_abi_version()!=1)throw failure(4);port=ReceivePort();port!.listen((Object? message){if(message is! List<Object?>||message.length!=5||message.any((v)=>v is! int))throw failure(9);{final values=message.cast<int>();if(values[0]==0){closed=true;port!.close();for(final resource in resources.values){if(resource.kind=='inspection'||resource.kind=='review'){final code=api.citizensdk_result_release(resource.value);if(code!=0&&code!=2)throw failure(code);}}for(final value in pending.values){value.done.completeError(failure(22,'SDK receiver detached'));}pending.clear();operations.clear();resources.clear();return;}receive(values[0],values[2],values[3]);}});check(api.citizensdk_attach(handle,api.addresses.citizensdk_dart_emit,NativeApi.postCObject.cast(),port!.sendPort.nativePort));}

 String lifecycle()=>withMemory((p){final out=p.m.alloc<Uint32>(4);check(api.citizensdk_get_lifecycle(handle,out));return switch(out.value){1=>'created',2=>'importingState',3=>'starting',4=>'running',5=>'startFailed',6=>'stopped',7=>'disposed',_=>throw failure(9)};});
 void emit(String type,List<Object?> payload){if(!closed)send(type,payload,_event++);}
 String retain(String kind,int value){final key='$id-${_next++}';resources[key]=_Resource(kind,value);return key;}
 _Resource resource(Object? id,String kind){final value=resources[id];if(value==null||value.kind!=kind)throw failure(7);return value;}
 // detach可以在VM尚未消费消息时回收结果；只把已被回收的释放视为幂等。
 void releaseEvent(int result){final code=api.citizensdk_result_release(result);if(code!=0&&code!=2)throw failure(code);}
 void receive(int type,int request,int result){
  if(closed)return;
  if(type==1){final operation=pending.remove(request);if(operation==null){if(result!=0)releaseEvent(result);return;}operations.remove(operation.sequence);
   try{final value=withMemory((p){p.inspect(result);return project(p,result,operation.method,operation.fields);});operation.done.complete(value);}on CitizenSdkException catch(e,st){operation.done.completeError(e.code==CitizenSdkErrorCode.invalidHandle?failure(22,'SDK receiver detached'):e,st);}catch(e,st){operation.done.completeError(e,st);}finally{if(!_reviewTransferred.remove(result))releaseEvent(result);}return;
  }
  if(closing){if(result!=0){final code=api.citizensdk_result_release(result);if(code!=0&&code!=2)throw failure(code);}return;}
  try{switch(type){case 3:emit('capabilitiesChanged',[withMemory((p)=>p.capabilities(handle))]);case 4:emit('lifecycleChanged',[lifecycle()]);case 5:emit('historyChanged',[]);case 7:emit('walletChanged',[]);case 6:final value=withMemory((p){final out=p.m.alloc<c.citizensdk_block_ref>(sizeOf<c.citizensdk_block_ref>());check(api.citizensdk_result_get_block_ref(result,out));return block(out.ref);});emit('finalizedBlockChanged',[value]);}}on CitizenSdkException catch(e){if(e.code!=CitizenSdkErrorCode.invalidHandle)rethrow;}finally{if(result!=0)releaseEvent(result);}
 }
 Future<void> drain()async{for(final id in List<int>.of(pending.keys)){final code=api.citizensdk_cancel_request(handle,id);if(code!=0&&code!=4&&code!=7)throw failure(code);}while(pending.isNotEmpty){await Future.wait(pending.values.map((v)=>v.done.future.then<void>((_){} ,onError:(Object _,StackTrace _){})));}}
 void releaseResources(){for(final key in List<String>.of(resources.keys)){final r=resources[key]!;check(switch(r.kind){'preparedWallet'=>api.citizensdk_prepared_wallet_release(handle,r.value),'transaction'=>api.citizensdk_prepared_transaction_release(handle,r.value),_=>api.citizensdk_result_release(r.value)});resources.remove(key);}}
 Pointer<c.citizensdk_account_id> accounts(Memory m,Object? raw,int max){final list=raw! as List<Object?>;if(list.length>max)throw failure(1);final out=m.alloc<c.citizensdk_account_id>(32*list.length);for(var i=0;i<list.length;i++){final bytes=unhex(list[i],32);for(var j=0;j<32;j++){out[i].bytes[j]=bytes[j];}}return out;}
 Pointer<c.citizensdk_transaction_execution_id> executionId(Memory m,Object? raw){final data=unhex(raw,16);return m.bytes(data).cast<c.citizensdk_transaction_execution_id>();}
 Future<List<Object?>> invoke(String method,List<Object?> f,int sequence)async{
  const tracked={'start','stop','getSyncStatus','getWalletState','inspectWallets','releaseWalletInspection','cancelOperation'};final clock=Stopwatch()..start();
  if(tracked.contains(method))unawaited(trace([method,'BEGIN',0,0,'NONE',0]));
  try{final value=await call(method,f,sequence);if(tracked.contains(method))unawaited(trace([method,'COMPLETE',0,0,'NONE',clock.elapsedMilliseconds.clamp(0,86400000)]));return value;}
  on CitizenSdkException catch(e){if(tracked.contains(method)){const points={'ADMISSION','LOCAL_READ','RESULT_READY','RESTORE','BEGIN','PUBLISH_BEGIN','PROVIDER_START','REFRESH','COMPLETE','SERVICES','PUBLISH_COMPLETE'};final prefix=method=='start'?'CitizenSDK start panicked at ':'CitizenSDK request panicked at ';final point=e.code==CitizenSdkErrorCode.panic&&e.message.startsWith(prefix)?e.message.substring(prefix.length):'NONE';unawaited(trace([method,'COMPLETE',e.code.index+1,e.stage.index+1,points.contains(point)?point:'NONE',clock.elapsedMilliseconds.clamp(0,86400000)]));}rethrow;}
 }
 Future<List<Object?>> call(String method,List<Object?> f,int sequence)async{
  final m=Memory();try{
   final p=Projection(api,m);final out=m.alloc<Uint64>(8);
   switch(method){
    case 'getCapabilities':return[p.capabilities(handle)];
    case 'getGenesisHash':final bytes=m.alloc<Uint8>(32);check(api.citizensdk_get_genesis_hash(handle,bytes));return['0x${bytes.asTypedList(32).map((b)=>b.toRadixString(16).padLeft(2,'0')).join()}'];
    case 'cancelOperation':final target=operations[u64(f[0])];if(target==null)return[false];final code=api.citizensdk_cancel_request(handle,target);if(code==4||code==7)return[false];check(code);return[true];
    case 'cancelSigning':final b=m.alloc<Uint8>(1);check(api.citizensdk_cancel_signing_session(handle,m.view(f[0],128),b));return[b.value==1];
    case 'copyRecoveryPhrase':return[m.copy((b,cap,n)=>api.citizensdk_prepared_wallet_copy_mnemonic(handle,resource(f[0],'preparedWallet').value,b,cap,n),1024)];
    case 'releasePreparedWallet':final r=resource(f[0],'preparedWallet');check(api.citizensdk_prepared_wallet_release(handle,r.value));resources.remove(f[0]);return[];
    case 'releaseWalletInspection':case 'releaseQrReview':final r=resource(f[0],method=='releaseQrReview'?'review':'inspection');check(api.citizensdk_result_release(r.value));resources.remove(f[0]);return[];
    case 'cancelPreparedTransaction':final r=resource(f[0],'transaction');check(api.citizensdk_prepared_transaction_release(handle,r.value));resources.remove(f[0]);return[null];
    case 'cancelPreparedTransactionExecution':check(api.citizensdk_transaction_execution_cancel(handle,executionId(m,f[0])));return[null];
    case 'validateWalletPassword':case 'validateWalletMnemonic':final v=m.struct<c.citizensdk_wallet_input_validation_v1>(sizeOf<c.citizensdk_wallet_input_validation_v1>());check(api.citizensdk_validate_wallet_input(method=='validateWalletPassword'?1:2,m.view(f[0],1024),method=='validateWalletPassword'?0:f[1]! as int,v));return[v.ref.reason,v.ref.position==0xffffffff?null:v.ref.position];
    case 'walletWordSuggestions':final data=p.text((b,cap,n)=>api.citizensdk_wallet_word_suggestions(m.view(f[0],1024),b,cap,n),1024);return[data.isEmpty?<String>[]:data.split('\n')];
    case 'qrParse':case 'qrEncodeAccountId':case 'qrCreateSignRequest':case 'qrEncodeDocument':case 'qrPrepareAccountAuthorization':case 'qrConsumeSignResponse':case 'qrValidateSignResponse':case 'qrCancelSignRequest':case 'qrEncode':case 'qrDecodeLuminance':return qr(method,f,m,p);
   }
   if(pending.length>=64)throw failure(19);
   final operation=_Pending(method,method=='getAccountBalances'?f:const [],sequence);
   int accept(){return switch(method){
    'start'=>api.citizensdk_start(handle,out),'stop'=>api.citizensdk_stop(handle,out),
    'getFinalizedHead'=>api.citizensdk_get_finalized_head(handle,out),'getBestHead'=>api.citizensdk_get_best_head(handle,out),'getSyncStatus'=>api.citizensdk_get_sync_status(handle,out),
    'getFinalizedBlockAt'=>api.citizensdk_get_finalized_block_at(handle,u64(f[0]),out),'resolveFinalizedBlock'=>api.citizensdk_resolve_finalized_block(handle,m.bytes(unhex(f[0],32)),u64(f[1]),out),
    'getBlockHeader'=>api.citizensdk_get_block_header_at(handle,m.block(f[0]),out),'getBlockBody'=>api.citizensdk_get_block_body_at(handle,m.block(f[0]),out),'getRuntimeContext'=>api.citizensdk_get_runtime_context_at(handle,m.block(f[0]),out),'getSystemEvents'=>api.citizensdk_get_system_events_at(handle,m.block(f[0]),out),
    'getStorage'=>api.citizensdk_get_storage_at(handle,m.block(f[0]),m.view(f[1],4096),out),
    'getStorageBatch'=>storageBatch(m,f,out),
    'getStorageKeysPaged'=>api.citizensdk_get_storage_keys_paged(handle,m.block(f[0]),m.view(f[1],4096),f[2]==null?0:1,m.view(f[2]??Uint8List(0),4096),f[3]! as int,out),
    'callRuntimeApi'=>api.citizensdk_call_runtime_api(handle,m.block(f[0]),m.view(f[1],128),m.view(f[2],1048576),out),
    'exportState'=>api.citizensdk_export_state(handle,out),'importState'=>importState(m,f,out),
    'getAccountBalance'=>api.citizensdk_get_finalized_account_balance(handle,m.account(f[0]),out),'getAccountBalances'=>api.citizensdk_get_finalized_account_balances(handle,accounts(m,f[0],1990),(f[0]! as List<Object?>).length,out),'getAccountNonce'=>api.citizensdk_get_account_nonce(handle,m.account(f[0]),out),'getFeeSnapshot'=>api.citizensdk_get_best_fee_snapshot(handle,out),
    'getWalletState'||'inspectWallets'=>api.citizensdk_get_wallet_state(handle,out),
    'prepareWalletCreation'=>api.citizensdk_prepare_wallet_creation(handle,f[0]! as int,m.view(f[1],1024),out),
    'commitWalletCreation'=>claim(f[0],'preparedWallet',(v)=>api.citizensdk_commit_wallet_creation(handle,v,out)),
    'importWallet'=>api.citizensdk_import_wallet(handle,m.view(f[0],1024),m.view(f[1],1024),out),
    'addNextWalletAccount'=>api.citizensdk_add_next_wallet_account(handle,m.view(f[0],1024),m.view(f[1],1024),out),'addWalletAccounts'=>addAccounts(m,f,out),
    'signAndDeleteWallet'=>api.citizensdk_sign_and_delete_wallet(handle,out),'deleteWallet'=>api.citizensdk_delete_wallet(handle,out),'reconcileWalletCleanup'=>api.citizensdk_reconcile_wallet_cleanup(handle,out),
    'setActiveWalletAccount'=>api.citizensdk_set_active_wallet_account(handle,m.account(f[0]),out),'renameAccount'=>api.citizensdk_rename_account(handle,m.account(f[0]),m.view(f[1],120),out),'deleteAccount'=>api.citizensdk_delete_account(handle,m.account(f[0]),out),
    'setActiveWallet'=>api.citizensdk_set_active_wallet(handle,u64(f[0]),f[1]! as int,out),'renameWallet'=>api.citizensdk_rename_wallet(handle,u64(f[0]),f[1]! as int,m.view(f[2],120),out),
    'repairHotWallet'=>api.citizensdk_repair_hot_wallet(handle,resource(f[0],'inspection').value,f[1]! as int,out),'renameDiagnosticWallet'=>api.citizensdk_rename_diagnostic_wallet(handle,resource(f[0],'inspection').value,f[1]! as int,m.view(f[2],120),out),'deleteDiagnosticWallet'=>api.citizensdk_delete_diagnostic_wallet(handle,resource(f[0],'inspection').value,f[1]! as int,out),
    'importColdAccountId'=>api.citizensdk_import_cold_account_id(handle,m.account(f[0]),m.view(f[1],120),out),'importColdAccountSs58'=>api.citizensdk_import_cold_account_ss58(handle,m.view(f[0],128),m.view(f[1],120),out),'importColdAccountCode'=>importCode(m,p,f,out),
    'reorderWalletAccountsWithoutDefaultChange'=>api.citizensdk_reorder_wallet_accounts_without_default_change(handle,u64(f[0]),accounts(m,f[1],256),(f[1]! as List<Object?>).length,out),
    'signWalletPayload'=>api.citizensdk_sign_wallet_payload(handle,m.account(f[0]),m.view(f[1]),out),
    'beginSigning'=>api.citizensdk_begin_signing(handle,m.account(f[0]),m.view(f[1]),switch(f[2]){'raw'=>1,'substrateSigningPayload'=>2,'blake2Domain'=>3,_=>throw failure(1)},m.view(f[3],32),f[4]=='none'?0:1,f[5]! as int,f[6]! as int,out),
    'consumeExternalSignature'=>api.citizensdk_consume_external_signature(handle,m.view(f[0],128),m.view(f[1],2331),out),'beginDefaultAccountChange'=>api.citizensdk_begin_default_account_change(handle,u64(f[0]),accounts(m,f[1],256),(f[1]! as List<Object?>).length,f[2]! as int,out),'consumeDefaultAccountChange'=>api.citizensdk_consume_default_account_change(handle,m.view(f[0],128),m.view(f[1],2331),out),
    'prepareTransaction'=>api.citizensdk_prepare_transaction(handle,m.account(f[0]),m.view(f[1],1048576),out),'executePreparedTransaction'=>claim(f[0],'transaction',(v)=>api.citizensdk_execute_prepared_transaction(handle,v,out)),
    'consumePreparedTransactionQrResponse'=>api.citizensdk_transaction_execution_consume_qr_response(handle,executionId(m,f[0]),m.view(f[1],2331),out),
    'getTransactionHistory'=>api.citizensdk_get_transaction_history(handle,f[0]==null?nullptr:executionId(m,f[0]),f[1]! as int,out),'syncTransactionHistory'=>api.citizensdk_sync_transaction_history(handle,out),
    'reviewQrRequest'=>api.citizensdk_review_qr_sign_request(handle,m.view(f[0],2331),out),'signQrRequest'=>claim(f[0],'review',(v)=>api.citizensdk_sign_qr_request(handle,v,out)),
    _=>throw failure(4,'Unsupported CitizenSDK method')};}
   Object? thrown;final job=NativeCallable<Int32 Function(Pointer<Void>)>.isolateLocal((Pointer<Void> ctx){try{return accept();}catch(e){thrown=e;return 1;}},exceptionalReturn:20);
   int code;try{code=api.citizensdk_invoke(handle,job.nativeFunction,nullptr);}finally{job.close();}
   if(thrown!=null)throw thrown!;check(code);if(out.value==0)throw failure(9);operation.request=out.value;pending[out.value]=operation;operations[sequence]=out.value;
   m.dispose();
   return await operation.done.future;
  }finally{m.dispose();}
 }
 int claim(Object? id,String kind,int Function(int) call){final r=resource(id,kind);if(r.claimed)throw failure(3);final code=call(r.value);if(code==0){r.claimed=true;if(kind=='transaction')resources.remove(id);}return code;}
 int storageBatch(Memory m,List<Object?> f,Pointer<Uint64> out){final keys=f[1]! as List<Object?>;final values=m.alloc<c.citizensdk_bytes_view>(keys.length*sizeOf<c.citizensdk_bytes_view>());for(var i=0;i<keys.length;i++){values[i]=m.view(keys[i],4096);}return api.citizensdk_get_storage_batch_at(handle,m.block(f[0]),values,keys.length,out);}
 int importState(Memory m,List<Object?> f,Pointer<Uint64> out){final state=f[0]! as List<Object?>;return api.citizensdk_import_state(handle,m.block(state[1]),state[0]! as int,m.view(state[2],262144),out);}
 int addAccounts(Memory m,List<Object?> f,Pointer<Uint64> out){final indices=f[2]! as List<Object?>;final p=m.alloc<Uint32>(indices.length*4);for(var i=0;i<indices.length;i++){p[i]=indices[i]! as int;}return api.citizensdk_add_wallet_accounts(handle,m.view(f[0],1024),m.view(f[1],1024),p,indices.length,out);}
 int importCode(Memory m,Projection p,List<Object?> f,Pointer<Uint64> out){final document=_codecDocument(p.text((b,cap,n)=>api.citizensdk_qr_parse(handle,m.view(f[0],2331),b,cap,n)));if(document['scan_purpose_mask'] is! int||((document['scan_purpose_mask']! as int)&1)==0)throw failure(1);return api.citizensdk_import_cold_account_id(handle,m.account(document['account_id']),m.view(f[1],120),out);}
 Map<String,Object?> _codecDocument(String text){final raw=jsonDecode(text);if(raw is! Map<String,Object?>)throw failure(16);return raw;}
 List<Object?> qr(String method,List<Object?> f,Memory m,Projection p){
  if(method=='qrValidateSignResponse'){check(api.citizensdk_qr_validate_sign_response(handle,m.view(f[0],128),m.view(f[1],2331)));return[];}
  if(method=='qrCancelSignRequest'){final cancelled=m.alloc<Uint8>(1);check(api.citizensdk_qr_cancel_sign_request(handle,m.view(f[0],128),cancelled));return[cancelled.value==1];}
  if(method=='qrEncode'){final width=m.alloc<Uint32>(4),height=m.alloc<Uint32>(4),n=m.alloc<Size>(sizeOf<Size>()),text=m.view(f[0],2331);final query=api.citizensdk_qr_image_encode_text(text.data,text.len,f[1]! as int,nullptr,0,width,height,n);if(query!=6){checkImage(query);throw failure(9);}if(n.value<=0||n.value>16777216||width.value<=0||height.value<=0||width.value*height.value!=n.value)throw failure(9);final size=n.value,w=width.value,h=height.value;final out=m.alloc<Uint8>(size);checkImage(api.citizensdk_qr_image_encode_text(text.data,text.len,f[1]! as int,out,size,width,height,n));if(n.value!=size||width.value!=w||height.value!=h)throw failure(9);return[w,h,Uint8List.fromList(out.asTypedList(size))];}
  if(method=='qrDecodeLuminance'){final pixels=m.view(f[0],16777216),n=m.alloc<Size>(sizeOf<Size>());final query=api.citizensdk_qr_image_decode_luminance(pixels.data,pixels.len,f[1]! as int,f[2]! as int,f[3]! as int,nullptr,0,n);if(query!=6){checkImage(query);throw failure(9);}if(n.value<=0||n.value>2331)throw failure(9);final size=n.value;final out=m.alloc<Uint8>(size);checkImage(api.citizensdk_qr_image_decode_luminance(pixels.data,pixels.len,f[1]! as int,f[2]! as int,f[3]! as int,out,size,n));if(n.value!=size)throw failure(9);final text=utf8.decode(out.asTypedList(size));return[p.text((b,cap,need)=>api.citizensdk_qr_parse(handle,m.view(text,2331),b,cap,need))];}
  if(method=='qrConsumeSignResponse'){final out=m.alloc<Uint8>(64);check(api.citizensdk_qr_consume_sign_response(handle,m.view(f[0],2331),out));return[Uint8List.fromList(out.asTypedList(64))];}
  final data=m.copy((b,cap,n)=>switch(method){'qrParse'=>api.citizensdk_qr_parse(handle,m.view(f[0],2331),b,cap,n),'qrEncodeAccountId'=>api.citizensdk_qr_encode_account_id(handle,m.account(f[0]),b,cap,n),'qrEncodeDocument'=>api.citizensdk_qr_encode_document(handle,m.view(f[0],65536),b,cap,n),'qrPrepareAccountAuthorization'=>api.citizensdk_qr_prepare_account_authorization(handle,f[0]! as int,m.view(f[1],1920),m.view(f[2],1024),b,cap,n),'qrCreateSignRequest'=>api.citizensdk_qr_create_sign_request(handle,f[0]! as int,m.account(f[1]),m.view(f[2],1920),f[3]! as int,b,cap,n),_=>throw failure(4)},65536);
  return[method=='qrConsumeSignResponse'?data:utf8.decode(data)];
 }
 void checkImage(int code){if(code!=0)throw failure(switch(code){1||2=>1,3=>7,4=>8,5=>16,_=>20});}
 List<Object?> project(Projection p,int r,String method,List<Object?> f){
  switch(method){
   case 'start':case 'stop':return[lifecycle()];
   case 'deleteWallet':case 'signAndDeleteWallet':return[];
   case 'prepareWalletCreation':final q=p.m.struct<c.citizensdk_prepared_wallet_info>(sizeOf<c.citizensdk_prepared_wallet_info>());check(api.citizensdk_result_get_prepared_wallet(r,q));return[retain('preparedWallet',q.ref.prepared_wallet)];
   case 'inspectWallets':final out=p.m.alloc<Uint64>(8);final value=p.wallet(r);check(api.citizensdk_wallet_state_retain(handle,r,out));return[retain('inspection',out.value),value];
   case 'reviewQrRequest':final data=p.text((out,cap,n)=>api.citizensdk_result_copy_qr(r,out,cap,n));// 审阅结果保持原生所有权直到显式释放。
    return[retain('review',retainReview(r)),data];
   case 'signQrRequest':final doc=p.text((out,cap,n)=>api.citizensdk_result_copy_qr(r,out,cap,n));final canonical=_codecDocument(doc)['canonical_text'];final image=qr('qrEncode',[canonical,4],p.m,p);return[doc,...image];
   case 'getWalletState':case 'deleteAccount':case 'renameAccount':case 'importColdAccountCode':case 'importColdAccountId':case 'importColdAccountSs58':case 'reorderWalletAccountsWithoutDefaultChange':case 'repairHotWallet':case 'renameDiagnosticWallet':case 'deleteDiagnosticWallet':case 'setActiveWallet':case 'renameWallet':return[p.wallet(r)];
   case 'importWallet':case 'addNextWalletAccount':case 'addWalletAccounts':case 'commitWalletCreation':case 'setActiveWalletAccount':case 'reconcileWalletCleanup':return[p.optionalProfile(r)];
   case 'beginSigning':case 'consumeExternalSignature':return[p.signing(r)];
   case 'beginDefaultAccountChange':case 'consumeDefaultAccountChange':return[p.defaultChange(r)];
   case 'prepareTransaction':final q=p.m.struct<c.citizensdk_prepared_transaction_info>(sizeOf<c.citizensdk_prepared_transaction_info>());check(api.citizensdk_result_get_prepared_transaction(r,q));resources[hex(q.ref.preparation_id,16)]=_Resource('transaction',q.ref.prepared_transaction);return[p.preparedTransaction(r)];
   case 'executePreparedTransaction':case 'consumePreparedTransactionQrResponse':return[p.transaction(r)];
   case 'getTransactionHistory':case 'syncTransactionHistory':return[p.history(r)];
   case 'getBestHead':case 'getFinalizedHead':case 'getFinalizedBlockAt':case 'resolveFinalizedBlock':case 'importState':final q=p.m.alloc<c.citizensdk_block_ref>(sizeOf<c.citizensdk_block_ref>());check(api.citizensdk_result_get_block_ref(r,q));return[block(q.ref)];
   case 'getSyncStatus':final q=p.m.struct<c.citizensdk_chain_sync_status_info>(sizeOf<c.citizensdk_chain_sync_status_info>());check(api.citizensdk_result_get_sync_status(r,q));return[[decimal(q.ref.peer_count),q.ref.is_syncing==1,q.ref.is_usable==1,block(q.ref.best),block(q.ref.finalized)]];
   case 'getBlockHeader':final q=p.m.struct<c.citizensdk_block_header_info>(sizeOf<c.citizensdk_block_header_info>());final digest=p.m.copy((out,cap,n)=>api.citizensdk_result_get_block_header(r,q,out,cap,n),1048576);return[[block(q.ref.block),hex(q.ref.parent_hash,32),hex(q.ref.state_root,32),hex(q.ref.extrinsics_root,32),digest]];
   case 'getBlockBody':final q=p.m.struct<c.citizensdk_block_body_info>(sizeOf<c.citizensdk_block_body_info>());check(api.citizensdk_result_get_block_body_info(r,q));if(q.ref.extrinsic_count>16384||q.ref.total_bytes>67108864)throw failure(9);return[[block(q.ref.block),List<Object?>.generate(q.ref.extrinsic_count,(i)=>p.m.copy((out,cap,n)=>api.citizensdk_result_copy_block_body_extrinsic(r,i,out,cap,n)))]];
   case 'getRuntimeContext':final q=p.m.struct<c.citizensdk_runtime_context_info>(sizeOf<c.citizensdk_runtime_context_info>());final bytes=p.m.copy((out,cap,n)=>api.citizensdk_result_get_runtime_context(r,q,out,cap,n));return[[block(q.ref.block),q.ref.spec_version,q.ref.transaction_version,bytes]];
   case 'exportState':final q=p.m.struct<c.citizensdk_exported_state_info>(sizeOf<c.citizensdk_exported_state_info>());final bytes=p.m.copy((out,cap,n)=>api.citizensdk_result_get_exported_state(r,q,out,cap,n),262144);return[[q.ref.format_version,block(q.ref.finalized),bytes]];
   case 'getStorage':case 'getSystemEvents':case 'callRuntimeApi':final present=p.m.alloc<Uint8>(1);final bytes=p.m.copy((out,cap,n)=>api.citizensdk_result_copy_storage(r,present,out,cap,n));return[present.value==1?bytes:null];
   case 'getStorageBatch':case 'getStorageKeysPaged':final count=p.m.alloc<Uint32>(4);check(api.citizensdk_result_get_storage_batch_count(r,count));if(count.value>1024)throw failure(9);return[List<Object?>.generate(count.value,(i){final present=p.m.alloc<Uint8>(1);final data=p.m.copy((out,cap,n)=>api.citizensdk_result_copy_storage_batch_item(r,i,present,out,cap,n));return present.value==1?data:null;})];
   case 'getAccountBalance':final q=p.m.struct<c.citizensdk_account_balance_info>(sizeOf<c.citizensdk_account_balance_info>());check(api.citizensdk_result_get_account_balance(r,q));return[p.balance(q.ref)];
   case 'getAccountBalances':final count=p.m.alloc<Uint32>(4);check(api.citizensdk_result_get_account_balance_count(r,count));if(count.value!=(f[0]! as List<Object?>).length)throw failure(9);return[List<Object?>.generate(count.value,(i){final q=p.m.struct<c.citizensdk_account_balance_info>(sizeOf<c.citizensdk_account_balance_info>());check(api.citizensdk_result_get_account_balance_at(r,i,q));if(hex(q.ref.account_id.bytes,32)!=(f[0]! as List<Object?>)[i])throw failure(9);return p.balance(q.ref);})];
   case 'getAccountNonce':final q=p.m.struct<c.citizensdk_account_nonce_info>(sizeOf<c.citizensdk_account_nonce_info>());check(api.citizensdk_result_get_account_nonce(r,q));return[[hex(q.ref.account_id.bytes,32),block(q.ref.best_block),decimal(q.ref.nonce)]];
   case 'getFeeSnapshot':final q=p.m.struct<c.citizensdk_fee_snapshot_info>(sizeOf<c.citizensdk_fee_snapshot_info>());check(api.citizensdk_result_get_fee_snapshot(r,q));return[[block(q.ref.best_block),q.ref.fee_rate_parts,u128(q.ref.minimum_fee_fen),u128(q.ref.existential_deposit_fen)]];
   case 'signWalletPayload':final bytes=p.m.alloc<Uint8>(64);check(api.citizensdk_result_get_signature(r,bytes));return[Uint8List.fromList(bytes.asTypedList(64))];
   default:throw failure(4);
  }
 }
 int retainReview(int result){_reviewTransferred.add(result);return result;}
 final _reviewTransferred=<int>{};
}
