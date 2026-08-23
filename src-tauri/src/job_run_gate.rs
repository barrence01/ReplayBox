//! Combined pause gate for edit and preview workers.

use std::sync::atomic::{AtomicBool, Ordering};

/// Combined pause gate: tray suspend or sticky user pause.
pub struct JobRunGate {
    tray_suspended: AtomicBool,
    jobs_paused: AtomicBool,
}

impl Default for JobRunGate {
    fn default() -> Self {
        Self::new()
    }
}

impl JobRunGate {
    pub fn new() -> Self {
        Self {
            tray_suspended: AtomicBool::new(false),
            jobs_paused: AtomicBool::new(false),
        }
    }

    pub fn is_paused(&self) -> bool {
        self.tray_suspended.load(Ordering::Acquire) || self.jobs_paused.load(Ordering::Acquire)
    }

    pub fn jobs_paused(&self) -> bool {
        self.jobs_paused.load(Ordering::Acquire)
    }

    pub fn set_tray_suspended(&self, value: bool) {
        self.tray_suspended.store(value, Ordering::Release);
    }

    pub fn set_jobs_paused(&self, value: bool) {
        self.jobs_paused.store(value, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn either_flag_pauses() {
        let gate = JobRunGate::new();
        assert!(!gate.is_paused());

        gate.set_tray_suspended(true);
        assert!(gate.is_paused());
        gate.set_tray_suspended(false);
        assert!(!gate.is_paused());

        gate.set_jobs_paused(true);
        assert!(gate.is_paused());
        gate.set_tray_suspended(true);
        assert!(gate.is_paused());

        gate.set_jobs_paused(false);
        assert!(gate.is_paused());
        gate.set_tray_suspended(false);
        assert!(!gate.is_paused());
    }
}
