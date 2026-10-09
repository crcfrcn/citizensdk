//! CitizenSDK sr25519 唯一实现与 legacy 原生签名 FFI。
//!
//! CitizenSDK 内单一真源：新 `ChainSigner` 与 SDK 收编的 legacy `libsmoldot` 投影
//! 物理共用这一份密码学源码。尚未切换 SDK 的 CitizenApp/CitizenWallet 继续使用
//! `shared/citizen-signer`；本 crate 通过冻结向量和双向差分保持逐字节兼容，不反向
//! 依赖另一个目录。
//!
//! 已验证实现取代过纯 Dart `sr25519`：纯 Dart 走 BigInt 软算标量乘，真机上一次
//! 「派生 + 签名」实测 **8.2 秒**，会把主线程/用户直接晾在那里；schnorrkel 是
//! Substrate 全家的官方实现，同样的活是毫秒级（实测 14~18 ms）。
//!
//! 热钱包与独立冷钱包的**存储模型不同、密码学相同**：热端「无根」只存 child
//! mini-secret；冷端是持根方，签名时现场硬派生。本 crate 只提供 SDK 密码学原语，
//! 不介入任何产品的存储决策，也不把冷钱包并入 CitizenSDK。
//! 密码学运算集中在 `sr25519` 私有模块；legacy 四个裸指针入口与
//! [`Sr25519SoftwareSigner`] 都只做边界适配，不能形成第二套算法实现。
//!
//! ## 口径必须逐字节对齐（错一处钱包就变成另一个账户）
//! - 扩展模式恒 `ExpansionMode::Ed25519`（对齐 Dart 侧 `MiniSecretKey.expandEd25519()`
//!   与 Substrate `Pair::from_seed`）；
//! - 签名上下文恒 `b"substrate"`（对齐 Dart 侧 `Sr25519.sign` 的 `newSigningContext`）；
//! - 硬派生的 junction chaincode **由 Dart 侧算好后传入**（`SecretUri` 解析属编码而非
//!   密码学、不慢，且已有金标测试守着），本模块只做慢的那部分，缩小口径漂移面。
//!
//! ## 安全
//! - 所有私钥材料（seed / child mini-secret / 展开后的 SecretKey）用 `Zeroizing`
//!   包裹，作用域结束即擦除，绝不驻留；
//! - 全部入口 `catch_unwind`：任何内部 panic 只回错误码，绝不跨 FFI 边界展开、
//!   更不会像原生 panic 那样 abort 掉整个 App；
//! - 入参长度逐一校验，空指针即拒；出参只在成功时写入。

// 本 crate 为兼容已验证调用方保留四个 legacy FFI 原语，`unsafe` 仅存在于这些裸指针
// 边界。workspace 级 `unsafe_code = "warn"` 对本文件属于噪声，在此源码级豁免；真实
// 密码学模块和 ChainSigner 适配器仍是安全 Rust。各入口契约见 `# Safety` 与判空校验。
#![allow(unsafe_code)]

use std::panic::{catch_unwind, AssertUnwindSafe};
use zeroize::Zeroizing;

mod chain_signer;
mod sr25519;

pub use chain_signer::Sr25519SoftwareSigner;

pub const CITIZEN_SIGNER_OK: i32 = 0;
pub const CITIZEN_SIGNER_ERR_NULL_ARG: i32 = -1;
pub const CITIZEN_SIGNER_ERR_BAD_KEY: i32 = -2;
pub const CITIZEN_SIGNER_ERR_BAD_SIGNATURE: i32 = -3;
pub const CITIZEN_SIGNER_ERR_VERIFY_FAILED: i32 = -4;
pub const CITIZEN_SIGNER_ERR_PANIC: i32 = -5;

/// 从 32 字节母种子按 `chain_code` 硬派生一层 child mini-secret（32 字节）。
///
/// 等价于 Dart 侧 `MiniSecretKey.fromRawKey(seed).expandEd25519()
/// .hardDeriveMiniSecretKey(const <int>[], cc)`；多层派生由调用方按 junction
/// 顺序逐层调用（每层的输入是上一层的输出），与 Dart 循环逐字节一致。
///
/// # Safety
/// `seed`/`chain_code` 须各指向 32 字节可读内存，`out_child` 指向 32 字节可写内存。
pub unsafe fn citizen_sr25519_derive_hard(
    seed: *const u8,
    chain_code: *const u8,
    out_child: *mut u8,
) -> i32 {
    if seed.is_null() || chain_code.is_null() || out_child.is_null() {
        return CITIZEN_SIGNER_ERR_NULL_ARG;
    }
    catch_unwind(AssertUnwindSafe(|| {
        let seed_bytes = Zeroizing::new(std::slice::from_raw_parts(seed, 32).to_vec());
        let mut cc = [0u8; 32];
        cc.copy_from_slice(std::slice::from_raw_parts(chain_code, 32));
        let Ok(child_bytes) = sr25519::derive_hard(&seed_bytes, &cc) else {
            return CITIZEN_SIGNER_ERR_BAD_KEY;
        };

        std::ptr::copy_nonoverlapping(child_bytes.as_ptr(), out_child, 32);
        CITIZEN_SIGNER_OK
    }))
    .unwrap_or(CITIZEN_SIGNER_ERR_PANIC)
}

/// child mini-secret（32 字节）→ 公钥（32 字节，即 AccountId32）。
///
/// 等价于 Dart 侧 `Keyring.sr25519.fromSeed(child).bytes()`。
///
/// # Safety
/// `child` 指向 32 字节可读内存，`out_public` 指向 32 字节可写内存。
pub unsafe fn citizen_sr25519_public_key(child: *const u8, out_public: *mut u8) -> i32 {
    if child.is_null() || out_public.is_null() {
        return CITIZEN_SIGNER_ERR_NULL_ARG;
    }
    catch_unwind(AssertUnwindSafe(|| {
        let child_bytes = Zeroizing::new(std::slice::from_raw_parts(child, 32).to_vec());
        let Ok(public) = sr25519::public_key(&child_bytes) else {
            return CITIZEN_SIGNER_ERR_BAD_KEY;
        };
        std::ptr::copy_nonoverlapping(public.as_ptr(), out_public, 32);
        CITIZEN_SIGNER_OK
    }))
    .unwrap_or(CITIZEN_SIGNER_ERR_PANIC)
}

/// 用 child mini-secret 对 `message` 签名，输出 64 字节签名。
///
/// 等价于 Dart 侧 `Keyring.sr25519.fromSeed(child).sign(message)`。sr25519 签名含
/// 随机数，**同一输入两次签名字节不同**（正常），只能靠验签比对，不能比字节。
///
/// # Safety
/// `child` 指向 32 字节可读内存；`message` 指向 `message_len` 字节可读内存
/// （`message_len` 为 0 时允许空指针）；`out_signature` 指向 64 字节可写内存。
pub unsafe fn citizen_sr25519_sign(
    child: *const u8,
    message: *const u8,
    message_len: usize,
    out_signature: *mut u8,
) -> i32 {
    if child.is_null() || out_signature.is_null() || (message.is_null() && message_len != 0) {
        return CITIZEN_SIGNER_ERR_NULL_ARG;
    }
    catch_unwind(AssertUnwindSafe(|| {
        let child_bytes = Zeroizing::new(std::slice::from_raw_parts(child, 32).to_vec());
        let msg = if message_len == 0 {
            &[][..]
        } else {
            std::slice::from_raw_parts(message, message_len)
        };

        let Ok(sig_bytes) = sr25519::sign(&child_bytes, msg) else {
            return CITIZEN_SIGNER_ERR_BAD_KEY;
        };
        std::ptr::copy_nonoverlapping(sig_bytes.as_ptr(), out_signature, 64);
        CITIZEN_SIGNER_OK
    }))
    .unwrap_or(CITIZEN_SIGNER_ERR_PANIC)
}

/// 验签：公钥（32B）+ 签名（64B）+ 消息。通过返回 [`CITIZEN_SIGNER_OK`]。
///
/// # Safety
/// `public`/`signature` 分别指向 32/64 字节可读内存；`message` 指向 `message_len`
/// 字节可读内存（`message_len` 为 0 时允许空指针）。
pub unsafe fn citizen_sr25519_verify(
    public: *const u8,
    signature: *const u8,
    message: *const u8,
    message_len: usize,
) -> i32 {
    if public.is_null() || signature.is_null() || (message.is_null() && message_len != 0) {
        return CITIZEN_SIGNER_ERR_NULL_ARG;
    }
    catch_unwind(AssertUnwindSafe(|| {
        let public_bytes = std::slice::from_raw_parts(public, 32);
        let sig_bytes = std::slice::from_raw_parts(signature, 64);
        let msg = if message_len == 0 {
            &[][..]
        } else {
            std::slice::from_raw_parts(message, message_len)
        };

        match sr25519::verify(public_bytes, msg, sig_bytes) {
            Ok(true) => CITIZEN_SIGNER_OK,
            Ok(false) => CITIZEN_SIGNER_ERR_VERIFY_FAILED,
            Err(sr25519::Sr25519Error::PublicKey) => CITIZEN_SIGNER_ERR_BAD_KEY,
            Err(sr25519::Sr25519Error::Signature) => CITIZEN_SIGNER_ERR_BAD_SIGNATURE,
            Err(sr25519::Sr25519Error::Secret) => CITIZEN_SIGNER_ERR_BAD_KEY,
        }
    }))
    .unwrap_or(CITIZEN_SIGNER_ERR_PANIC)
}

/// 在调用方 cdylib 中生成 4 个 `#[no_mangle] extern "C"` 导出入口。
///
/// **为什么用宏**：`#[no_mangle]` 外壳由宏在各端 cdylib 内就地生成，既保证符号
/// 一定被导出（不依赖 rlib 符号透传这类链接器行为），又让**逻辑与 FFI 外壳都是
/// 单一真源**——不给任何一端留下手抄 FFI 签名、把参数顺序写歪的机会。
///
/// 落地后用符号检查守住（注意平台差异，用错标志会误判为 0）：
/// - Android/ELF：`llvm-nm -D <lib>.so | grep -c citizen_sr25519`
/// - macOS/Mach-O：`llvm-nm -g <lib>.dylib | grep -c citizen_sr25519`
///   均应为 4。
#[macro_export]
macro_rules! export_citizen_signer_ffi {
    () => {
        /// 见 [`citizen_signer::citizen_sr25519_derive_hard`]。
        #[no_mangle]
        pub unsafe extern "C" fn citizen_sr25519_derive_hard(
            seed: *const u8,
            chain_code: *const u8,
            out_child: *mut u8,
        ) -> i32 {
            $crate::citizen_sr25519_derive_hard(seed, chain_code, out_child)
        }

        /// 见 [`citizen_signer::citizen_sr25519_public_key`]。
        #[no_mangle]
        pub unsafe extern "C" fn citizen_sr25519_public_key(
            child: *const u8,
            out_public: *mut u8,
        ) -> i32 {
            $crate::citizen_sr25519_public_key(child, out_public)
        }

        /// 见 [`citizen_signer::citizen_sr25519_sign`]。
        #[no_mangle]
        pub unsafe extern "C" fn citizen_sr25519_sign(
            child: *const u8,
            message: *const u8,
            message_len: usize,
            out_signature: *mut u8,
        ) -> i32 {
            $crate::citizen_sr25519_sign(child, message, message_len, out_signature)
        }

        /// 见 [`citizen_signer::citizen_sr25519_verify`]。
        #[no_mangle]
        pub unsafe extern "C" fn citizen_sr25519_verify(
            public: *const u8,
            signature: *const u8,
            message: *const u8,
            message_len: usize,
        ) -> i32 {
            $crate::citizen_sr25519_verify(public, signature, message, message_len)
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 派生确定性：同一 (seed, chain_code) 恒得同一 child。
    #[test]
    fn hard_derive_is_deterministic() {
        let seed = [7u8; 32];
        let cc = [3u8; 32];
        let mut a = [0u8; 32];
        let mut b = [0u8; 32];
        unsafe {
            assert_eq!(
                citizen_sr25519_derive_hard(seed.as_ptr(), cc.as_ptr(), a.as_mut_ptr()),
                CITIZEN_SIGNER_OK
            );
            assert_eq!(
                citizen_sr25519_derive_hard(seed.as_ptr(), cc.as_ptr(), b.as_mut_ptr()),
                CITIZEN_SIGNER_OK
            );
        }
        assert_eq!(a, b);
        assert_ne!(a, seed, "child 不应等于母种子");
    }

    /// 签名 → 验签闭环，且换消息/换公钥必须验不过。
    #[test]
    fn sign_then_verify_roundtrip() {
        let child = [9u8; 32];
        let msg = b"gmb-native-signer";
        let mut public = [0u8; 32];
        let mut sig = [0u8; 64];
        unsafe {
            assert_eq!(
                citizen_sr25519_public_key(child.as_ptr(), public.as_mut_ptr()),
                CITIZEN_SIGNER_OK
            );
            assert_eq!(
                citizen_sr25519_sign(child.as_ptr(), msg.as_ptr(), msg.len(), sig.as_mut_ptr()),
                CITIZEN_SIGNER_OK
            );
            assert_eq!(
                citizen_sr25519_verify(public.as_ptr(), sig.as_ptr(), msg.as_ptr(), msg.len()),
                CITIZEN_SIGNER_OK
            );
            let other = b"tampered";
            assert_eq!(
                citizen_sr25519_verify(public.as_ptr(), sig.as_ptr(), other.as_ptr(), other.len()),
                CITIZEN_SIGNER_ERR_VERIFY_FAILED
            );
        }
    }

    /// 空指针一律拒绝，绝不解引用。
    #[test]
    fn null_arguments_are_rejected() {
        let buf = [0u8; 64];
        unsafe {
            assert_eq!(
                citizen_sr25519_derive_hard(
                    std::ptr::null(),
                    buf.as_ptr(),
                    buf.as_ptr() as *mut u8
                ),
                CITIZEN_SIGNER_ERR_NULL_ARG
            );
            assert_eq!(
                citizen_sr25519_sign(std::ptr::null(), buf.as_ptr(), 1, buf.as_ptr() as *mut u8),
                CITIZEN_SIGNER_ERR_NULL_ARG
            );
            assert_eq!(
                citizen_sr25519_verify(buf.as_ptr(), std::ptr::null(), buf.as_ptr(), 1),
                CITIZEN_SIGNER_ERR_NULL_ARG
            );
        }
    }
}
