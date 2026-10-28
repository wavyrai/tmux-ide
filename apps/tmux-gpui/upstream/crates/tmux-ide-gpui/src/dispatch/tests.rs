use super::*;

mod history;
mod picker;
mod rank;

/// An online host with `cores` cores of which `busy` are taken.
pub(super) fn host(id: &str, cores: u32, busy: f32) -> Candidate {
    Candidate {
        endpoint_id: id.into(),
        label: id.into(),
        online: true,
        load: Some(Load {
            cpu: Some(busy / cores as f32 * 100.),
            cores: Some(cores),
            load5: Some(busy),
            memory: Some(40.),
        }),
        repository: Repository::Present,
        ..Candidate::default()
    }
}

pub(super) fn current(mut candidate: Candidate) -> Candidate {
    candidate.current = true;
    candidate
}

pub(super) fn offline(id: &str) -> Candidate {
    Candidate {
        endpoint_id: id.into(),
        label: id.into(),
        ..Candidate::default()
    }
}

pub(super) fn ids(candidates: &[Candidate], order: &[usize]) -> Vec<String> {
    order
        .iter()
        .map(|&index| candidates[index].endpoint_id.clone())
        .collect()
}
