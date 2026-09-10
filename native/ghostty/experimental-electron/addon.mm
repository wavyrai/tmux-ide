// Isolated Electron/main-process experiment. Not an application integration.
// Native selection, precise wheel/momentum, basic keyboard input. NSTextInputClient
// composition/IME, accessibility, clipboard reads, link policy and app actions remain
// deliberately unsupported. The host must stop the session if inputFailed is true.
#import <AppKit/AppKit.h>
#include <node_api.h>
#include <ghostty.h>
#include <atomic>
#include <cmath>
#include <cstring>
#include <memory>
#include <vector>
#include <unordered_set>

extern "C" ghostty_surface_t tmux_ide_ghostty_surface_new_external(
    ghostty_app_t, const ghostty_surface_config_s*, void*,
    void (*)(void*, const uint8_t*, size_t));
extern "C" void tmux_ide_ghostty_surface_feed_output(ghostty_surface_t, const uint8_t*, size_t);

struct Host;
@interface TmiGhosttyView : NSView
@property(nonatomic, assign) Host* host;
@end

struct Host : std::enable_shared_from_this<Host> {
  ghostty_app_t app = nullptr;
  ghostty_surface_t surface = nullptr;
  ghostty_config_t config = nullptr;
  __strong TmiGhosttyView* view = nil;
  napi_threadsafe_function input = nullptr;
  std::atomic<bool> disposed{false}, inputFailed{false}, tickPending{false};
  std::atomic<uint64_t> inputBytes{0}, rejectedBytes{0}, callbacks{0}, wakeups{0};
  uint64_t fedBytes = 0, feedCalls = 0, scrollEvents = 0;
};
struct Packet { std::vector<uint8_t> bytes; };
using HostHandle = std::shared_ptr<Host>;
static std::unordered_set<void*> handles;

static ghostty_input_mods_e mods(NSEvent* e) {
  auto f = e.modifierFlags;
  return static_cast<ghostty_input_mods_e>(
    ((f & NSEventModifierFlagShift) ? GHOSTTY_MODS_SHIFT : 0) |
    ((f & NSEventModifierFlagControl) ? GHOSTTY_MODS_CTRL : 0) |
    ((f & NSEventModifierFlagOption) ? GHOSTTY_MODS_ALT : 0) |
    ((f & NSEventModifierFlagCommand) ? GHOSTTY_MODS_SUPER : 0) |
    ((f & NSEventModifierFlagCapsLock) ? GHOSTTY_MODS_CAPS : 0));
}

@implementation TmiGhosttyView
- (BOOL)isFlipped { return YES; }
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)becomeFirstResponder {
  if (_host && _host->surface) ghostty_surface_set_focus(_host->surface, true);
  return YES;
}
- (BOOL)resignFirstResponder {
  if (_host && _host->surface) ghostty_surface_set_focus(_host->surface, false);
  return YES;
}
- (void)keyDown:(NSEvent*)e {
  if (!_host || !_host->surface) return;
  ghostty_input_key_s key{};
  key.action = e.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS;
  key.mods = mods(e);
  key.keycode = e.keyCode;
  NSString* chars = e.characters ?: @"";
  // AppKit function-key codepoints are not printable terminal text.
  if (chars.length && [chars characterAtIndex:0] < 0xF700 &&
      !(e.modifierFlags & (NSEventModifierFlagControl | NSEventModifierFlagCommand)))
    key.text = chars.UTF8String;
  NSString* plain = e.charactersIgnoringModifiers;
  key.unshifted_codepoint = plain.length ? [plain characterAtIndex:0] : 0;
  ghostty_surface_key(_host->surface, key);
}
- (void)keyUp:(NSEvent*)e {
  if (!_host || !_host->surface) return;
  ghostty_input_key_s key{};
  key.action = GHOSTTY_ACTION_RELEASE; key.mods = mods(e); key.keycode = e.keyCode;
  ghostty_surface_key(_host->surface, key);
}
- (void)mouseMoved:(NSEvent*)e {
  if (!_host || !_host->surface) return;
  NSPoint p = [self convertPoint:e.locationInWindow fromView:nil];
  ghostty_surface_mouse_pos(_host->surface, p.x, p.y, mods(e));
}
- (void)mouseDragged:(NSEvent*)e { [self mouseMoved:e]; }
- (void)mouseDown:(NSEvent*)e {
  [self.window makeFirstResponder:self]; [self mouseMoved:e];
  if (_host && _host->surface)
    ghostty_surface_mouse_button(_host->surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_LEFT, mods(e));
}
- (void)mouseUp:(NSEvent*)e {
  [self mouseMoved:e];
  if (_host && _host->surface)
    ghostty_surface_mouse_button(_host->surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_LEFT, mods(e));
}
- (void)scrollWheel:(NSEvent*)e {
  if (!_host || !_host->surface) return;
  int momentum = GHOSTTY_MOUSE_MOMENTUM_NONE;
  if (e.momentumPhase & NSEventPhaseBegan) momentum = GHOSTTY_MOUSE_MOMENTUM_BEGAN;
  else if (e.momentumPhase & NSEventPhaseChanged) momentum = GHOSTTY_MOUSE_MOMENTUM_CHANGED;
  else if (e.momentumPhase & NSEventPhaseEnded) momentum = GHOSTTY_MOUSE_MOMENTUM_ENDED;
  else if (e.momentumPhase & NSEventPhaseCancelled) momentum = GHOSTTY_MOUSE_MOMENTUM_CANCELLED;
  else if (e.momentumPhase & NSEventPhaseStationary) momentum = GHOSTTY_MOUSE_MOMENTUM_STATIONARY;
  else if (e.momentumPhase & NSEventPhaseMayBegin) momentum = GHOSTTY_MOUSE_MOMENTUM_MAY_BEGIN;
  // Match Ghostty's AppKit precise-wheel multiplier and momentum bit packing.
  double scale = e.hasPreciseScrollingDeltas ? 2 : 1;
  ghostty_surface_mouse_scroll(_host->surface, e.scrollingDeltaX * scale,
      e.scrollingDeltaY * scale, (e.hasPreciseScrollingDeltas ? 1 : 0) | (momentum << 1));
  _host->scrollEvents++;
}
@end

static void shutdown(const HostHandle& h) {
  if (h->disposed.exchange(true)) return;
  h->view.host = nullptr;
  [h->view removeFromSuperview];
  // free joins Ghostty's IO thread before the callback userdata may disappear.
  if (h->surface) { ghostty_surface_free(h->surface); h->surface = nullptr; }
  if (h->app) { ghostty_app_free(h->app); h->app = nullptr; }
  if (h->config) { ghostty_config_free(h->config); h->config = nullptr; }
  h->view = nil;
  if (h->input) { napi_release_threadsafe_function(h->input, napi_tsfn_abort); h->input = nullptr; }
}
static void wakeup(void* data) {
  auto h = static_cast<Host*>(data)->shared_from_this();
  if (h->disposed || h->tickPending.exchange(true)) return;
  dispatch_async(dispatch_get_main_queue(), ^{
    h->tickPending = false;
    if (!h->disposed && h->app) { h->wakeups++; ghostty_app_tick(h->app); }
  });
}
static bool action(ghostty_app_t, ghostty_target_s target, ghostty_action_s value) {
  if (value.tag == GHOSTTY_ACTION_RENDER && target.tag == GHOSTTY_TARGET_SURFACE) {
    ghostty_surface_draw(target.target.surface); return true;
  }
  return false;
}
static ghostty_clipboard_read_result_e readClipboard(void*, ghostty_clipboard_e, void*,
    const char* const*, size_t, bool) { return GHOSTTY_CLIPBOARD_READ_UNSUPPORTED; }
static void confirmClipboard(void*, const ghostty_clipboard_confirm_s*, void*, ghostty_clipboard_request_e) {}
static void writeClipboard(void*, ghostty_clipboard_e, const ghostty_clipboard_content_s*, size_t, bool) {}
static void closeSurface(void*, bool) {}
static void writeInput(void* data, const uint8_t* bytes, size_t size) {
  auto* h = static_cast<Host*>(data);
  if (h->disposed || size == 0) return;
  // Nonblocking bounded queue. Fail closed on overflow: never silently continue
  // a terminal stream after losing input; metrics expose the fatal condition.
  if (size > 65536 || h->inputFailed) { h->inputFailed = true; h->rejectedBytes += size; return; }
  auto* p = new Packet{{bytes, bytes + size}};
  if (napi_call_threadsafe_function(h->input, p, napi_tsfn_nonblocking) != napi_ok) {
    delete p; h->inputFailed = true; h->rejectedBytes += size;
  } else h->inputBytes += size;
}
static void deliver(napi_env env, napi_value cb, void* context, void* data) {
  std::unique_ptr<Packet> p(static_cast<Packet*>(data));
  auto h = *static_cast<HostHandle*>(context);
  if (!env || !cb || h->disposed || h->inputFailed) return;
  napi_value buffer, receiver, result;
  if (napi_create_buffer_copy(env, p->bytes.size(), p->bytes.data(), nullptr, &buffer) != napi_ok) {
    h->inputFailed = true; return;
  }
  napi_get_undefined(env, &receiver);
  if (napi_call_function(env, receiver, cb, 1, &buffer, &result) != napi_ok) h->inputFailed = true;
  h->callbacks++;
}
static void finalizeQueue(napi_env, void* data, void*) { delete static_cast<HostHandle*>(data); }
static void finalizeHostHandle(napi_env, void* data, void*) {
  handles.erase(data);
  std::unique_ptr<HostHandle> p(static_cast<HostHandle*>(data));
  auto h = *p;
  if ([NSThread isMainThread]) shutdown(h);
  else dispatch_async(dispatch_get_main_queue(), ^{ shutdown(h); });
}
static napi_value error(napi_env env, const char* text) { napi_throw_error(env, nullptr, text); return nullptr; }
static bool args(napi_env env, napi_callback_info info, size_t count, napi_value* out) {
  size_t actual = count;
  if (![NSThread isMainThread]) { error(env, "Ghostty addon requires Electron main thread"); return false; }
  if (napi_get_cb_info(env, info, &actual, out, nullptr, nullptr) != napi_ok || actual != count) {
    error(env, "Invalid argument count"); return false;
  }
  return true;
}
static HostHandle host(napi_env env, napi_value value) {
  void* p = nullptr;
  if (napi_get_value_external(env, value, &p) != napi_ok || !handles.count(p)) {
    error(env, "Invalid Ghostty handle"); return {};
  }
  return *static_cast<HostHandle*>(p);
}
static napi_value nothing(napi_env env) { napi_value v; napi_get_undefined(env, &v); return v; }
static napi_value create(napi_env env, napi_callback_info info) {
  napi_value argv[2]; if (!args(env, info, 2, argv)) return nullptr;
  void* buffer = nullptr; size_t size = 0; napi_valuetype type;
  if (napi_get_buffer_info(env, argv[0], &buffer, &size) != napi_ok || size != sizeof(void*) ||
      napi_typeof(env, argv[1], &type) != napi_ok || type != napi_function)
    return error(env, "Expected native NSView pointer Buffer and input callback");
  void* ptr; memcpy(&ptr, buffer, sizeof(ptr));
  if (!ptr) return error(env, "Null native NSView pointer");
  static bool initialized = false;
  if (!initialized) {
    char name[] = "tmux-ide-ghostty-experiment"; char* av[] = {name, nullptr};
    if (ghostty_init(1, av) != 0) return error(env, "ghostty_init failed");
    initialized = true;
  }
  auto h = std::make_shared<Host>();
  napi_value label; napi_create_string_utf8(env, "GhosttyInput", NAPI_AUTO_LENGTH, &label);
  auto* queueOwner = new HostHandle(h);
  if (napi_create_threadsafe_function(env, argv[1], nullptr, label, 128, 1,
      queueOwner, finalizeQueue, queueOwner, deliver, &h->input) != napi_ok) {
    delete queueOwner; return error(env, "Cannot create bounded input queue");
  }
  napi_unref_threadsafe_function(env, h->input);
  h->config = ghostty_config_new();
  // Only this experiment's zero-padding config; do not load user config.
  NSString* configPath = [NSTemporaryDirectory() stringByAppendingPathComponent:
      [@"tmi-ghostty-" stringByAppendingString:NSUUID.UUID.UUIDString]];
  [@"window-padding-x = 0\nwindow-padding-y = 0\n" writeToFile:configPath
      atomically:YES encoding:NSUTF8StringEncoding error:nil];
  ghostty_config_load_file(h->config, configPath.fileSystemRepresentation);
  [[NSFileManager defaultManager] removeItemAtPath:configPath error:nil];
  ghostty_config_finalize(h->config);
  ghostty_runtime_config_s runtime{};
  runtime.userdata = h.get(); runtime.wakeup_cb = wakeup; runtime.action_cb = action;
  runtime.read_clipboard_cb = readClipboard; runtime.confirm_read_clipboard_cb = confirmClipboard;
  runtime.write_clipboard_cb = writeClipboard; runtime.close_surface_cb = closeSurface;
  h->app = ghostty_app_new(&runtime, h->config);
  if (!h->app) { shutdown(h); return error(env, "ghostty_app_new failed"); }
  NSView* parent = (__bridge NSView*)ptr;
  h->view = [[TmiGhosttyView alloc] initWithFrame:parent.bounds];
  h->view.host = h.get();
  [parent addSubview:h->view positioned:NSWindowAbove relativeTo:nil];
  auto config = ghostty_surface_config_new();
  config.platform_tag = GHOSTTY_PLATFORM_MACOS;
  config.platform.macos.nsview = (__bridge void*)h->view;
  config.userdata = h.get(); config.scale_factor = parent.window.backingScaleFactor ?: 1;
  h->surface = tmux_ide_ghostty_surface_new_external(h->app, &config, h.get(), writeInput);
  if (!h->surface) { shutdown(h); return error(env, "External Ghostty surface failed"); }
  ghostty_app_set_focus(h->app, true);
  [parent.window makeFirstResponder:h->view];
  napi_value result;
  auto* external = new HostHandle(h);
  handles.insert(external);
  napi_create_external(env, external, finalizeHostHandle, nullptr, &result);
  return result;
}
static napi_value feed(napi_env env, napi_callback_info info) {
  napi_value argv[2]; if (!args(env, info, 2, argv)) return nullptr;
  auto h = host(env, argv[0]); if (!h) return nullptr;
  void* p = nullptr; size_t n = 0;
  if (napi_get_buffer_info(env, argv[1], &p, &n) != napi_ok || n > 1048576)
    return error(env, "feed expects Buffer <= 1 MiB; split larger output");
  if (h->disposed || h->inputFailed) return error(env, "Ghostty surface disposed or input queue failed");
  tmux_ide_ghostty_surface_feed_output(h->surface, static_cast<uint8_t*>(p), n);
  h->fedBytes += n; h->feedCalls++;
  return nothing(env);
}
static napi_value resize(napi_env env, napi_callback_info info) {
  napi_value argv[5]; if (!args(env, info, 5, argv)) return nullptr;
  auto h = host(env, argv[0]); if (!h) return nullptr;
  double d[4];
  for (int i=0; i<4; i++) if (napi_get_value_double(env, argv[i+1], &d[i]) != napi_ok ||
      !std::isfinite(d[i]) || std::abs(d[i]) > 32768) return error(env, "Invalid geometry");
  if (h->disposed) return error(env, "Disposed Ghostty surface");
  if (d[2] < 1 || d[3] < 1) return error(env, "Positive dimensions required");
  // Public geometry is top-left CSS points, independent of parent view orientation.
  NSView* parent = h->view.superview;
  double y = parent.isFlipped ? d[1] : parent.bounds.size.height - d[1] - d[3];
  h->view.frame = NSMakeRect(d[0], y, d[2], d[3]);
  double scale = h->view.window.backingScaleFactor ?: 1;
  ghostty_surface_set_content_scale(h->surface, scale, scale);
  ghostty_surface_set_size(h->surface, std::lround(d[2]*scale), std::lround(d[3]*scale));
  ghostty_surface_refresh(h->surface);
  return nothing(env);
}
static napi_value dispose(napi_env env, napi_callback_info info) {
  napi_value argv[1]; if (!args(env, info, 1, argv)) return nullptr;
  auto h = host(env, argv[0]); if (!h) return nullptr;
  shutdown(h); return nothing(env);
}
static napi_value visibility(napi_env env, napi_callback_info info) {
  napi_value argv[2]; if (!args(env, info, 2, argv)) return nullptr;
  auto h = host(env, argv[0]); if (!h) return nullptr;
  bool visible;
  if (napi_get_value_bool(env, argv[1], &visible) != napi_ok) return error(env, "Expected visibility boolean");
  if (h->disposed) return error(env, "Disposed Ghostty surface");
  h->view.hidden = !visible; ghostty_surface_set_occlusion(h->surface, visible);
  return nothing(env);
}
static napi_value metrics(napi_env env, napi_callback_info info) {
  napi_value argv[1]; if (!args(env, info, 1, argv)) return nullptr;
  auto h = host(env, argv[0]); if (!h) return nullptr;
  napi_value result; napi_create_object(env, &result);
  auto number = [&](const char* key, uint64_t v) { napi_value n; napi_create_double(env, v, &n); napi_set_named_property(env,result,key,n); };
  auto boolean = [&](const char* key, bool v) { napi_value n; napi_get_boolean(env,v,&n); napi_set_named_property(env,result,key,n); };
  number("fedBytes",h->fedBytes); number("feedCalls",h->feedCalls); number("inputBytes",h->inputBytes);
  number("rejectedBytes",h->rejectedBytes); number("callbacks",h->callbacks); number("wakeups",h->wakeups);
  number("scrollEvents",h->scrollEvents); boolean("disposed",h->disposed); boolean("inputFailed",h->inputFailed);
  if (h->surface) { auto s=ghostty_surface_size(h->surface); number("columns",s.columns); number("rows",s.rows); number("cellWidthPx",s.cell_width_px); number("cellHeightPx",s.cell_height_px); number("foregroundPid",ghostty_surface_foreground_pid(h->surface));
    napi_value scale; napi_create_double(env,h->view.window.backingScaleFactor ?: 1,&scale); napi_set_named_property(env,result,"scale",scale); }
  return result;
}
// Diagnostic entry into the same native scroll API used by AppKit above.
// This proves native scrollback behavior, not trackpad gesture delivery/latency.
static napi_value scroll(napi_env env, napi_callback_info info) {
  napi_value argv[2]; if (!args(env, info, 2, argv)) return nullptr;
  auto h = host(env, argv[0]); if (!h) return nullptr;
  double delta;
  if (napi_get_value_double(env, argv[1], &delta) != napi_ok || !std::isfinite(delta) || std::abs(delta) > 32768)
    return error(env, "Expected bounded vertical wheel delta");
  if (h->disposed) return error(env, "Disposed Ghostty surface");
  ghostty_surface_mouse_scroll(h->surface, 0, delta * 2, 1);
  h->scrollEvents++;
  return nothing(env);
}
static napi_value readText(napi_env env, napi_callback_info info) {
  napi_value argv[1]; if (!args(env, info, 1, argv)) return nullptr;
  auto h = host(env, argv[0]); if (!h) return nullptr;
  if (h->disposed) return error(env, "Disposed Ghostty surface");
  ghostty_selection_s selection{};
  selection.top_left = {GHOSTTY_POINT_VIEWPORT, GHOSTTY_POINT_COORD_TOP_LEFT, 0, 0};
  selection.bottom_right = {GHOSTTY_POINT_VIEWPORT, GHOSTTY_POINT_COORD_BOTTOM_RIGHT, 0, 0};
  ghostty_text_s text{};
  if (!ghostty_surface_read_text(h->surface, selection, &text)) return error(env, "Ghostty text read failed");
  napi_value result;
  napi_create_string_utf8(env, text.text, text.text_len, &result);
  ghostty_surface_free_text(h->surface, &text);
  return result;
}
static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    {"create",0,create,0,0,0,napi_default,0}, {"feed",0,feed,0,0,0,napi_default,0},
    {"resize",0,resize,0,0,0,napi_default,0}, {"dispose",0,dispose,0,0,0,napi_default,0},
    {"scroll",0,scroll,0,0,0,napi_default,0}, {"readText",0,readText,0,0,0,napi_default,0}, {"metrics",0,metrics,0,0,0,napi_default,0}, {"visibility",0,visibility,0,0,0,napi_default,0}};
  napi_define_properties(env,exports,sizeof(props)/sizeof(props[0]),props); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
