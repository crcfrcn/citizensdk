use super::*;
use std::sync::mpsc;
unsafe extern "C" fn native(context: *mut c_void, event: *const CitizenSdkEvent) {
    let sender = &*context.cast::<mpsc::Sender<(u32, u64)>>();
    sender.send(((*event).event_type, (*event).result)).unwrap();
}
unsafe extern "C" fn post(_: i64, _: *mut crate::abi::dart::DartObject) -> bool {
    true
}
unsafe extern "C" fn copied(
    _: crate::abi::dart::Post,
    port: i64,
    kind: u32,
    seq: u64,
    request: u64,
    result: u64,
    revision: u64,
) -> i8 {
    let sender = &*(port as usize as *const mpsc::Sender<i64>);
    for value in [
        kind as i64,
        seq as i64,
        request as i64,
        result as i64,
        revision as i64,
    ] {
        sender.send(value).unwrap();
    }
    1
}
#[test]
fn completions_have_one_owner_and_state_notifications_have_no_borrowed_pointer() {
    let d = EventDispatcher::new().unwrap();
    let (tx, rx) = mpsc::channel::<(u32, u64)>();
    let (vtx, vrx) = mpsc::channel::<i64>();
    d.set_callback(
        Some(native),
        (&tx as *const mpsc::Sender<(u32, u64)>).cast_mut().cast(),
    )
    .unwrap();
    d.attach_value(
        Some(copied),
        Some(post),
        &vtx as *const mpsc::Sender<i64> as usize as i64,
    )
    .unwrap();
    assert!(d.attach_value(Some(copied), Some(post), 1).is_err());
    d.send_reserved_completion(d.reserve_completion().unwrap().foreign(), 1, 101)
        .unwrap();
    assert_eq!(
        (0..5)
            .map(|_| vrx.recv_timeout(std::time::Duration::from_secs(2)).unwrap())
            .collect::<Vec<_>>(),
        vec![1, 1, 1, 101, 0]
    );
    assert!(rx.try_recv().is_err());
    d.send_reserved_completion(d.reserve_completion().unwrap(), 2, 102)
        .unwrap();
    assert_eq!(
        rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap(),
        (1, 102)
    );
    assert!(vrx.try_recv().is_err());
    d.send(CitizenSdkEventType::WalletChanged, 0, 0, 0).unwrap();
    assert_eq!(
        (0..5)
            .map(|_| vrx.recv_timeout(std::time::Duration::from_secs(2)).unwrap())
            .collect::<Vec<_>>(),
        vec![7, 3, 0, 0, 0]
    );
    assert_eq!(
        rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap(),
        (7, 0)
    );
    d.shutdown().unwrap();
}
