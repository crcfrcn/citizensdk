mod db;
use citizen_sdk_contracts::*;
use citizen_sdk_store::{
    secure::Format,
    vault::{Key, Object},
    SecureStore,
};
fn key() -> Key {
    Key {
        index: 0,
        generation: VaultGeneration::from_bytes([7; 16]),
    }
}
#[test]
fn generation_owner_and_permanent_retirement_are_atomic() {
    let db = db::Db::open();
    let store = SecureStore::new(db.clone());
    let key = key();
    assert!(!store.is_active(key).unwrap());
    assert!(store.ensure_generation(key, [1; 16]).unwrap());
    assert!(store.ensure_generation(key, [1; 16]).unwrap());
    assert!(!store.ensure_generation(key, [2; 16]).unwrap());
    assert!(!store.generation_owned_by(key, [2; 16]).unwrap());
    assert_eq!(store.generations().unwrap(), vec![key]);
    store.retire_generation(key, [3; 16]).unwrap();
    assert!(!store.is_active(key).unwrap());
    assert!(!store.ensure_generation(key, [1; 16]).unwrap());
    assert_eq!(store.generations().unwrap(), vec![key]);
    assert!(!SecureStore::new(db)
        .ensure_generation(key, [4; 16])
        .unwrap());
}
#[test]
fn hardware_objects_bind_to_the_exact_owner_and_survive_retirement_until_deleted() {
    for format in [Format::Tpm, Format::Cng] {
        let store = SecureStore::with_format(db::Db::open(), format);
        let key = key();
        let object = if format == Format::Tpm {
            Object {
                key_name: String::new(),
                public: vec![1; 32],
                private: vec![2; 32],
                name: vec![3; 34],
                salt: vec![4; 16],
            }
        } else {
            Object {
                key_name: "citizensdk.07070707070707070707070707070707".into(),
                public: vec![1; 281],
                private: vec![],
                name: vec![3; 34],
                salt: vec![7; 16],
            }
        };
        assert!(store.ensure_generation(key, [1; 16]).unwrap());
        assert!(store.store_object(key, [2; 16], object.clone()).is_err());
        store.store_object(key, [1; 16], object.clone()).unwrap();
        assert!(store.object_is_active(key, &object).unwrap());
        store.retire_generation(key, [3; 16]).unwrap();
        assert!(!store.object_is_active(key, &object).unwrap());
        assert_eq!(store.load_object(key).unwrap(), Some(object.clone()));
        assert!(store.store_object(key, [1; 16], object).is_err());
        store.delete_object(key).unwrap();
        assert!(store.load_object(key).unwrap().is_none());
        assert!(!store.ensure_generation(key, [1; 16]).unwrap());
    }
}

#[test]
fn uncertain_generation_and_object_commit_never_accept_a_different_object() {
    let db = db::Db::open();
    let store = SecureStore::with_format(db.clone(), Format::Tpm);
    let key = key();
    assert!(!store.is_active(key).unwrap());
    {
        let mut conn = db.0.lock().unwrap();
        conn.commit_error = true;
        conn.commit_landed = true;
    }
    assert!(store.ensure_generation(key, [1; 16]).unwrap());
    let object = Object {
        key_name: String::new(),
        public: vec![1],
        private: vec![2],
        name: vec![3; 34],
        salt: vec![4; 16],
    };
    {
        let mut conn = db.0.lock().unwrap();
        conn.commit_error = true;
        conn.commit_landed = true;
    }
    store.store_object(key, [1; 16], object.clone()).unwrap();
    let mut changed = object.clone();
    changed.public = vec![5];
    assert!(store.store_object(key, [1; 16], changed).is_err());
    assert_eq!(store.load_object(key).unwrap(), Some(object));
    {
        let mut conn = db.0.lock().unwrap();
        conn.commit_error = true;
        conn.commit_landed = true;
    }
    store.retire_generation(key, [2; 16]).unwrap();
    assert!(!store.is_active(key).unwrap());
}
#[test]
fn independent_connections_admit_one_owner_and_keep_tombstone_after_reopen() {
    use std::{
        ffi::CString,
        sync::{Arc, Barrier},
    };
    let directory = std::env::temp_dir().join(format!("citizensdk-vault-{}", std::process::id()));
    std::fs::create_dir(&directory).unwrap();
    let path = CString::new(directory.join("secure.sqlite3").to_str().unwrap()).unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let mut threads = vec![];
    for operation in [[1; 16], [2; 16]] {
        let db = db::Db::named(&path);
        let barrier = barrier.clone();
        threads.push(std::thread::spawn(move || {
            let store = SecureStore::with_format(db, Format::Tpm);
            barrier.wait();
            store.ensure_generation(key(), operation).unwrap()
        }));
    }
    let admitted = threads
        .into_iter()
        .map(|t| t.join().unwrap())
        .filter(|ok| *ok)
        .count();
    assert_eq!(admitted, 1);
    {
        let store = SecureStore::with_format(db::Db::named(&path), Format::Tpm);
        store.retire_generation(key(), [3; 16]).unwrap();
    }
    {
        let store = SecureStore::with_format(db::Db::named(&path), Format::Tpm);
        assert!(!store.ensure_generation(key(), [1; 16]).unwrap());
        assert!(!store.ensure_generation(key(), [2; 16]).unwrap());
    }
    std::fs::remove_dir_all(directory).unwrap();
}
