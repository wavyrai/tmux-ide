#![allow(clippy::unwrap_used)]

use super::{
    STATUS_DOT_UNKNOWN, STATUS_WIDTH, agent_name,
    agents::{
        Indicators, agent_labels, agent_place, status_indicator, status_style, status_symbol,
    },
    layout_tests,
    render::header,
    workspace_label,
    workspaces::workspace_entries,
};
use crate::{
    config::{FontConfig, Theme},
    contrast::Contrast,
    herdr_settings::IndicatorStyle,
};
use herdr_client::protocol::{
    AgentStatus, ClientShellAgent, ClientShellSnapshot, ClientShellWorkspace,
};

mod agent_order;
mod hierarchy;
mod host_mark;
mod row_text;
mod statuses;
mod sticky_hosts;
