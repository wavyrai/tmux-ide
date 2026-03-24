#ifndef TMUXIDE_GHOSTTY_BRIDGE_H
#define TMUXIDE_GHOSTTY_BRIDGE_H

#include <stdbool.h>
#include <stdint.h>
#include "ghostty.h"

#ifdef __cplusplus
extern "C" {
#endif

bool tmuxide_ghostty_load(const char **error_out);
bool tmuxide_ghostty_is_loaded(void);
const char *tmuxide_ghostty_loaded_path(void);

int tmuxide_ghostty_init(uintptr_t argc, char **argv);
ghostty_config_t tmuxide_ghostty_config_new(void);
void tmuxide_ghostty_config_free(ghostty_config_t config);
void tmuxide_ghostty_config_load_default_files(ghostty_config_t config);
void tmuxide_ghostty_config_load_file(ghostty_config_t config, const char *path);
void tmuxide_ghostty_config_finalize(ghostty_config_t config);
uint32_t tmuxide_ghostty_config_diagnostics_count(ghostty_config_t config);
ghostty_diagnostic_s tmuxide_ghostty_config_get_diagnostic(ghostty_config_t config, uint32_t index);

ghostty_app_t tmuxide_ghostty_app_new(const ghostty_runtime_config_s *runtime_config, ghostty_config_t config);
void tmuxide_ghostty_app_free(ghostty_app_t app);
void tmuxide_ghostty_app_tick(ghostty_app_t app);
void tmuxide_ghostty_app_set_focus(ghostty_app_t app, bool focused);

ghostty_surface_config_s tmuxide_ghostty_surface_config_new(void);
ghostty_surface_t tmuxide_ghostty_surface_new(ghostty_app_t app, const ghostty_surface_config_s *config);
void tmuxide_ghostty_surface_free(ghostty_surface_t surface);
bool tmuxide_ghostty_surface_process_exited(ghostty_surface_t surface);
void tmuxide_ghostty_surface_set_size(ghostty_surface_t surface, uint32_t width, uint32_t height);
void tmuxide_ghostty_surface_set_content_scale(ghostty_surface_t surface, double x_scale, double y_scale);
void tmuxide_ghostty_surface_set_focus(ghostty_surface_t surface, bool focus);
void tmuxide_ghostty_surface_set_display_id(ghostty_surface_t surface, uint32_t display_id);
void tmuxide_ghostty_surface_draw(ghostty_surface_t surface);
void tmuxide_ghostty_surface_refresh(ghostty_surface_t surface);
void tmuxide_ghostty_surface_text(ghostty_surface_t surface, const char *text, uintptr_t len);
bool tmuxide_ghostty_surface_key(ghostty_surface_t surface, ghostty_input_key_s key_event);
ghostty_input_mods_e tmuxide_ghostty_surface_key_translation_mods(ghostty_surface_t surface, ghostty_input_mods_e mods);
void tmuxide_ghostty_surface_mouse_button(ghostty_surface_t surface, ghostty_input_mouse_state_e state, ghostty_input_mouse_button_e button, ghostty_input_mods_e mods);
void tmuxide_ghostty_surface_mouse_pos(ghostty_surface_t surface, double x, double y, ghostty_input_mods_e mods);
void tmuxide_ghostty_surface_mouse_scroll(ghostty_surface_t surface, double x, double y, ghostty_input_scroll_mods_t mods);
void tmuxide_ghostty_surface_set_occlusion(ghostty_surface_t surface, bool visible);
void tmuxide_ghostty_surface_complete_clipboard_request(ghostty_surface_t surface, const char *value, void *state, bool confirmed);

ghostty_surface_size_s tmuxide_ghostty_surface_size(ghostty_surface_t surface);
bool tmuxide_ghostty_surface_read_text(ghostty_surface_t surface, ghostty_selection_s sel, ghostty_text_s *out);
void tmuxide_ghostty_surface_free_text(ghostty_surface_t surface, ghostty_text_s *text);
bool tmuxide_ghostty_surface_binding_action(ghostty_surface_t surface, const char *action, uintptr_t len);

#ifdef __cplusplus
}
#endif

#endif
