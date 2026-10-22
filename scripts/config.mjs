// 本产品配置需求的公开入口；只登记名称、类型和规则，不保存配置值。
export const manifest=Object.freeze({
  "schema": 1,
  "product_id": "citizensdk",
  "configuration": {
    "id": "citizensdk",
    "kind": "sdk",
    "title": "公民SDK配置",
    "items": []
  }
});
export function describeConfiguration(){return JSON.parse(JSON.stringify(manifest));}

// SDK是唯一公开平台；其它名称仅为包内真实宿主编译目标。
export const repository='crcfrcn/citizensdk';
export const tools=Object.freeze({node:'25.2.1',rust:'1.97.1',flutter:'3.47.2',ndk:'28.2.13676358',gradle:'9.1.0',cmake:'3.31.6'});

// C/C++宿主依赖沿用原来源版本，由工作流使用官方构建命令准备。
export const nativeSources=Object.freeze({
"sqlite":{"version": "3.53.4", "url": "https://www.sqlite.org/2026/sqlite-amalgamation-3530400.zip", "archive_root": "sqlite-amalgamation-3530400"},
"openssl":{"version": "3.5.8", "url": "https://github.com/openssl/openssl/releases/download/openssl-3.5.8/openssl-3.5.8.tar.gz", "archive_root": "openssl-3.5.8"},
"tpm2-tss":{"version": "4.2.0", "url": "https://github.com/tpm2-software/tpm2-tss/releases/download/4.2.0/tpm2-tss-4.2.0.tar.gz", "archive_root": "tpm2-tss-4.2.0"},
"zxing":{"version": "3.1.1", "url": "https://github.com/zxing-cpp/zxing-cpp/releases/download/v3.1.1/zxing-cpp-3.1.1.tar.gz", "archive_root": "zxing-cpp-3.1.1"}
});

// 本产品Workflow坐标声明。
export const workflows=Object.freeze({"sdk":"sdk.yml"});

// 只返回声明数据；派发与观察归通用调用方，版本及交付归本仓YAML。
export function describeAction({flow,platform,inputs={}}){
 const workflow=workflows[platform];
 if(flow==='release'&&workflow)return {repository:"crcfrcn/citizensdk",workflow,ref:'main',inputs};
 throw Error('本产品未声明该流程：'+flow+'·'+platform);
}
