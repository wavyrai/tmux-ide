#include "TmuxIde-GhosttyBridge.h"

#include <stdio.h>
#include <string.h>

static int g_loaded = 0;
static const char *g_loaded_path = "linked:GhosttyKit.xcframework";

bool tmuxide_ghostty_load(const char **error_out) {
    g_loaded = 1;
    if (error_out) *error_out = NULL;
    return true;
}

bool tmuxide_ghostty_is_loaded(void) {
    return g_loaded != 0;
}

const char *tmuxide_ghostty_loaded_path(void) {
    return g_loaded_path;
}

int tmuxide_ghostty_init(uintptr_t argc, char **argv) {
    return ghostty_init(argc, argv);
}

ghostty_config_t tmuxide_ghostty_config_new(void) {
    return ghostty_config_new();
}

void tmuxide_ghostty_config_free(ghostty_config_t config) {
    ghostty_config_free(config);
}

void tmuxide_ghostty_config_load_default_files(ghostty_config_t config) {
    ghostty_config_load_default_files(config);
}

void tmuxide_ghostty_config_load_file(ghostty_config_t config, const char *path) {
    ghostty_config_load_file(config, path);
}

void tmuxide_ghostty_config_finalize(ghostty_config_t config) {
    ghostty_config_finalize(config);
}

uint32_t tmuxide_ghostty_config_diagnostics_count(ghostty_config_t config) {
    return ghostty_config_diagnostics_count(config);
}

ghostty_diagnostic_s tmuxide_ghostty_config_get_diagnostic(ghostty_config_t config, uint32_t index) {
    return ghostty_config_get_diagnostic(config, index);
}

ghostty_app_t tmuxide_ghostty_app_new(const ghostty_runtime_config_s *runtime_config, ghostty_config_t config) {
    return ghostty_app_new(runtime_config, config);
}

void tmuxide_ghostty_app_free(ghostty_app_t app) {
    ghostty_app_free(app);
}

void tmuxide_ghostty_app_tick(ghostty_app_t app) {
    ghostty_app_tick(app);
}

void tmuxide_ghostty_app_set_focus(ghostty_app_t app, bool focused) {
    ghostty_app_set_focus(app, focused);
}

ghostty_surface_config_s tmuxide_ghostty_surface_config_new(void) {
    return ghostty_surface_config_new();
}

ghostty_surface_t tmuxide_ghostty_surface_new(ghostty_app_t app, const ghostty_surface_config_s *config) {
    return ghostty_surface_new(app, config);
}

void tmuxide_ghostty_surface_free(ghostty_surface_t surface) {
    ghostty_surface_free(surface);
}

bool tmuxide_ghostty_surface_process_exited(ghostty_surface_t surface) {
    return ghostty_surface_process_exited(surface);
}

void tmuxide_ghostty_surface_set_size(ghostty_surface_t surface, uint32_t width, uint32_t height) {
    ghostty_surface_set_size(surface, width, height);
}

void tmuxide_ghostty_surface_set_content_scale(ghostty_surface_t surface, double x_scale, double y_scale) {
    ghostty_surface_set_content_scale(surface, x_scale, y_scale);
}

void tmuxide_ghostty_surface_set_focus(ghostty_surface_t surface, bool focus) {
    ghostty_surface_set_focus(surface, focus);
}

void tmuxide_ghostty_surface_set_display_id(ghostty_surface_t surface, uint32_t display_id) {
    ghostty_surface_set_display_id(surface, display_id);
}

void tmuxide_ghostty_surface_draw(ghostty_surface_t surface) {
    ghostty_surface_draw(surface);
}

void tmuxide_ghostty_surface_refresh(ghostty_surface_t surface) {
    ghostty_surface_refresh(surface);
}

void tmuxide_ghostty_surface_text(ghostty_surface_t surface, const char *text, uintptr_t len) {
    ghostty_surface_text(surface, text, len);
}

bool tmuxide_ghostty_surface_key(ghostty_surface_t surface, ghostty_input_key_s key_event) {
    return ghostty_surface_key(surface, key_event);
}

ghostty_input_mods_e tmuxide_ghostty_surface_key_translation_mods(ghostty_surface_t surface, ghostty_input_mods_e mods) {
    return ghostty_surface_key_translation_mods(surface, mods);
}

void tmuxide_ghostty_surface_mouse_button(ghostty_surface_t surface, ghostty_input_mouse_state_e state, ghostty_input_mouse_button_e button, ghostty_input_mods_e mods) {
    ghostty_surface_mouse_button(surface, state, button, mods);
}

void tmuxide_ghostty_surface_mouse_pos(ghostty_surface_t surface, double x, double y, ghostty_input_mods_e mods) {
    ghostty_surface_mouse_pos(surface, x, y, mods);
}

void tmuxide_ghostty_surface_mouse_scroll(ghostty_surface_t surface, double x, double y, ghostty_input_scroll_mods_t mods) {
    ghostty_surface_mouse_scroll(surface, x, y, mods);
}

void tmuxide_ghostty_surface_set_occlusion(ghostty_surface_t surface, bool visible) {
    ghostty_surface_set_occlusion(surface, visible);
}

void tmuxide_ghostty_surface_complete_clipboard_request(ghostty_surface_t surface, const char *value, void *state, bool confirmed) {
    ghostty_surface_complete_clipboard_request(surface, value, state, confirmed);
}

ghostty_surface_size_s tmuxide_ghostty_surface_size(ghostty_surface_t surface) {
    return ghostty_surface_size(surface);
}

bool tmuxide_ghostty_surface_read_text(ghostty_surface_t surface, ghostty_selection_s sel, ghostty_text_s *out) {
    return ghostty_surface_read_text(surface, sel, out);
}

void tmuxide_ghostty_surface_free_text(ghostty_surface_t surface, ghostty_text_s *text) {
    ghostty_surface_free_text(surface, text);
}

bool tmuxide_ghostty_surface_binding_action(ghostty_surface_t surface, const char *action, uintptr_t len) {
    return ghostty_surface_binding_action(surface, action, len);
}
