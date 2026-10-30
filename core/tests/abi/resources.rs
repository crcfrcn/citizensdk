#![allow(unsafe_code)]

#[path = "../store/db.rs"]
mod db;

// 黑盒测试只提供真实SQLite机械资源，不注入链、钱包或历史业务实现。
pub struct Resources {
    _public: Option<Box<db::Resource>>,
    public_config: Option<crate::abi::CitizenSdkStoreV1>,
}
impl Resources {
    pub fn new(modules: u32) -> Self {
        let public =
            (modules & crate::types::Modules::CHAIN != 0).then(|| Box::new(db::Resource::new()));
        let public_config = public.as_ref().map(|value| value.config());
        Self {
            _public: public,
            public_config,
        }
    }
    pub fn config(&self) -> crate::abi::CitizenSdkStoresV1 {
        crate::abi::CitizenSdkStoresV1 {
            struct_size: std::mem::size_of::<crate::abi::CitizenSdkStoresV1>() as u32,
            abi_version: crate::abi::CITIZENSDK_ABI_VERSION,
            public: self
                .public_config
                .as_ref()
                .map_or(std::ptr::null(), std::ptr::from_ref),
            secure: std::ptr::null(),
            vault: std::ptr::null(),
        }
    }
}
