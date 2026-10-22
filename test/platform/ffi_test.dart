import 'dart:async';
import 'dart:ffi';
import 'dart:io';
import 'dart:isolate';
import 'package:citizen_sdk/citizen_sdk.dart';
import 'package:citizen_sdk/platform/bind.dart' as c;
import 'package:citizen_sdk/platform/ffi.dart';
import 'package:citizen_sdk/platform/result.dart';
import 'package:citizen_sdk/platform/citizen_sdk_flutter_codec.dart';
import 'package:ffi/ffi.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

class _Allocator implements Allocator {
 final sizes=<int,int>{};int wiped=0;
 @override Pointer<T> allocate<T extends NativeType>(int byteCount,{int? alignment}){final p=calloc.allocate<T>(byteCount,alignment:alignment);sizes[p.address]=byteCount;return p;}
 @override void free(Pointer<NativeType> pointer){final size=sizes.remove(pointer.address)!;expect(pointer.cast<Uint8>().asTypedList(size),everyElement(0));wiped++;calloc.free(pointer);}
}
void main(){
 TestWidgetsFlutterBinding.ensureInitialized();
 final path=Platform.environment['CITIZENSDK_TEST_LIBRARY'];
 if(path==null)throw StateError('FFI test requires the product-built native fixture');
 final library=DynamicLibrary.open(path);final api=c.Bindings(library);
 final open=library.lookupFunction<Uint64 Function(Uint32),int Function(int)>('citizensdk_test_open');
 final close=library.lookupFunction<Int32 Function(Uint64),int Function(int)>('citizensdk_test_close');
 const method=MethodChannel('citizen/sdk/core/v2'),events=MethodChannel('citizen/sdk/events/v2');
 final handles=<String,int>{};final sequences=<String,int>{};int uiCalls=0;bool malformedOpen=false;
 late FfiCitizenSdkPlatform platform;StreamSubscription<Object?>? subscription;
 setUp((){uiCalls=0;malformedOpen=false;platform=FfiCitizenSdkPlatform(bindings:api);TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(events,(call)async=>null);TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(method,(call)async{
  final args=call.arguments! as List<Object?>;if(call.method=='diagnose'){expect((args[2]! as List<Object?>).length,6);return[2,args[1],0,[]];}uiCalls++;
  if(call.method=='open'){final handle=open(args[1]! as int);expect(handle,isNot(0));final id='sdk-'+handle.toString();handles[id]=handle;return[2,id,0,malformedOpen?<Object?>['created']:<Object?>['created',1,decimal(handle)]];}
  if(call.method=='close'){final id=args[1]! as String;check(api.citizensdk_accept_request_sequence(handles[id]!,args[2]! as int));var code=18;for(var i=0;i<200&&code==18;i++){code=close(handles[id]!);if(code==18)await Future<void>.delayed(const Duration(milliseconds:5));}expect(code,0);handles.remove(id);return[2,id,args[2],['disposed']];}
  throw StateError('Ordinary business reached the platform channel');
 });subscription=platform.events.listen((_){});});
 tearDown(()async{final leaked=List<String>.of(handles.keys);for(final id in leaked){await platform.invoke('close',[2,id,(sequences[id]??0)+1]);}await subscription?.cancel();expect(leaked,isEmpty);expect(handles,isEmpty);TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(method,null);TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(events,null);});
 Future<String> session(int modules)async{final raw=await platform.invoke('open',[2,modules,false]) as List<Object?>;return raw[1]! as String;}
 Future<List<Object?>> call(String id,int seq,String method,[List<Object?> args=const[]])async{sequences[id]=(sequences[id]??0)>seq?sequences[id]!:seq;final raw=await platform.invoke(method,[2,id,seq,...args]) as List<Object?>;return raw[3]! as List<Object?>;}
 test('stateless verification calls Rust without any platform request',()async{await expectLater(platform.invoke('verifySignature',[2,'0x'+('00'*32),Uint8List(64),Uint8List(0)]),throwsA(isA<CitizenSdkException>().having((e)=>e.code,'code',CitizenSdkErrorCode.invalidArgument)));final sig=Uint8List(64)..[63]=128;final value=await platform.invoke('verifySignature',[2,'0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d',sig,Uint8List(0)]);expect(value,[2,false]);expect(uiCalls,0);});
 test('QR protocol and image use the same real native implementation',()async{final id=await session(32);final account='0x'+('01'*32);final encoded=await call(id,1,'qrEncodeAccountId',[account]);final document=await call(id,2,'qrParse',[encoded[0]]);expect((const CitizenSdkFlutterCodec().decodeQrDocument(document[0])).canonicalText,encoded[0]);final image=await call(id,3,'qrEncode',[encoded[0],4]);final decoded=await call(id,4,'qrDecodeLuminance',[image[2],image[0],image[1],image[0]]);expect(const CitizenSdkFlutterCodec().decodeQrDocument(decoded[0]).canonicalText,encoded[0]);final other=await call(id,5,'qrEncodeAccountId',['0x'+('08'*32)]);final second=await call(id,6,'qrEncode',[other[0],4]);expect(second[0],image[0]);expect(second[1],image[1]);final w=image[0]! as int,h=image[1]! as int;final pair=Uint8List(w*2*h);for(var row=0;row<h;row++){pair.setRange(row*w*2,row*w*2+w,(image[2]! as Uint8List).sublist(row*w,(row+1)*w));pair.setRange(row*w*2+w,(row+1)*w*2,(second[2]! as Uint8List).sublist(row*w,(row+1)*w));}await expectLater(call(id,7,'qrDecodeLuminance',[pair,w*2,h,w*2]),throwsA(isA<CitizenSdkException>().having((e)=>e.code,'code',CitizenSdkErrorCode.conflict)));expect(uiCalls,1);await call(id,8,'close');});
 test('real wallet requests receive one owned completion and retain exact catalog results',()async{final id=await session(1);final state=await call(id,1,'getWalletState');expect(const CitizenSdkFlutterCodec().decodeWalletState(state[0]).revision,BigInt.zero);final account='0x'+('02'*32);final imported=await call(id,2,'importColdAccountId',[account,'离线']);expect(const CitizenSdkFlutterCodec().decodeWalletState(imported[0]).accounts.length,1);final inspection=await call(id,3,'inspectWallets');expect(inspection[0],isA<String>());await call(id,4,'releaseWalletInspection',[inspection[0]]);await expectLater(call(id,5,'setActiveWallet',['0',1]),throwsA(isA<CitizenSdkException>().having((e)=>e.code,'code',CitizenSdkErrorCode.conflict)));final latest=await call(id,6,'getWalletState');expect(const CitizenSdkFlutterCodec().decodeWalletState(latest[0]).accounts.length,1);expect(uiCalls,1);await call(id,7,'close');});
 test('Core scan permission controls cold account code import',()async{final id=await session(33);final encoded=await call(id,1,'qrEncodeAccountId',['0x'+('07'*32)]);final imported=await call(id,2,'importColdAccountCode',[encoded[0],'离线码']);expect(const CitizenSdkFlutterCodec().decodeWalletState(imported[0]).accounts.length,1);expect(uiCalls,1);await call(id,3,'close');});
 test('cancellation preserves the actual terminal completion',()async{final id=await session(1);final work=call(id,1,'getWalletState');final settled=work.then<void>((value){expect(const CitizenSdkFlutterCodec().decodeWalletState(value[0]).accounts,isEmpty);},onError:(Object e,StackTrace st){expect(e,isA<CitizenSdkException>().having((e)=>e.code,'code',CitizenSdkErrorCode.cancelled));});final result=await call(id,2,'cancelOperation',['1']);expect(result.single,isA<bool>());await settled;expect(await call(id,3,'cancelOperation',['1']),[false]);expect(uiCalls,1);await call(id,4,'close');});
 test('malformed bootstrap releases its actual native owner',()async{malformedOpen=true;await expectLater(platform.invoke('open',[2,32,false]),throwsA(isA<CitizenSdkException>()));expect(handles,isEmpty);expect(uiCalls,2);});
 test('rejected input spends the unique sequence and cannot select a fallback route',()async{final id=await session(32);await expectLater(call(id,1,'qrParse',[123]),throwsA(isA<CitizenSdkException>()));final value=await call(id,2,'qrEncodeAccountId',['0x'+('03'*32)]);expect(value[0],isA<String>());await expectLater(call(id,2,'getWalletState'),throwsA(isA<CitizenSdkException>().having((e)=>e.code,'code',CitizenSdkErrorCode.conflict)));await call(id,3,'close');});
 test('resources are owner scoped and close releases unclaimed result ownership',()async{final first=await session(1),second=await session(1);final inspection=await call(first,1,'inspectWallets');await expectLater(call(second,1,'releaseWalletInspection',[inspection[0]]),throwsA(isA<CitizenSdkException>().having((e)=>e.code,'code',CitizenSdkErrorCode.notFound)));await call(first,2,'close');await call(second,2,'close');});
 test('native input and output buffers are zero before every allocator release',(){final allocator=_Allocator();final m=Memory(allocator:allocator);try{final v=m.struct<c.citizensdk_wallet_input_validation_v1>(sizeOf<c.citizensdk_wallet_input_validation_v1>());check(api.citizensdk_validate_wallet_input(2,m.view('synthetic input'),12,v));expect(v.ref.reason,isNot(0));}finally{m.dispose();}expect(allocator.sizes,isEmpty);expect(allocator.wiped,greaterThan(1));});
 test('a closed native port cannot leave an unreachable owned result',()async{
  final handle=open(1);expect(handle,isNot(0));final port=ReceivePort();check(api.citizensdk_attach(handle,api.addresses.citizensdk_dart_emit,NativeApi.postCObject.cast(),port.sendPort.nativePort));port.close();
  final out=calloc<Uint64>();final job=NativeCallable<Int32 Function(Pointer<Void>)>.isolateLocal((Pointer<Void> _)=>api.citizensdk_get_wallet_state(handle,out),exceptionalReturn:20);
  try{check(api.citizensdk_invoke(handle,job.nativeFunction,nullptr));}finally{job.close();calloc.free(out);}
  var code=18;for(var i=0;i<200&&code==18;i++){code=close(handle);if(code==18)await Future<void>.delayed(const Duration(milliseconds:5));}expect(code,0);
 });
 test('queued native messages cannot keep results alive after receiver revocation',()async{
  final handle=open(1);expect(handle,isNot(0));final port=ReceivePort();final delivered=Completer<int>();port.listen((Object? message){final values=(message! as List<Object?>).cast<int>();if(values[0]==1&&!delivered.isCompleted)delivered.complete(values[3]);});
  check(api.citizensdk_attach(handle,api.addresses.citizensdk_dart_emit,NativeApi.postCObject.cast(),port.sendPort.nativePort));
  final out=calloc<Uint64>();final job=NativeCallable<Int32 Function(Pointer<Void>)>.isolateLocal((Pointer<Void> _)=>api.citizensdk_get_wallet_state(handle,out),exceptionalReturn:20);
  try{check(api.citizensdk_invoke(handle,job.nativeFunction,nullptr));}finally{job.close();calloc.free(out);}
  final result=await delivered.future.timeout(const Duration(seconds:2));expect(close(handle),18);check(api.citizensdk_detach(handle));expect(api.citizensdk_result_release(result),2);port.close();
  var code=18;for(var i=0;i<200&&code==18;i++){code=close(handle);if(code==18)await Future<void>.delayed(const Duration(milliseconds:5));}expect(code,0);
 });
 test('engine detach releases Dart inspection ownership before native destruction',()async{
  final id=await session(1);await call(id,1,'inspectWallets');check(api.citizensdk_detach(handles[id]!));await Future<void>.delayed(const Duration(milliseconds:20));var code=18;for(var i=0;i<200&&code==18;i++){code=close(handles[id]!);if(code==18)await Future<void>.delayed(const Duration(milliseconds:5));}expect(code,0);handles.remove(id);
 });

}
