//! The tmux-ide native client: tmux control, delivery and daemon transport.
#![doc = include_str!("../README.md")]

mod error;
mod options;
mod surface_images;
pub mod tmux_control;
pub mod tmux_controller;
pub mod tmux_daemon;
pub mod tmux_delivery;
pub mod tmux_handoff;
pub mod tmux_native_session;
pub mod tmux_receiver;
pub mod tmux_ssh;
pub mod tmux_stream;
pub mod tmux_terminal;
pub mod tmux_topology;

pub use crossbeam_channel::Receiver;
pub use herdr_protocol as protocol;

pub use error::{Error, Result};
pub use options::ConnectOptions;
pub use surface_images::{
    MAX_IMAGE_BYTES, MAX_IMAGE_SIDE, MAX_IMAGES, MAX_PLACEMENTS, SurfaceImage, SurfaceImages,
    valid_asset,
};

pub mod tmux_history;

pub mod tmux_input;

pub mod tmux_graphics;

pub mod tmux_pointer;

pub mod tmux_broker_process;
