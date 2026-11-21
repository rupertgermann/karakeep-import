use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperationKind {
    Acquisition,
    Delivery,
    Maintenance,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationActive;

#[derive(Clone, Default)]
pub struct OperationGate {
    active: Arc<Mutex<Option<OperationKind>>>,
}

impl OperationGate {
    pub fn reserve(&self, kind: OperationKind) -> Result<OperationLease, OperationActive> {
        let mut active = self.active.lock().map_err(|_| OperationActive)?;
        if active.is_some() {
            return Err(OperationActive);
        }
        *active = Some(kind);
        Ok(OperationLease {
            gate: self.clone(),
            kind,
        })
    }

    pub fn is_active(&self) -> bool {
        self.active
            .lock()
            .map(|active| active.is_some())
            .unwrap_or(true)
    }
}

#[must_use = "keep the lease alive for the lifetime of the operation"]
pub struct OperationLease {
    gate: OperationGate,
    kind: OperationKind,
}

impl Drop for OperationLease {
    fn drop(&mut self) {
        if let Ok(mut active) = self.gate.active.lock()
            && *active == Some(self.kind)
        {
            *active = None;
        }
    }
}
