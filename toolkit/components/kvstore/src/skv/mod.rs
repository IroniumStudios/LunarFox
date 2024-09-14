/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! # Skv: SQLite Key-Value Store
//!
//! This module implements a key-value storage interface that's
//! backed by SQLite.

use std::ptr;

use nserror::nsresult;
use xpcom::nsIID;

use crate::skv::interface::KeyValueService;

mod abort;
mod connection;
mod coordinator;
mod database;
mod interface;
mod key;
mod schema;
mod sql;
mod store;
mod value;

#[no_mangle]
pub unsafe extern "C" fn nsSQLiteKeyValueServiceConstructor(
    iid: &nsIID,
    result: *mut *mut libc::c_void,
) -> nsresult {
    *result = ptr::null_mut();

    let service = KeyValueService::new();
    service.QueryInterface(iid, result)
}
