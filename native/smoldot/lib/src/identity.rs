// Smoldot
// Copyright (C) 2019-2022  Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later WITH Classpath-exception-2.0

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

//! CitizenSDK keeps only Substrate SS58 public-account address encoding and decoding in this
//! module. Private-key secret strings, BIP-39 parsing, derivation paths and keystore support are
//! deliberately excluded; wallet secrets are created and signed through the SDK sr25519 wallet
//! layer and device hardware vault instead of a second smoldot identity entry point.
//!
//! ## Public keys (SS58)
//!
//! Examples:
//!
//! - `5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY`
//! - `12bzRJfh7arnnfPPUZHeJUaE62QLEwhK48QnH9LXeK2m1iZU`
//!
//! The format for public keys consists in:
//!
//! > `base58(concat(prefix, 32-bytes-public-key, checksum))`
//!
//! The prefix, also known as network identifier, also known as an address type is one or more
//! bytes identifying which blockchain network the address corresponds to. This is used for
//! UX-related purposes in order to prevent end users from using an address on a different
//! blockchain than the one the address was generated for.
//!
//! A registry of existing network identifiers can be found
//! [here](https://wiki.polkadot.network/docs/build-ss58-registry).
//!
//! The checksum is verified when the human-readable format is turned into a public key. Its
//! presence guarantees that simple copying mistakes will be caught.
//!

pub mod ss58;
