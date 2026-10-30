#include <cassert>
#include "value.hpp"
namespace csf=citizen_sdk::flutter;
static csf::DecodedRequest decode(const char*name,csf::Value value){auto native=csf::to_encodable_value(value);return csf::decode_request(name,&native);}
int main(){
 for(auto value:{csf::Value::integer(1),csf::Value::bytes(std::vector<uint8_t>(32,7)),csf::Value::list({})}){
 bool rejected=false;try{(void)decode("revealPrivateKey",csf::Value::list({csf::Value::integer(2),csf::Value::string("sdk"),csf::Value::integer(1),std::move(value)}));}catch(const csf::ContractFailure&e){rejected=e.code==CITIZENSDK_ERROR_INVALID_ARGUMENT;}assert(rejected);}
 auto value=csf::Value::sensitive_bytes({1,2,3});value.clear_sensitive();assert(std::get<csf::Value::Bytes>(value.data)==csf::Value::Bytes(3,0));
 const auto error=csf::error_details(CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED,"Cancelled","sdk",1,"openPrivateKey");const auto& fields=std::get<csf::Value::List>(error.data);assert(fields.size()==7&&std::get<int64_t>(fields[3].data)==10&&std::get<int64_t>(fields[4].data)==3);
 return 0;
}
