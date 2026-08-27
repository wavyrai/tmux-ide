#include <node_api.h>
#include <ghostty/vt.h>

#include <stdbool.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum {
  MAX_COLS = 512,
  MAX_ROWS = 256,
  MAX_SCROLLBACK = 5000,
  MAX_WRITE_BYTES = 16 * 1024 * 1024,
};

typedef struct ProofTerminal ProofTerminal;

typedef struct {
  uint32_t live_handles;
  ProofTerminal *terminals;
  bool cleaning_up;
  bool cleanup_hook_registered;
  bool cleanup_hook_ran;
  bool instance_finalizer_ran;
  uint32_t test_failure;
} EnvState;

enum {
  TEST_FAILURE_NONE = 0,
  TEST_FAILURE_ALLOCATION = 1,
  TEST_FAILURE_WRAP = 2,
  TEST_FAILURE_DIRTY_ACK = 3,
  TEST_FAILURE_WRITE = 4,
};

struct ProofTerminal {
  GhosttyTerminal terminal;
  GhosttyRenderState render;
  GhosttyRenderStateRowIterator rows;
  GhosttyRenderStateRowCells cells;
  EnvState *owner;
  ProofTerminal *owner_previous;
  ProofTerminal *owner_next;
  uint64_t history_generation;
  uint64_t history_appended;
  uint64_t history_trimmed;
  uint16_t projected_cols;
  uint16_t projected_rows;
  uint32_t scrollback_cap;
  size_t projected_history_count;
  GhosttyTerminalScreen projected_screen;
  bool seeded;
  bool counted;
  bool disposed;
};

static bool ok(napi_env env, napi_status status, const char *message) {
  if (status == napi_ok) return true;
  napi_throw_error(env, NULL, message);
  return false;
}

static napi_value undefined_value(napi_env env) {
  napi_value value;
  return ok(env, napi_get_undefined(env, &value), "could not create undefined") ? value : NULL;
}

static napi_value boolean_value(napi_env env, bool input) {
  napi_value value;
  return ok(env, napi_get_boolean(env, input, &value), "could not create boolean") ? value : NULL;
}

static napi_value uint32_value(napi_env env, uint32_t input) {
  napi_value value;
  return ok(env, napi_create_uint32(env, input, &value), "could not create integer") ? value : NULL;
}

static napi_value uint64_value(napi_env env, uint64_t input) {
  napi_value value;
  return ok(env, napi_create_double(env, (double)input, &value), "could not create number") ? value : NULL;
}

static napi_value string_value(napi_env env, const char *input) {
  napi_value value;
  return ok(env, napi_create_string_utf8(env, input, NAPI_AUTO_LENGTH, &value), "could not create string")
    ? value
    : NULL;
}

static bool set_named(napi_env env, napi_value target, const char *name, napi_value value) {
  return value != NULL && ok(env, napi_set_named_property(env, target, name, value), "could not set property");
}

static napi_value object_value(napi_env env) {
  napi_value value;
  return ok(env, napi_create_object(env, &value), "could not create object") ? value : NULL;
}

static napi_value array_value(napi_env env, size_t length) {
  napi_value value;
  return ok(env, napi_create_array_with_length(env, length, &value), "could not create array") ? value : NULL;
}

static void unlink_terminal(ProofTerminal *self) {
  EnvState *owner = self->owner;
  if (owner == NULL) return;
  if (self->owner_previous != NULL) self->owner_previous->owner_next = self->owner_next;
  else owner->terminals = self->owner_next;
  if (self->owner_next != NULL) self->owner_next->owner_previous = self->owner_previous;
  if (self->counted && owner->live_handles > 0) owner->live_handles -= 1;
  self->owner = NULL;
  self->owner_previous = NULL;
  self->owner_next = NULL;
  self->counted = false;
}

static void link_terminal(EnvState *owner, ProofTerminal *self) {
  self->owner = owner;
  self->owner_next = owner->terminals;
  if (owner->terminals != NULL) owner->terminals->owner_previous = self;
  owner->terminals = self;
  owner->live_handles += 1;
  self->counted = true;
}

static void dispose_terminal(ProofTerminal *self) {
  if (self == NULL || self->disposed) return;
  self->disposed = true;
  ghostty_render_state_row_cells_free(self->cells);
  self->cells = NULL;
  ghostty_render_state_row_iterator_free(self->rows);
  self->rows = NULL;
  ghostty_render_state_free(self->render);
  self->render = NULL;
  ghostty_terminal_free(self->terminal);
  self->terminal = NULL;
  unlink_terminal(self);
}

static void finalize_terminal(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  ProofTerminal *self = data;
  dispose_terminal(self);
  free(self);
}

static EnvState *env_state(napi_env env) {
  EnvState *state = NULL;
  if (!ok(env, napi_get_instance_data(env, (void **)&state), "native environment is unavailable")) return NULL;
  if (state == NULL) napi_throw_error(env, NULL, "native environment is unavailable");
  return state;
}

static ProofTerminal *unwrap_terminal(napi_env env, napi_callback_info info, size_t *argc, napi_value *args) {
  napi_value this_arg;
  void *data = NULL;
  if (!ok(env, napi_get_cb_info(env, info, argc, args, &this_arg, NULL), "could not read arguments")) return NULL;
  if (!ok(env, napi_unwrap(env, this_arg, &data), "invalid terminal receiver")) return NULL;
  ProofTerminal *self = data;
  if (self == NULL || self->disposed) {
    napi_throw_error(env, NULL, "terminal is disposed");
    return NULL;
  }
  return self;
}

static bool strict_uint32(napi_env env, napi_value value, uint32_t max, uint32_t *output, const char *message) {
  if (value == NULL) {
    napi_throw_type_error(env, NULL, message);
    return false;
  }
  napi_valuetype type;
  double number = 0;
  if (!ok(env, napi_typeof(env, value, &type), "could not inspect number")) return false;
  if (type != napi_number) {
    napi_throw_type_error(env, NULL, message);
    return false;
  }
  if (!ok(env, napi_get_value_double(env, value, &number), "could not read number")) return false;
  if (!isfinite(number) || floor(number) != number || number < 0 || number > 9007199254740991.0 || number > max) {
    napi_throw_range_error(env, NULL, message);
    return false;
  }
  *output = (uint32_t)number;
  return true;
}

static napi_value color_value(napi_env env, GhosttyStyleColor color) {
  napi_value result = object_value(env);
  if (result == NULL) return NULL;
  switch (color.tag) {
    case GHOSTTY_STYLE_COLOR_PALETTE:
      if (!set_named(env, result, "kind", string_value(env, "indexed")) ||
          !set_named(env, result, "index", uint32_value(env, color.value.palette))) return NULL;
      break;
    case GHOSTTY_STYLE_COLOR_RGB: {
      uint32_t rgb = ((uint32_t)color.value.rgb.r << 16) |
                     ((uint32_t)color.value.rgb.g << 8) |
                     (uint32_t)color.value.rgb.b;
      if (!set_named(env, result, "kind", string_value(env, "rgb")) ||
          !set_named(env, result, "value", uint32_value(env, rgb))) return NULL;
      break;
    }
    default:
      if (!set_named(env, result, "kind", string_value(env, "default"))) return NULL;
      break;
  }
  return result;
}

static GhosttyStyleColor cell_background_color(GhosttyCell cell, GhosttyStyle style) {
  GhosttyCellContentTag tag = GHOSTTY_CELL_CONTENT_CODEPOINT;
  if (ghostty_cell_get(cell, GHOSTTY_CELL_DATA_CONTENT_TAG, &tag) != GHOSTTY_SUCCESS) return style.bg_color;
  GhosttyStyleColor result = style.bg_color;
  if (tag == GHOSTTY_CELL_CONTENT_BG_COLOR_PALETTE) {
    GhosttyColorPaletteIndex index = 0;
    if (ghostty_cell_get(cell, GHOSTTY_CELL_DATA_COLOR_PALETTE, &index) == GHOSTTY_SUCCESS) {
      result.tag = GHOSTTY_STYLE_COLOR_PALETTE;
      result.value.palette = index;
    }
  } else if (tag == GHOSTTY_CELL_CONTENT_BG_COLOR_RGB) {
    GhosttyColorRgb rgb = {0};
    if (ghostty_cell_get(cell, GHOSTTY_CELL_DATA_COLOR_RGB, &rgb) == GHOSTTY_SUCCESS) {
      result.tag = GHOSTTY_STYLE_COLOR_RGB;
      result.value.rgb = rgb;
    }
  }
  return result;
}

static uint32_t style_attributes(GhosttyStyle style) {
  return (style.bold ? 1u : 0u) |
         (style.faint ? 2u : 0u) |
         (style.italic ? 4u : 0u) |
         (style.underline != GHOSTTY_SGR_UNDERLINE_NONE ? 8u : 0u) |
         (style.blink ? 16u : 0u) |
         (style.inverse ? 32u : 0u) |
         (style.invisible ? 64u : 0u) |
         (style.strikethrough ? 128u : 0u);
}

static napi_value grapheme_value(napi_env env, const uint32_t *codepoints, size_t length) {
  if (length == 0) return string_value(env, "");
  size_t units_length = 0;
  for (size_t i = 0; i < length; i += 1) units_length += codepoints[i] > 0xffff ? 2 : 1;
  char16_t *units = calloc(units_length, sizeof(char16_t));
  if (units == NULL) {
    napi_throw_error(env, NULL, "out of memory creating grapheme");
    return NULL;
  }
  size_t at = 0;
  for (size_t i = 0; i < length; i += 1) {
    uint32_t point = codepoints[i];
    if (point <= 0xffff) units[at++] = (char16_t)point;
    else {
      point -= 0x10000;
      units[at++] = (char16_t)(0xd800u + (point >> 10));
      units[at++] = (char16_t)(0xdc00u + (point & 0x3ffu));
    }
  }
  napi_value value;
  napi_status status = napi_create_string_utf16(env, units, units_length, &value);
  free(units);
  return ok(env, status, "could not create grapheme string") ? value : NULL;
}

static napi_value hyperlink_value(napi_env env, const GhosttyGridRef *ref) {
  size_t length = 0;
  GhosttyResult result = ghostty_grid_ref_hyperlink_uri(ref, NULL, 0, &length);
  if (result == GHOSTTY_SUCCESS && length == 0) {
    napi_value value;
    return ok(env, napi_get_null(env, &value), "could not create null") ? value : NULL;
  }
  if (result != GHOSTTY_OUT_OF_SPACE || length == 0) {
    napi_throw_error(env, NULL, "could not query hyperlink");
    return NULL;
  }
  uint8_t *bytes = malloc(length);
  if (bytes == NULL) {
    napi_throw_error(env, NULL, "out of memory reading hyperlink");
    return NULL;
  }
  result = ghostty_grid_ref_hyperlink_uri(ref, bytes, length, &length);
  napi_value value = NULL;
  if (result == GHOSTTY_SUCCESS)
    ok(env, napi_create_string_utf8(env, (const char *)bytes, length, &value), "could not create hyperlink");
  else napi_throw_error(env, NULL, "could not read hyperlink");
  free(bytes);
  return value;
}

static napi_value make_cell(
  napi_env env,
  GhosttyCell cell,
  GhosttyStyle style,
  const uint32_t *graphemes,
  size_t graphemes_length,
  napi_value hyperlink
) {
  GhosttyCellWide wide = GHOSTTY_CELL_WIDE_NARROW;
  if (ghostty_cell_get(cell, GHOSTTY_CELL_DATA_WIDE, &wide) != GHOSTTY_SUCCESS) {
    napi_throw_error(env, NULL, "could not read cell width");
    return NULL;
  }
  uint32_t width = wide == GHOSTTY_CELL_WIDE_WIDE
    ? 2u
    : (wide == GHOSTTY_CELL_WIDE_SPACER_TAIL || wide == GHOSTTY_CELL_WIDE_SPACER_HEAD ? 0u : 1u);
  napi_value result = object_value(env);
  napi_value grapheme = graphemes_length == 0 && width == 1
    ? string_value(env, " ")
    : grapheme_value(env, graphemes, graphemes_length);
  if (result == NULL ||
      !set_named(env, result, "grapheme", grapheme) ||
      !set_named(env, result, "width", uint32_value(env, width)) ||
      !set_named(env, result, "foreground", color_value(env, style.fg_color)) ||
      !set_named(env, result, "background", color_value(env, cell_background_color(cell, style))) ||
      !set_named(env, result, "underlineColor", color_value(env, style.underline_color)) ||
      !set_named(env, result, "attributes", uint32_value(env, style_attributes(style))) ||
      !set_named(env, result, "underlineStyle", uint32_value(env, (uint32_t)style.underline)) ||
      !set_named(env, result, "overline", boolean_value(env, style.overline)) ||
      !set_named(env, result, "hyperlink", hyperlink)) return NULL;
  return result;
}

static napi_value viewport_cell(napi_env env, ProofTerminal *self, uint16_t x, uint16_t y) {
  GhosttyCell cell = 0;
  GhosttyStyle style = GHOSTTY_INIT_SIZED(GhosttyStyle);
  uint32_t graphemes_length = 0;
  if (ghostty_render_state_row_cells_get(self->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW, &cell) != GHOSTTY_SUCCESS ||
      ghostty_render_state_row_cells_get(self->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &style) != GHOSTTY_SUCCESS ||
      ghostty_render_state_row_cells_get(self->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN, &graphemes_length) != GHOSTTY_SUCCESS) {
    napi_throw_error(env, NULL, "could not read viewport cell");
    return NULL;
  }
  uint32_t *graphemes = graphemes_length == 0 ? NULL : calloc(graphemes_length, sizeof(uint32_t));
  if (graphemes_length > 0 && graphemes == NULL) {
    napi_throw_error(env, NULL, "out of memory reading viewport cell");
    return NULL;
  }
  if (graphemes_length > 0 &&
      ghostty_render_state_row_cells_get(self->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF, graphemes) != GHOSTTY_SUCCESS) {
    free(graphemes);
    napi_throw_error(env, NULL, "could not read viewport grapheme");
    return NULL;
  }
  GhosttyPoint point = {0};
  point.tag = GHOSTTY_POINT_TAG_VIEWPORT;
  point.value.coordinate.x = x;
  point.value.coordinate.y = y;
  GhosttyGridRef ref = GHOSTTY_INIT_SIZED(GhosttyGridRef);
  napi_value link;
  if (ghostty_terminal_grid_ref(self->terminal, point, &ref) == GHOSTTY_SUCCESS) link = hyperlink_value(env, &ref);
  else if (!ok(env, napi_get_null(env, &link), "could not create absent hyperlink")) link = NULL;
  napi_value result = link == NULL ? NULL : make_cell(env, cell, style, graphemes, graphemes_length, link);
  free(graphemes);
  return result;
}

static napi_value history_cell(napi_env env, ProofTerminal *self, uint32_t y, uint16_t x) {
  GhosttyPoint point = {0};
  point.tag = GHOSTTY_POINT_TAG_HISTORY;
  point.value.coordinate.x = x;
  point.value.coordinate.y = y;
  GhosttyGridRef ref = GHOSTTY_INIT_SIZED(GhosttyGridRef);
  if (ghostty_terminal_grid_ref(self->terminal, point, &ref) != GHOSTTY_SUCCESS) {
    napi_throw_error(env, NULL, "could not resolve history cell");
    return NULL;
  }
  GhosttyCell cell = 0;
  GhosttyStyle style = GHOSTTY_INIT_SIZED(GhosttyStyle);
  if (ghostty_grid_ref_cell(&ref, &cell) != GHOSTTY_SUCCESS ||
      ghostty_grid_ref_style(&ref, &style) != GHOSTTY_SUCCESS) {
    napi_throw_error(env, NULL, "could not read history cell");
    return NULL;
  }
  size_t graphemes_length = 0;
  GhosttyResult grapheme_result = ghostty_grid_ref_graphemes(&ref, NULL, 0, &graphemes_length);
  uint32_t *graphemes = NULL;
  if (grapheme_result == GHOSTTY_OUT_OF_SPACE && graphemes_length > 0) {
    graphemes = calloc(graphemes_length, sizeof(uint32_t));
    if (graphemes == NULL ||
        ghostty_grid_ref_graphemes(&ref, graphemes, graphemes_length, &graphemes_length) != GHOSTTY_SUCCESS) {
      free(graphemes);
      napi_throw_error(env, NULL, "could not read history grapheme");
      return NULL;
    }
  } else if (grapheme_result != GHOSTTY_SUCCESS) {
    napi_throw_error(env, NULL, "could not query history grapheme");
    return NULL;
  }
  napi_value link = hyperlink_value(env, &ref);
  napi_value result = link == NULL ? NULL : make_cell(env, cell, style, graphemes, graphemes_length, link);
  free(graphemes);
  return result;
}

static napi_value make_viewport_rows(napi_env env, ProofTerminal *self, bool only_dirty, uint32_t *rows_read) {
  uint16_t rows_count = 0;
  uint16_t cols = 0;
  if (ghostty_render_state_get(self->render, GHOSTTY_RENDER_STATE_DATA_ROWS, &rows_count) != GHOSTTY_SUCCESS ||
      ghostty_render_state_get(self->render, GHOSTTY_RENDER_STATE_DATA_COLS, &cols) != GHOSTTY_SUCCESS) {
    napi_throw_error(env, NULL, "could not read render dimensions");
    return NULL;
  }
  napi_value rows = array_value(env, only_dirty ? 0 : rows_count);
  if (rows == NULL ||
      ghostty_render_state_get(self->render, GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, &self->rows) != GHOSTTY_SUCCESS) {
    napi_throw_error(env, NULL, "could not initialize render row iterator");
    return NULL;
  }
  uint32_t y = 0;
  uint32_t output_at = 0;
  while (ghostty_render_state_row_iterator_next(self->rows)) {
    bool dirty = false;
    GhosttyRow raw = 0;
    if (ghostty_render_state_row_get(self->rows, GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY, &dirty) != GHOSTTY_SUCCESS ||
        ghostty_render_state_row_get(self->rows, GHOSTTY_RENDER_STATE_ROW_DATA_RAW, &raw) != GHOSTTY_SUCCESS) {
      napi_throw_error(env, NULL, "could not read render row");
      return NULL;
    }
    if (only_dirty && !dirty) {
      y += 1;
      continue;
    }
    *rows_read += 1;
    bool continuation = false;
    if (ghostty_row_get(raw, GHOSTTY_ROW_DATA_WRAP_CONTINUATION, &continuation) != GHOSTTY_SUCCESS) {
      napi_throw_error(env, NULL, "could not read row continuation");
      return NULL;
    }
    napi_value row = object_value(env);
    napi_value cells = array_value(env, cols);
    if (row == NULL || cells == NULL ||
        ghostty_render_state_row_get(self->rows, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, &self->cells) != GHOSTTY_SUCCESS) {
      napi_throw_error(env, NULL, "could not initialize render cell iterator");
      return NULL;
    }
    uint32_t x = 0;
    while (ghostty_render_state_row_cells_next(self->cells)) {
      napi_value cell = viewport_cell(env, self, (uint16_t)x, (uint16_t)y);
      if (cell == NULL || !ok(env, napi_set_element(env, cells, x++, cell), "could not append viewport cell")) return NULL;
    }
    if (!set_named(env, row, "index", uint32_value(env, y)) ||
        !set_named(env, row, "wrapped", boolean_value(env, continuation)) ||
        !set_named(env, row, "cells", cells) ||
        !ok(env, napi_set_element(env, rows, only_dirty ? output_at++ : y, row), "could not append viewport row")) return NULL;
    y += 1;
  }
  return rows;
}

static napi_value make_history_rows(napi_env env, ProofTerminal *self, size_t start, size_t count, uint16_t cols) {
  napi_value rows = array_value(env, count);
  if (rows == NULL) return NULL;
  for (uint32_t output_y = 0; output_y < count; output_y += 1) {
    uint32_t y = (uint32_t)(start + output_y);
    GhosttyPoint point = {0};
    point.tag = GHOSTTY_POINT_TAG_HISTORY;
    point.value.coordinate.x = 0;
    point.value.coordinate.y = y;
    GhosttyGridRef ref = GHOSTTY_INIT_SIZED(GhosttyGridRef);
    GhosttyRow raw = 0;
    if (ghostty_terminal_grid_ref(self->terminal, point, &ref) != GHOSTTY_SUCCESS ||
        ghostty_grid_ref_row(&ref, &raw) != GHOSTTY_SUCCESS) {
      napi_throw_error(env, NULL, "could not read history row");
      return NULL;
    }
    bool continuation = false;
    if (ghostty_row_get(raw, GHOSTTY_ROW_DATA_WRAP_CONTINUATION, &continuation) != GHOSTTY_SUCCESS) {
      napi_throw_error(env, NULL, "could not read history continuation");
      return NULL;
    }
    napi_value row = object_value(env);
    napi_value cells = array_value(env, cols);
    if (row == NULL || cells == NULL) return NULL;
    for (uint16_t x = 0; x < cols; x += 1) {
      napi_value cell = history_cell(env, self, y, x);
      if (cell == NULL || !ok(env, napi_set_element(env, cells, x, cell), "could not append history cell")) return NULL;
    }
    if (!set_named(env, row, "wrapped", boolean_value(env, continuation)) ||
        !set_named(env, row, "cells", cells) ||
        !ok(env, napi_set_element(env, rows, output_y, row), "could not append history row")) return NULL;
  }
  return rows;
}

static bool clear_render_dirty(ProofTerminal *self) {
  return ghostty_render_state_dirty_clear(self->render) == GHOSTTY_SUCCESS;
}

static bool mode_value(napi_env env, ProofTerminal *self, GhosttyMode mode, bool *value) {
  if (ghostty_terminal_mode_get(self->terminal, mode, value) == GHOSTTY_SUCCESS) return true;
  napi_throw_error(env, NULL, "could not read terminal mode");
  return false;
}

static napi_value make_modes(napi_env env, ProofTerminal *self, GhosttyTerminalScreen screen) {
  bool mouse = false, application_cursor = false, application_keypad = false, bracketed_paste = false;
  bool insert = false, origin = false, wraparound = false, synchronized_output = false;
  if (ghostty_terminal_get(self->terminal, GHOSTTY_TERMINAL_DATA_MOUSE_TRACKING, &mouse) != GHOSTTY_SUCCESS ||
      !mode_value(env, self, GHOSTTY_MODE_DECCKM, &application_cursor) ||
      !mode_value(env, self, GHOSTTY_MODE_KEYPAD_KEYS, &application_keypad) ||
      !mode_value(env, self, GHOSTTY_MODE_BRACKETED_PASTE, &bracketed_paste) ||
      !mode_value(env, self, GHOSTTY_MODE_INSERT, &insert) ||
      !mode_value(env, self, GHOSTTY_MODE_ORIGIN, &origin) ||
      !mode_value(env, self, GHOSTTY_MODE_WRAPAROUND, &wraparound) ||
      !mode_value(env, self, GHOSTTY_MODE_SYNC_OUTPUT, &synchronized_output)) return NULL;
  napi_value result = object_value(env);
  if (result == NULL ||
      !set_named(env, result, "alternateScreen", boolean_value(env, screen == GHOSTTY_TERMINAL_SCREEN_ALTERNATE)) ||
      !set_named(env, result, "applicationCursor", boolean_value(env, application_cursor)) ||
      !set_named(env, result, "applicationKeypad", boolean_value(env, application_keypad)) ||
      !set_named(env, result, "bracketedPaste", boolean_value(env, bracketed_paste)) ||
      !set_named(env, result, "insert", boolean_value(env, insert)) ||
      !set_named(env, result, "origin", boolean_value(env, origin)) ||
      !set_named(env, result, "wraparound", boolean_value(env, wraparound)) ||
      !set_named(env, result, "mouseTracking", boolean_value(env, mouse)) ||
      !set_named(env, result, "synchronizedOutput", boolean_value(env, synchronized_output))) return NULL;
  return result;
}

static napi_value make_cursor(napi_env env, ProofTerminal *self) {
  uint16_t x = 0, y = 0;
  bool visible = true, blink = false;
  GhosttyRenderStateCursorVisualStyle visual = GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BLOCK;
  if (ghostty_terminal_get(self->terminal, GHOSTTY_TERMINAL_DATA_CURSOR_X, &x) != GHOSTTY_SUCCESS ||
      ghostty_terminal_get(self->terminal, GHOSTTY_TERMINAL_DATA_CURSOR_Y, &y) != GHOSTTY_SUCCESS ||
      ghostty_render_state_get(self->render, GHOSTTY_RENDER_STATE_DATA_CURSOR_VISIBLE, &visible) != GHOSTTY_SUCCESS ||
      ghostty_render_state_get(self->render, GHOSTTY_RENDER_STATE_DATA_CURSOR_BLINKING, &blink) != GHOSTTY_SUCCESS ||
      ghostty_render_state_get(self->render, GHOSTTY_RENDER_STATE_DATA_CURSOR_VISUAL_STYLE, &visual) != GHOSTTY_SUCCESS) {
    napi_throw_error(env, NULL, "could not read cursor state");
    return NULL;
  }
  const char *style = visual == GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BAR
    ? "bar"
    : (visual == GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_UNDERLINE ? "underline" : "block");
  napi_value result = object_value(env);
  if (result == NULL ||
      !set_named(env, result, "x", uint32_value(env, x)) ||
      !set_named(env, result, "y", uint32_value(env, y)) ||
      !set_named(env, result, "hidden", boolean_value(env, !visible)) ||
      !set_named(env, result, "style", string_value(env, style)) ||
      !set_named(env, result, "blink", boolean_value(env, blink))) return NULL;
  return result;
}

static napi_value terminal_new(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3] = {NULL, NULL, NULL};
  napi_value this_arg;
  if (!ok(env, napi_get_cb_info(env, info, &argc, args, &this_arg, NULL), "could not read constructor arguments")) return NULL;
  uint32_t cols = 80, rows = 24, scrollback = 5000;
  if ((argc > 0 && !strict_uint32(env, args[0], MAX_COLS, &cols, "columns must be a finite integer from 1 to 512")) ||
      (argc > 1 && !strict_uint32(env, args[1], MAX_ROWS, &rows, "rows must be a finite integer from 1 to 256")) ||
      (argc > 2 && !strict_uint32(env, args[2], MAX_SCROLLBACK, &scrollback, "scrollback must be a finite integer from 0 to 5000"))) return NULL;
  if (cols == 0 || rows == 0) {
    napi_throw_range_error(env, NULL, "terminal dimensions must be positive");
    return NULL;
  }
  EnvState *state = env_state(env);
  if (state == NULL) return NULL;
  if (state->test_failure == TEST_FAILURE_ALLOCATION) {
    state->test_failure = TEST_FAILURE_NONE;
    napi_throw_error(env, NULL, "injected native allocation failure");
    return NULL;
  }
  ProofTerminal *self = calloc(1, sizeof(ProofTerminal));
  if (self == NULL) {
    napi_throw_error(env, NULL, "out of memory creating terminal");
    return NULL;
  }
  self->scrollback_cap = scrollback;
  GhosttyTerminalOptions options = {
    .cols = (uint16_t)cols,
    .rows = (uint16_t)rows,
    .max_scrollback = scrollback,
  };
  if (ghostty_terminal_new(NULL, &self->terminal, options) != GHOSTTY_SUCCESS ||
      ghostty_render_state_new(NULL, &self->render) != GHOSTTY_SUCCESS ||
      ghostty_render_state_row_iterator_new(NULL, &self->rows) != GHOSTTY_SUCCESS ||
      ghostty_render_state_row_cells_new(NULL, &self->cells) != GHOSTTY_SUCCESS) {
    dispose_terminal(self);
    free(self);
    napi_throw_error(env, NULL, "could not initialize libghostty-vt terminal");
    return NULL;
  }
  link_terminal(state, self);
  if (state->test_failure == TEST_FAILURE_WRAP) {
    state->test_failure = TEST_FAILURE_NONE;
    dispose_terminal(self);
    free(self);
    napi_throw_error(env, NULL, "injected native wrap failure");
    return NULL;
  }
  if (!ok(env, napi_wrap(env, this_arg, self, finalize_terminal, NULL, NULL), "could not wrap terminal")) {
    dispose_terminal(self);
    free(self);
    return NULL;
  }
  return this_arg;
}

static napi_value terminal_write(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1] = {NULL};
  ProofTerminal *self = unwrap_terminal(env, info, &argc, args);
  if (self == NULL) return NULL;
  if (argc != 1) {
    napi_throw_type_error(env, NULL, "write expects one Uint8Array or Buffer");
    return NULL;
  }
  bool is_buffer = false;
  if (!ok(env, napi_is_buffer(env, args[0], &is_buffer), "could not inspect write buffer")) return NULL;
  void *data = NULL;
  size_t length = 0;
  if (is_buffer) {
    if (!ok(env, napi_get_buffer_info(env, args[0], &data, &length), "could not read Buffer")) return NULL;
  } else {
    bool is_typed_array = false;
    if (!ok(env, napi_is_typedarray(env, args[0], &is_typed_array), "could not inspect typed array")) return NULL;
    napi_typedarray_type type;
    size_t count;
    napi_value arraybuffer;
    size_t offset;
    if (!is_typed_array ||
        !ok(env, napi_get_typedarray_info(env, args[0], &type, &count, &data, &arraybuffer, &offset), "could not read Uint8Array") ||
        type != napi_uint8_array) {
      napi_throw_type_error(env, NULL, "write expects one Uint8Array or Buffer");
      return NULL;
    }
    length = count;
  }
  if (length > MAX_WRITE_BYTES) {
    napi_throw_range_error(env, NULL, "write payload exceeds 16 MiB");
    return NULL;
  }
  if (self->owner != NULL && self->owner->test_failure == TEST_FAILURE_WRITE) {
    self->owner->test_failure = TEST_FAILURE_NONE;
    napi_throw_error(env, NULL, "injected native write failure");
    return NULL;
  }
  ghostty_terminal_vt_write(self->terminal, data, length);
  return undefined_value(env);
}

static napi_value terminal_resize(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2] = {NULL, NULL};
  ProofTerminal *self = unwrap_terminal(env, info, &argc, args);
  if (self == NULL) return NULL;
  uint32_t cols = 0, rows = 0;
  if (argc != 2 ||
      !strict_uint32(env, args[0], MAX_COLS, &cols, "columns must be a finite integer from 1 to 512") ||
      !strict_uint32(env, args[1], MAX_ROWS, &rows, "rows must be a finite integer from 1 to 256")) return NULL;
  if (cols == 0 || rows == 0 ||
      ghostty_terminal_resize(self->terminal, (uint16_t)cols, (uint16_t)rows, 1, 1) != GHOSTTY_SUCCESS) {
    napi_throw_range_error(env, NULL, "invalid terminal dimensions");
    return NULL;
  }
  self->seeded = false;
  return undefined_value(env);
}

static napi_value terminal_set_authoritative_cursor(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2] = {NULL, NULL};
  ProofTerminal *self = unwrap_terminal(env, info, &argc, args);
  if (self == NULL) return NULL;
  uint32_t x = 0, y = 0;
  if (argc != 2 ||
      !strict_uint32(env, args[0], MAX_COLS - 1, &x, "cursor x must be a finite non-negative integer") ||
      !strict_uint32(env, args[1], MAX_ROWS - 1, &y, "cursor y must be a finite non-negative integer")) return NULL;
  uint16_t cols = 0, rows = 0;
  if (ghostty_terminal_get(self->terminal, GHOSTTY_TERMINAL_DATA_COLS, &cols) != GHOSTTY_SUCCESS ||
      ghostty_terminal_get(self->terminal, GHOSTTY_TERMINAL_DATA_ROWS, &rows) != GHOSTTY_SUCCESS) {
    napi_throw_error(env, NULL, "could not read terminal dimensions");
    return NULL;
  }
  if (x >= cols || y >= rows ||
      ghostty_terminal_cursor_set_absolute(self->terminal, (uint16_t)x, (uint16_t)y) != GHOSTTY_SUCCESS) {
    napi_throw_range_error(env, NULL, "authoritative cursor coordinates are outside the viewport");
    return NULL;
  }
  return undefined_value(env);
}

static napi_value terminal_snapshot(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1] = {NULL};
  ProofTerminal *self = unwrap_terminal(env, info, &argc, args);
  if (self == NULL) return NULL;
  bool fail_before_commit = false;
  if (argc == 1) {
    napi_valuetype type;
    if (!ok(env, napi_typeof(env, args[0], &type), "could not inspect failure hook") || type != napi_boolean ||
        !ok(env, napi_get_value_bool(env, args[0], &fail_before_commit), "could not read failure hook")) {
      napi_throw_type_error(env, NULL, "project failure hook must be boolean");
      return NULL;
    }
  }
  if (ghostty_render_state_update(self->render, self->terminal) != GHOSTTY_SUCCESS) {
    napi_throw_error(env, NULL, "could not update render state");
    return NULL;
  }
  uint16_t cols = 0, rows = 0;
  size_t history_count = 0;
  GhosttyTerminalScreen screen = GHOSTTY_TERMINAL_SCREEN_PRIMARY;
  GhosttyRenderStateDirty dirty = GHOSTTY_RENDER_STATE_DIRTY_FALSE;
  uint64_t history_generation = 0, history_appended = 0, history_trimmed = 0;
  if (ghostty_terminal_get(self->terminal, GHOSTTY_TERMINAL_DATA_COLS, &cols) != GHOSTTY_SUCCESS ||
      ghostty_terminal_get(self->terminal, GHOSTTY_TERMINAL_DATA_ROWS, &rows) != GHOSTTY_SUCCESS ||
      ghostty_terminal_get(self->terminal, GHOSTTY_TERMINAL_DATA_SCROLLBACK_ROWS, &history_count) != GHOSTTY_SUCCESS ||
      ghostty_terminal_get(self->terminal, GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN, &screen) != GHOSTTY_SUCCESS ||
      ghostty_terminal_get(self->terminal, GHOSTTY_TERMINAL_DATA_HISTORY_GENERATION, &history_generation) != GHOSTTY_SUCCESS ||
      ghostty_terminal_get(self->terminal, GHOSTTY_TERMINAL_DATA_HISTORY_ROWS_APPENDED, &history_appended) != GHOSTTY_SUCCESS ||
      ghostty_terminal_get(self->terminal, GHOSTTY_TERMINAL_DATA_HISTORY_ROWS_TRIMMED, &history_trimmed) != GHOSTTY_SUCCESS ||
      ghostty_render_state_get(self->render, GHOSTTY_RENDER_STATE_DATA_DIRTY, &dirty) != GHOSTTY_SUCCESS) {
    napi_throw_error(env, NULL, "could not read projection metadata");
    return NULL;
  }
  bool seed = !self->seeded || cols != self->projected_cols || rows != self->projected_rows ||
              screen != self->projected_screen || history_generation < self->history_generation ||
              history_appended < self->history_appended || history_trimmed < self->history_trimmed;
  size_t visible_history_count = history_count > self->scrollback_cap ? self->scrollback_cap : history_count;
  uint64_t appended_delta = seed ? visible_history_count : history_appended - self->history_appended;
  size_t append_count = appended_delta > visible_history_count ? visible_history_count : (size_t)appended_delta;
  uint64_t trimmed_delta = seed ? 0 : self->projected_history_count + append_count - visible_history_count;
  size_t append_start = history_count - append_count;
  uint32_t grid_rows_read = 0;
  napi_value viewport_rows = make_viewport_rows(env, self, !seed, &grid_rows_read);
  napi_value history = viewport_rows == NULL ? NULL : make_history_rows(env, self, append_start, append_count, cols);
  napi_value result = history == NULL ? NULL : object_value(env);
  napi_value stats = result == NULL ? NULL : object_value(env);
  if (stats == NULL ||
      !set_named(env, stats, "fullWalks", uint32_value(env, seed ? 1 : 0)) ||
      !set_named(env, stats, "gridRowsRead", uint32_value(env, grid_rows_read)) ||
      !set_named(env, stats, "historyRowsRead", uint64_value(env, append_count)) ||
      !set_named(env, stats, "cellsRead", uint64_value(env, ((uint64_t)grid_rows_read + append_count) * cols)))
    return NULL;
  if (result == NULL ||
      !set_named(env, result, "kind", string_value(env, seed ? "seed" : "delta")) ||
      !set_named(env, result, "cols", uint32_value(env, cols)) ||
      !set_named(env, result, "rows", uint32_value(env, rows)) ||
      !set_named(env, result, "activeScreen", string_value(env, screen == GHOSTTY_TERMINAL_SCREEN_ALTERNATE ? "alternate" : "primary")) ||
      !set_named(env, result, "cursor", make_cursor(env, self)) ||
      !set_named(env, result, "modes", make_modes(env, self, screen)) ||
      !set_named(env, result, "dirtyKind", string_value(env, dirty == GHOSTTY_RENDER_STATE_DIRTY_FULL ? "full" : (dirty == GHOSTTY_RENDER_STATE_DIRTY_PARTIAL ? "partial" : "clean"))) ||
      !set_named(env, result, "viewportRows", viewport_rows) ||
      !set_named(env, result, "historyTrim", uint64_value(env, trimmed_delta)) ||
      !set_named(env, result, "historyAppend", history) ||
      !set_named(env, result, "stats", stats)) return NULL;
  if (fail_before_commit) {
    napi_throw_error(env, NULL, "injected projection failure before dirty commit");
    return NULL;
  }
  if (self->owner != NULL && self->owner->test_failure == TEST_FAILURE_DIRTY_ACK) {
    self->owner->test_failure = TEST_FAILURE_NONE;
    napi_throw_error(env, NULL, "injected atomic dirty acknowledgement failure");
    return NULL;
  }
  if (!clear_render_dirty(self)) {
    napi_throw_error(env, NULL, "could not commit projection dirty state");
    return NULL;
  }
  self->seeded = true;
  self->projected_cols = cols;
  self->projected_rows = rows;
  self->projected_screen = screen;
  self->history_generation = history_generation;
  self->history_appended = history_appended;
  self->history_trimmed = history_trimmed;
  self->projected_history_count = visible_history_count;
  return result;
}

static napi_value terminal_dispose(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  napi_value this_arg;
  void *data = NULL;
  if (!ok(env, napi_get_cb_info(env, info, &argc, NULL, &this_arg, NULL), "could not read receiver") ||
      !ok(env, napi_unwrap(env, this_arg, &data), "invalid terminal receiver")) return NULL;
  dispose_terminal(data);
  return undefined_value(env);
}

static napi_value live_handle_count(napi_env env, napi_callback_info info) {
  (void)info;
  EnvState *state = env_state(env);
  return state == NULL ? NULL : uint32_value(env, state->live_handles);
}

static napi_value set_test_failure(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1] = {NULL};
  if (!ok(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL), "could not read failure mode") || argc != 1) {
    napi_throw_type_error(env, NULL, "test failure mode is required");
    return NULL;
  }
  napi_valuetype type;
  if (!ok(env, napi_typeof(env, args[0], &type), "could not inspect failure mode") || type != napi_string) {
    napi_throw_type_error(env, NULL, "test failure mode must be a string");
    return NULL;
  }
  char mode[32];
  size_t length = 0;
  if (!ok(env, napi_get_value_string_utf8(env, args[0], mode, sizeof(mode), &length), "could not read failure mode"))
    return NULL;
  uint32_t value = TEST_FAILURE_NONE;
  if (strcmp(mode, "allocation") == 0) value = TEST_FAILURE_ALLOCATION;
  else if (strcmp(mode, "wrap") == 0) value = TEST_FAILURE_WRAP;
  else if (strcmp(mode, "dirtyAck") == 0) value = TEST_FAILURE_DIRTY_ACK;
  else if (strcmp(mode, "write") == 0) value = TEST_FAILURE_WRITE;
  else if (strcmp(mode, "none") != 0) {
    napi_throw_range_error(env, NULL, "unknown test failure mode");
    return NULL;
  }
  EnvState *state = env_state(env);
  if (state == NULL) return NULL;
  state->test_failure = value;
  return undefined_value(env);
}

static void cleanup_env(void *data) {
  EnvState *state = data;
  if (state == NULL) return;
  state->cleanup_hook_ran = true;
  if (!state->cleaning_up) {
    state->cleaning_up = true;
    while (state->terminals != NULL) {
      ProofTerminal *self = state->terminals;
      unlink_terminal(self);
      dispose_terminal(self);
    }
    state->live_handles = 0;
  }
  if (state->instance_finalizer_ran) free(state);
}

static void finalize_env(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  EnvState *state = data;
  if (state == NULL) return;
  state->instance_finalizer_ran = true;
  if (!state->cleaning_up) {
    state->cleaning_up = true;
    while (state->terminals != NULL) {
      ProofTerminal *self = state->terminals;
      unlink_terminal(self);
      dispose_terminal(self);
    }
    state->live_handles = 0;
  }
  if (!state->cleanup_hook_registered || state->cleanup_hook_ran) free(state);
}

static napi_value initialize(napi_env env, napi_value exports) {
  EnvState *state = calloc(1, sizeof(EnvState));
  if (state == NULL) {
    napi_throw_error(env, NULL, "out of memory creating native environment");
    return NULL;
  }
  if (!ok(env, napi_set_instance_data(env, state, finalize_env, NULL), "could not initialize native environment")) {
    free(state);
    return NULL;
  }
  if (!ok(env, napi_add_env_cleanup_hook(env, cleanup_env, state), "could not register native environment cleanup")) {
    return NULL;
  }
  state->cleanup_hook_registered = true;
  napi_property_descriptor methods[] = {
    {"write", NULL, terminal_write, NULL, NULL, NULL, napi_default, NULL},
    {"resize", NULL, terminal_resize, NULL, NULL, NULL, napi_default, NULL},
    {"setAuthoritativeCursor", NULL, terminal_set_authoritative_cursor, NULL, NULL, NULL, napi_default, NULL},
    {"project", NULL, terminal_snapshot, NULL, NULL, NULL, napi_default, NULL},
    {"snapshot", NULL, terminal_snapshot, NULL, NULL, NULL, napi_default, NULL},
    {"dispose", NULL, terminal_dispose, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_value constructor;
  if (!ok(env, napi_define_class(env, "GhosttyVtProofTerminal", NAPI_AUTO_LENGTH, terminal_new, NULL,
                                  sizeof(methods) / sizeof(methods[0]), methods, &constructor),
          "could not define terminal class") ||
      !set_named(env, exports, "GhosttyVtProofTerminal", constructor)) return NULL;
  napi_property_descriptor live = {"liveHandles", NULL, live_handle_count, NULL, NULL, NULL, napi_default, NULL};
  napi_property_descriptor failure = {"setTestFailure", NULL, set_test_failure, NULL, NULL, NULL, napi_default, NULL};
  if (!ok(env, napi_define_properties(env, exports, 1, &live), "could not define live handle counter") ||
      !ok(env, napi_define_properties(env, exports, 1, &failure), "could not define failure injector")) return NULL;
  if (!set_named(env, exports, "abiIdentity", string_value(env, "ghostty-vt-48ccec182a93+tmuxide.cursor-history-dirty.v3+napi9"))) return NULL;
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
