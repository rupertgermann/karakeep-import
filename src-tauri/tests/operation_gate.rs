#[path = "../src/operation_gate.rs"]
mod operation_gate;

use operation_gate::{OperationGate, OperationKind};

#[test]
fn one_shared_operation_slot_covers_acquisition_and_delivery() {
    let gate = OperationGate::default();
    let acquisition = gate
        .reserve(OperationKind::Acquisition)
        .expect("first operation reserves the slot");

    assert!(gate.is_active());
    assert!(gate.reserve(OperationKind::Delivery).is_err());
    assert!(gate.reserve(OperationKind::Acquisition).is_err());

    drop(acquisition);
    let delivery = gate
        .reserve(OperationKind::Delivery)
        .expect("dropping the first lease releases the slot");
    assert!(gate.is_active());

    drop(delivery);
    assert!(!gate.is_active());
}

#[test]
fn dropping_an_old_lease_cannot_release_a_newer_operation() {
    let gate = OperationGate::default();
    let first = gate
        .reserve(OperationKind::Delivery)
        .expect("first operation reserves");
    drop(first);
    let second = gate
        .reserve(OperationKind::Acquisition)
        .expect("second operation reserves");

    assert!(gate.reserve(OperationKind::Delivery).is_err());
    assert!(gate.is_active());

    drop(second);
    assert!(!gate.is_active());
}

#[test]
fn destructive_maintenance_reserves_the_same_slot_as_transfer_work() {
    let gate = OperationGate::default();
    let maintenance = gate
        .reserve(OperationKind::Maintenance)
        .expect("maintenance reserves the shared slot atomically");

    assert!(gate.reserve(OperationKind::Acquisition).is_err());
    assert!(gate.reserve(OperationKind::Delivery).is_err());

    drop(maintenance);
    let delivery = gate
        .reserve(OperationKind::Delivery)
        .expect("maintenance releases the slot when mutation is finished");
    assert!(gate.reserve(OperationKind::Maintenance).is_err());
    drop(delivery);
}
