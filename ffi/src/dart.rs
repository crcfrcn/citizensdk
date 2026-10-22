//! 同实例按值事件接收端；异步接收者从不借用Rust栈指针。
use std::cell::Cell;
use crate::{abi::CitizenSdkHandle,error::{FfiError,FfiResult}};
// VM提供稳定全局发送函数；官方SDK头在C++边界组装Dart_CObject，Rust不复制其布局。
#[repr(C)]pub struct DartObject{_opaque:[u8;0]}
pub type Post=Option<unsafe extern "C" fn(i64,*mut DartObject)->bool>;
pub type ValueCallback=Option<unsafe extern "C" fn(Post,i64,u32,u64,u64,u64,u64)->i8>;
#[derive(Clone,Copy)]pub(crate) struct Registration{pub callback:unsafe extern "C" fn(Post,i64,u32,u64,u64,u64,u64)->i8,pub post:Post,pub port:i64}
impl Registration {pub(crate) fn post(self,event:&crate::abi::CitizenSdkEvent)->bool{(unsafe{(self.callback)(self.post,self.port,event.event_type,event.sequence,event.request_id,event.result,event.capability_revision)}) != 0}}
thread_local!{static ORIGIN:Cell<Option<CitizenSdkHandle>>=const{Cell::new(None)};}
pub(crate) fn owns(handle:CitizenSdkHandle)->bool{ORIGIN.with(|value|value.get()==Some(handle))}
pub(crate) fn scope<T>(handle:CitizenSdkHandle,body:impl FnOnce()->FfiResult<T>)->FfiResult<T>{
 ORIGIN.with(|value|{if value.get().is_some(){return Err(FfiError::invalid("nested foreign request job"));}value.set(Some(handle));struct Reset<'a>(&'a Cell<Option<CitizenSdkHandle>>);impl Drop for Reset<'_>{fn drop(&mut self){self.0.set(None);}}let _reset=Reset(value);body()})
}

#[cfg(test)]mod tests{
 use super::*;
 #[test]fn origin_is_owner_scoped_and_restored_after_errors(){assert!(!owns(1));let _=scope(1,||{assert!(owns(1));assert!(!owns(2));assert!(scope(2,||Ok(())).is_err());Err::<(),_>(FfiError::invalid("fixture"))});assert!(!owns(1));}
}
