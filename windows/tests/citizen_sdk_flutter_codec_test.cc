#include <cassert>
#include <string>
#include <vector>
#include "value.hpp"
namespace csf=citizen_sdk::flutter;
static csf::DecodedRequest decode(const char*name,csf::Value value){auto native=csf::to_encodable_value(value);return csf::decode_request(name,&native);}
int main(){
 const auto open=decode("open",csf::Value::list({csf::Value::integer(2),csf::Value::integer(32),csf::Value::boolean(false)}));assert(open.modules==32);
 const auto close=decode("close",csf::Value::list({csf::Value::integer(2),csf::Value::string("sdk"),csf::Value::integer(1)}));assert(close.sequence==1&&close.session=="sdk");
 const auto key=decode("openPrivateKey",csf::Value::list({csf::Value::integer(2),csf::Value::string("sdk"),csf::Value::integer(2),csf::Value::string("0x"+std::string(64,'0'))}));assert(key.method==csf::Method::open_private_key);
 for(const auto bad: {0,6,9}){bool rejected=false;try{(void)decode("openQrCapture",csf::Value::list({csf::Value::integer(2),csf::Value::string("sdk"),csf::Value::integer(3),csf::Value::integer(bad)}));}catch(const csf::ContractFailure&e){rejected=e.code==CITIZENSDK_ERROR_INVALID_ARGUMENT;}assert(rejected);}
 bool rejected=false;try{(void)decode("getWalletState",csf::Value::list({csf::Value::integer(2),csf::Value::string("sdk"),csf::Value::integer(4)}));}catch(const csf::ContractFailure&e){rejected=e.code==CITIZENSDK_ERROR_UNSUPPORTED;}assert(rejected);
 // 验证真实资源边界与非法枚举，不允许越界值变成close。
 assert(std::string(csf::method_name(csf::Method::open))=="open");
 assert(std::string(csf::method_name(csf::Method::close))=="close");
 assert(std::string(csf::method_name(csf::Method::qr_decode_image))=="qrDecodeImage");
 for(const int value: {-1,static_cast<int>(csf::Method::qr_decode_image)+1,2147483647}){
  bool invalid=false;try{(void)csf::method_name(static_cast<csf::Method>(value));}
  catch(const csf::ContractFailure&e){invalid=e.code==CITIZENSDK_ERROR_INTEGRITY;}
  assert(invalid);
 }
 for(const char *method: {"start","stop","verifySignature","encodeSigningPayload"}){
  assert(!csf::is_method_name(method));
  bool unsupported=false;try{(void)decode(method,csf::Value::list({csf::Value::integer(2),csf::Value::string("sdk"),csf::Value::integer(5)}));}
  catch(const csf::ContractFailure&e){unsupported=e.code==CITIZENSDK_ERROR_UNSUPPORTED;}
  assert(unsupported);
 }
 return 0;
}
