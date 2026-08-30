use parking_lot::Mutex;
use std::process::Child;
use std::sync::Arc;

pub type ChildSlot = Arc<Mutex<Option<Child>>>;

pub fn kill_child(child_slot: &ChildSlot) {
    if let Some(mut child) = child_slot.lock().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}
