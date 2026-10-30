use std::{future::Future, task::Context};

use futures::task::noop_waker_ref;

use super::TransactionExecutionCancellation;
use crate::EngineError;

#[test]
fn cancellation_wakes_an_in_flight_provider_wait() {
    let cancellation = TransactionExecutionCancellation::default();
    let mut wait = std::pin::pin!(cancellation.provider(futures::future::pending::<()>()));
    let mut context = Context::from_waker(noop_waker_ref());
    assert!(wait.as_mut().poll(&mut context).is_pending());

    cancellation.cancel();

    assert!(matches!(
        wait.as_mut().poll(&mut context),
        std::task::Poll::Ready(Err(EngineError::Cancelled))
    ));
}
